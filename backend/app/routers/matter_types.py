import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.db import get_db
from app.deps import get_current_user, require_admin
from app.models import MatterHeadType, MatterSubType, MatterSubTypeMenu, Precedent, PrecedentCategory, User
from app.schemas import (
    MatterHeadTypeCreate,
    MatterHeadTypeOut,
    MatterHeadTypeUpdate,
    MatterSubTypeCreate,
    MatterSubTypeMenuCreate,
    MatterSubTypeMenuOut,
    MatterSubTypeMenuUpdate,
    MatterSubTypeOut,
    MatterSubTypeUpdate,
    PrecedentCategoryCreate,
    PrecedentCategoryFlatOut,
    PrecedentCategoryOut,
    PrecedentCategoryUpdate,
)

router = APIRouter(prefix="/matter-types", tags=["matter-types"])


def _sub_out(sub: MatterSubType, db: Session) -> MatterSubTypeOut:
    menus = (
        db.execute(
            select(MatterSubTypeMenu)
            .where(MatterSubTypeMenu.sub_type_id == sub.id)
            .order_by(MatterSubTypeMenu.created_at)
        )
        .scalars()
        .all()
    )
    return MatterSubTypeOut(
        id=sub.id,
        name=sub.name,
        prefix=sub.prefix,
        menus=[MatterSubTypeMenuOut(id=m.id, name=m.name) for m in menus],
    )


def _head_out(head: MatterHeadType, db: Session) -> MatterHeadTypeOut:
    subs = (
        db.execute(
            select(MatterSubType)
            .where(MatterSubType.head_type_id == head.id)
            .order_by(MatterSubType.name)
        )
        .scalars()
        .all()
    )
    return MatterHeadTypeOut(
        id=head.id,
        name=head.name,
        sub_types=[_sub_out(s, db) for s in subs],
    )


# ── Public read (any authenticated user) ────────────────────────────────────

@router.get("", response_model=list[MatterHeadTypeOut])
def list_head_types(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MatterHeadTypeOut]:
    heads = db.execute(select(MatterHeadType).order_by(MatterHeadType.name)).scalars().all()
    return [_head_out(h, db) for h in heads]


# ── Admin: head type CRUD ────────────────────────────────────────────────────

