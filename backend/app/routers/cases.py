import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status

_MISSING = object()
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import Case, CaseReferenceCounter, MatterHeadType, MatterSubType, MatterSubTypeMenu, MatterSubTypeStandardTask, User
from app.schemas import CaseCreate, CaseOut, CaseUpdate, MatterSubTypeStandardTaskOut
from app.audit import log_event


router = APIRouter(prefix="/cases", tags=["cases"])


def _matter_names(
    matter_sub_type_id: uuid.UUID | None,
    matter_head_type_id: uuid.UUID | None,
    db: Session,
) -> tuple[str | None, str | None]:
    """Return (sub_type_name, head_type_name). Sub-type wins for head name when both are set."""
    if matter_sub_type_id:
        sub = db.get(MatterSubType, matter_sub_type_id)
        if not sub:
            return None, None
        head = db.get(MatterHeadType, sub.head_type_id)
        return sub.name, (head.name if head else None)
    if matter_head_type_id:
        head = db.get(MatterHeadType, matter_head_type_id)
        return None, (head.name if head else None)
    return None, None


def _case_dict(
    case: Case,
    sub_name: str | None,
    head_name: str | None,
    matter_menus: list[dict] | None = None,
) -> dict:
    return {
        "id": case.id,
        "case_number": case.case_number,
        "client_name": case.client_name,
        "matter_description": case.title,
        "fee_earner_user_id": case.fee_earner_user_id,
        "status": case.status,
        "practice_area": case.practice_area,
        "matter_sub_type_id": case.matter_sub_type_id,
        "matter_head_type_id": case.matter_head_type_id,
        "matter_sub_type_name": sub_name,
        "matter_head_type_name": head_name,
        "matter_menus": matter_menus or [],
        "created_by": case.created_by,
        "is_locked": case.is_locked,
        "lock_mode": case.lock_mode,
        "created_at": case.created_at,
        "updated_at": case.updated_at,
    }


def _menus_for_sub_types(sub_ids: set[uuid.UUID], db: Session) -> dict[uuid.UUID, list[dict]]:
    if not sub_ids:
        return {}
    rows = (
        db.execute(
            select(MatterSubTypeMenu)
            .where(MatterSubTypeMenu.sub_type_id.in_(sub_ids))
            .order_by(MatterSubTypeMenu.sub_type_id, MatterSubTypeMenu.created_at)
        )
        .scalars()
        .all()
    )
    out: dict[uuid.UUID, list[dict]] = {}
    for m in rows:
        out.setdefault(m.sub_type_id, []).append({"id": m.id, "name": m.name})
    return out


@router.post("", response_model=CaseOut, status_code=status.HTTP_201_CREATED)
def create_case(
    payload: CaseCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseOut:
    # Generate 6-digit immutable reference (case_number) using a DB counter row.
    counter = db.get(CaseReferenceCounter, 1)
    if not counter:
        counter = CaseReferenceCounter(id=1, next_value=1)
        db.add(counter)
        db.commit()
        db.refresh(counter)

    # Lock the counter row for update to prevent duplicate refs.
    counter = db.execute(select(CaseReferenceCounter).where(CaseReferenceCounter.id == 1).with_for_update()).scalar_one()
    ref_num = counter.next_value
    counter.next_value = ref_num + 1
    case_number = f"{ref_num:06d}"

    sub = db.get(MatterSubType, payload.matter_sub_type_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter sub-type not found")
    resolved_sub = sub.id
    resolved_head = sub.head_type_id

    case = Case(
        case_number=case_number,
        client_name=None,
        title=payload.matter_description,
        status=payload.status,
        practice_area=payload.practice_area,
        matter_sub_type_id=resolved_sub,
        matter_head_type_id=resolved_head,
        created_by=user.id,
        is_locked=False,
    )
    db.add(counter)
    db.add(case)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(case)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.create",
        entity_type="case",
        entity_id=str(case.id),
        meta={"case_number": case.case_number, "client_name": case.client_name, "matter_description": case.title},
    )
    sub_name, head_name = _matter_names(case.matter_sub_type_id, case.matter_head_type_id, db)
    menus = (
        _menus_for_sub_types({case.matter_sub_type_id}, db).get(case.matter_sub_type_id, [])
        if case.matter_sub_type_id
        else []
    )
    return CaseOut.model_validate(_case_dict(case, sub_name, head_name, menus))


@router.get("", response_model=list[CaseOut])
def list_cases(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[CaseOut]:
    cases = db.execute(select(Case).order_by(Case.created_at.desc())).scalars().all()

    # Bulk load sub/head type names to avoid N+1 queries.
    sub_ids = {c.matter_sub_type_id for c in cases if c.matter_sub_type_id}
    head_ids: set[uuid.UUID] = {c.matter_head_type_id for c in cases if c.matter_head_type_id}
    sub_map: dict[uuid.UUID, MatterSubType] = {}
    head_map: dict[uuid.UUID, MatterHeadType] = {}
    if sub_ids:
        subs = db.execute(select(MatterSubType).where(MatterSubType.id.in_(sub_ids))).scalars().all()
        sub_map = {s.id: s for s in subs}
        head_ids |= {s.head_type_id for s in subs}
    if head_ids:
        heads = db.execute(select(MatterHeadType).where(MatterHeadType.id.in_(head_ids))).scalars().all()
        head_map = {h.id: h for h in heads}

    menu_map = _menus_for_sub_types(sub_ids, db)
    result = []
    for c in cases:
        sub_name = None
        head_name = None
        if c.matter_sub_type_id and c.matter_sub_type_id in sub_map:
            sub = sub_map[c.matter_sub_type_id]
            sub_name = sub.name
            head = head_map.get(sub.head_type_id)
            head_name = head.name if head else None
        elif c.matter_head_type_id and c.matter_head_type_id in head_map:
            head_name = head_map[c.matter_head_type_id].name
        menus = menu_map.get(c.matter_sub_type_id, []) if c.matter_sub_type_id else []
        result.append(CaseOut.model_validate(_case_dict(c, sub_name, head_name, menus)))
    return result


@router.get("/{case_id}/standard-tasks", response_model=list[MatterSubTypeStandardTaskOut])
def list_standard_tasks_for_case(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MatterSubTypeStandardTaskOut]:
    case = require_case_access(case_id, user, db)
    global_rows = (
        db.execute(
            select(MatterSubTypeStandardTask).where(
                MatterSubTypeStandardTask.is_system.is_(True),
                MatterSubTypeStandardTask.matter_sub_type_id.is_(None),
            )
        )
        .scalars()
        .all()
    )
    if not case.matter_sub_type_id:
        merged = list(global_rows)
        merged.sort(key=lambda r: (r.sort_order, r.created_at))
        return [MatterSubTypeStandardTaskOut.model_validate(r, from_attributes=True) for r in merged]

    local_rows = (
        db.execute(
            select(MatterSubTypeStandardTask)
            .where(MatterSubTypeStandardTask.matter_sub_type_id == case.matter_sub_type_id)
            .where(MatterSubTypeStandardTask.is_system.is_(False))
            .order_by(MatterSubTypeStandardTask.sort_order, MatterSubTypeStandardTask.created_at)
        )
        .scalars()
        .all()
    )
    merged = list(global_rows) + list(local_rows)
    merged.sort(key=lambda r: (r.sort_order, r.created_at))
    return [MatterSubTypeStandardTaskOut.model_validate(r, from_attributes=True) for r in merged]


@router.get("/{case_id}", response_model=CaseOut)
def get_case(case_id: uuid.UUID, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> CaseOut:
    case = require_case_access(case_id, user, db)
    sub_name, head_name = _matter_names(case.matter_sub_type_id, case.matter_head_type_id, db)
    menus = (
        _menus_for_sub_types({case.matter_sub_type_id}, db).get(case.matter_sub_type_id, [])
        if case.matter_sub_type_id
        else []
    )
    return CaseOut.model_validate(_case_dict(case, sub_name, head_name, menus))


@router.patch("/{case_id}", response_model=CaseOut)
def update_case(
    case_id: uuid.UUID,
    payload: CaseUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseOut:
    case = require_case_access(case_id, user, db)

    data = payload.model_dump(exclude_unset=True)
    # Map API field to DB field
    if "matter_description" in data:
        data["title"] = data.pop("matter_description")

    ms = data.pop("matter_sub_type_id", _MISSING)
    mh = data.pop("matter_head_type_id", _MISSING)
    if ms is not _MISSING or mh is not _MISSING:
        if ms is not _MISSING and ms is not None:
            sub = db.get(MatterSubType, ms)
            if not sub:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter sub-type not found")
            case.matter_sub_type_id = sub.id
            case.matter_head_type_id = sub.head_type_id
        elif ms is not _MISSING and ms is None:
            case.matter_sub_type_id = None
            if mh is not _MISSING:
                if mh is not None:
                    if db.get(MatterHeadType, mh) is None:
                        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter head type not found")
                    case.matter_head_type_id = mh
                else:
                    case.matter_head_type_id = None
            else:
                case.matter_head_type_id = None
        elif mh is not _MISSING:
            if case.matter_sub_type_id is not None:
                pass
            else:
                if mh is not None and db.get(MatterHeadType, mh) is None:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter head type not found")
                case.matter_head_type_id = mh

    for key, value in data.items():
        setattr(case, key, value)
    case.updated_at = datetime.utcnow()

    db.add(case)
    db.commit()
    db.refresh(case)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.update",
        entity_type="case",
        entity_id=str(case.id),
        meta=payload.model_dump(exclude_unset=True),
    )
    sub_name, head_name = _matter_names(case.matter_sub_type_id, case.matter_head_type_id, db)
    menus = (
        _menus_for_sub_types({case.matter_sub_type_id}, db).get(case.matter_sub_type_id, [])
        if case.matter_sub_type_id
        else []
    )
    return CaseOut.model_validate(_case_dict(case, sub_name, head_name, menus))