@router.post("/heads", response_model=MatterHeadTypeOut, status_code=status.HTTP_201_CREATED)
def create_head_type(
    payload: MatterHeadTypeCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterHeadTypeOut:
    existing = db.execute(
        select(MatterHeadType).where(MatterHeadType.name == payload.name.strip())
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Head type name already exists")
    head = MatterHeadType(name=payload.name.strip(), created_at=datetime.utcnow(), updated_at=datetime.utcnow())
    db.add(head)
    db.commit()
    db.refresh(head)
    return _head_out(head, db)


@router.patch("/heads/{head_id}", response_model=MatterHeadTypeOut)
def rename_head_type(
    head_id: uuid.UUID,
    payload: MatterHeadTypeUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterHeadTypeOut:
    head = db.get(MatterHeadType, head_id)
    if not head:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Head type not found")
    conflict = db.execute(
        select(MatterHeadType)
        .where(MatterHeadType.name == payload.name.strip(), MatterHeadType.id != head_id)
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Head type name already exists")
    head.name = payload.name.strip()
    head.updated_at = datetime.utcnow()
    db.add(head)
    db.commit()
    db.refresh(head)
    return _head_out(head, db)


@router.delete("/heads/{head_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_head_type(
    head_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    head = db.get(MatterHeadType, head_id)
    if not head:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Head type not found")
    db.delete(head)
    db.commit()


# ── Admin: sub type CRUD ─────────────────────────────────────────────────────

@router.post("/heads/{head_id}/sub-types", response_model=MatterSubTypeOut, status_code=status.HTTP_201_CREATED)
def create_sub_type(
    head_id: uuid.UUID,
    payload: MatterSubTypeCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeOut:
    head = db.get(MatterHeadType, head_id)
    if not head:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Head type not found")
    conflict = db.execute(
        select(MatterSubType)
        .where(MatterSubType.head_type_id == head_id, MatterSubType.name == payload.name.strip())
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Sub type name already exists under this head type")
    sub = MatterSubType(
        head_type_id=head_id,
        name=payload.name.strip(),
        prefix=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return _sub_out(sub, db)


@router.patch("/sub-types/{sub_id}", response_model=MatterSubTypeOut)
def update_sub_type(
    sub_id: uuid.UUID,
    payload: MatterSubTypeUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeOut:
    sub = db.get(MatterSubType, sub_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    if payload.name is not None:
        conflict = db.execute(
            select(MatterSubType)
            .where(
                MatterSubType.head_type_id == sub.head_type_id,
                MatterSubType.name == payload.name.strip(),
                MatterSubType.id != sub_id,
            )
        ).scalar_one_or_none()
        if conflict:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Sub type name already exists under this head type")
        sub.name = payload.name.strip()
    data = payload.model_dump(exclude_unset=True)
    if "prefix" in data:
        sub.prefix = data["prefix"].strip() if data["prefix"] else None
    sub.updated_at = datetime.utcnow()
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return _sub_out(sub, db)


@router.delete("/sub-types/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sub_type(
    sub_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    sub = db.get(MatterSubType, sub_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    db.delete(sub)
    db.commit()


# ── Precedent categories (per matter sub-type) ───────────────────────────────

@router.get("/all-precedent-categories", response_model=list[PrecedentCategoryFlatOut])
def list_all_precedent_categories_flat(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[PrecedentCategoryFlatOut]:
    rows = (
        db.execute(
            select(PrecedentCategory, MatterSubType.name)
            .join(MatterSubType, MatterSubType.id == PrecedentCategory.matter_sub_type_id)
            .order_by(MatterSubType.name, PrecedentCategory.sort_order, PrecedentCategory.name)
        )
        .all()
    )
    out: list[PrecedentCategoryFlatOut] = []
    for cat, sub_name in rows:
        base = PrecedentCategoryOut.model_validate(cat, from_attributes=True)
        out.append(PrecedentCategoryFlatOut(**base.model_dump(), matter_sub_type_name=sub_name))
    return out


@router.get("/sub-types/{sub_id}/precedent-categories", response_model=list[PrecedentCategoryOut])
def list_sub_precedent_categories(
    sub_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PrecedentCategoryOut]:
    if db.get(MatterSubType, sub_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    rows = (
        db.execute(
            select(PrecedentCategory)
            .where(PrecedentCategory.matter_sub_type_id == sub_id)
            .order_by(PrecedentCategory.sort_order, PrecedentCategory.name)
        )
        .scalars()
        .all()
    )
    return [PrecedentCategoryOut.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/sub-types/{sub_id}/precedent-categories",
    response_model=PrecedentCategoryOut,
    status_code=status.HTTP_201_CREATED,
)
def create_sub_precedent_category(
    sub_id: uuid.UUID,
    payload: PrecedentCategoryCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PrecedentCategoryOut:
    if db.get(MatterSubType, sub_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    name = payload.name.strip()
    conflict = db.execute(
        select(PrecedentCategory).where(
            PrecedentCategory.matter_sub_type_id == sub_id,
            PrecedentCategory.name == name,
        )
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A category with this name already exists for this sub type",
        )
    now = datetime.utcnow()
    row = PrecedentCategory(
        id=uuid.uuid4(),
        matter_sub_type_id=sub_id,
        name=name,
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    log_event(
        db,
        actor_user_id=admin.id,
        action="precedent_category.create",
        entity_type="precedent_category",
        entity_id=str(row.id),
        meta={"name": row.name, "matter_sub_type_id": str(sub_id)},
    )
    return PrecedentCategoryOut.model_validate(row, from_attributes=True)


@router.patch(
    "/sub-types/{sub_id}/precedent-categories/{category_id}",
    response_model=PrecedentCategoryOut,
)
def update_sub_precedent_category(
    sub_id: uuid.UUID,
    category_id: uuid.UUID,
    payload: PrecedentCategoryUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PrecedentCategoryOut:
    row = db.get(PrecedentCategory, category_id)
    if row is None or row.matter_sub_type_id != sub_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        nm = data["name"].strip()
        o = db.execute(
            select(PrecedentCategory).where(
                PrecedentCategory.matter_sub_type_id == sub_id,
                PrecedentCategory.name == nm,
                PrecedentCategory.id != category_id,
            )
        ).scalar_one_or_none()
        if o:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A category with this name already exists for this sub type",
            )
        row.name = nm
    if "sort_order" in data and data["sort_order"] is not None:
        row.sort_order = data["sort_order"]
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return PrecedentCategoryOut.model_validate(row, from_attributes=True)


@router.delete(
    "/sub-types/{sub_id}/precedent-categories/{category_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_sub_precedent_category(
    sub_id: uuid.UUID,
    category_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(PrecedentCategory, category_id)
    if row is None or row.matter_sub_type_id != sub_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    n = db.execute(select(func.count()).select_from(Precedent).where(Precedent.category_id == category_id)).scalar_one()
    if n > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete a category that still has precedents assigned",
        )
    db.delete(row)
    db.commit()
    log_event(
        db,
        actor_user_id=admin.id,
        action="precedent_category.delete",
        entity_type="precedent_category",
        entity_id=str(category_id),
        meta={"matter_sub_type_id": str(sub_id)},
    )


# ── Admin: sub type menu CRUD ────────────────────────────────────────────────

@router.post("/sub-types/{sub_id}/menus", response_model=MatterSubTypeMenuOut, status_code=status.HTTP_201_CREATED)
def create_menu(
    sub_id: uuid.UUID,
    payload: MatterSubTypeMenuCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeMenuOut:
    sub = db.get(MatterSubType, sub_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    conflict = db.execute(
        select(MatterSubTypeMenu)
        .where(MatterSubTypeMenu.sub_type_id == sub_id, MatterSubTypeMenu.name == payload.name.strip())
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Menu name already exists for this sub type")
    menu = MatterSubTypeMenu(
        sub_type_id=sub_id,
        name=payload.name.strip(),
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(menu)
    db.commit()
    db.refresh(menu)
    return MatterSubTypeMenuOut(id=menu.id, name=menu.name)


@router.patch("/menus/{menu_id}", response_model=MatterSubTypeMenuOut)
def rename_menu(
    menu_id: uuid.UUID,
    payload: MatterSubTypeMenuUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeMenuOut:
    menu = db.get(MatterSubTypeMenu, menu_id)
    if not menu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Menu not found")
    conflict = db.execute(
        select(MatterSubTypeMenu)
        .where(
            MatterSubTypeMenu.sub_type_id == menu.sub_type_id,
            MatterSubTypeMenu.name == payload.name.strip(),
            MatterSubTypeMenu.id != menu_id,
        )
    ).scalar_one_or_none()
    if conflict:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Menu name already exists for this sub type")
    menu.name = payload.name.strip()
    menu.updated_at = datetime.utcnow()
    db.add(menu)
    db.commit()
    db.refresh(menu)
    return MatterSubTypeMenuOut(id=menu.id, name=menu.name)


@router.delete("/menus/{menu_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_menu(
    menu_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    menu = db.get(MatterSubTypeMenu, menu_id)
    if not menu:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Menu not found")
    db.delete(menu)
    db.commit()
