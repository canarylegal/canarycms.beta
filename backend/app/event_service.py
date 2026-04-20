"""Sub-menu Events: admin templates per matter sub-type + case-level dated rows."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Case, CaseEvent, MatterSubType, MatterSubTypeEventTemplate
from app.schemas import (
    CaseEventOut,
    CaseEventsOut,
    CaseEventUpdate,
    MatterSubTypeEventTemplateCreate,
    MatterSubTypeEventTemplateOut,
    MatterSubTypeEventTemplateUpdate,
)


def _require_sub_type(sub_type_id: uuid.UUID, db: Session) -> MatterSubType:
    sub = db.get(MatterSubType, sub_type_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter sub type not found")
    return sub


def list_event_templates(sub_type_id: uuid.UUID, db: Session) -> list[MatterSubTypeEventTemplateOut]:
    _require_sub_type(sub_type_id, db)
    rows = (
        db.execute(
            select(MatterSubTypeEventTemplate)
            .where(MatterSubTypeEventTemplate.matter_sub_type_id == sub_type_id)
            .order_by(MatterSubTypeEventTemplate.sort_order, MatterSubTypeEventTemplate.created_at)
        )
        .scalars()
        .all()
    )
    return [MatterSubTypeEventTemplateOut.model_validate(r, from_attributes=True) for r in rows]


def create_event_template(
    payload: MatterSubTypeEventTemplateCreate, db: Session
) -> MatterSubTypeEventTemplateOut:
    _require_sub_type(payload.matter_sub_type_id, db)
    now = datetime.utcnow()
    row = MatterSubTypeEventTemplate(
        id=uuid.uuid4(),
        matter_sub_type_id=payload.matter_sub_type_id,
        name=payload.name.strip(),
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return MatterSubTypeEventTemplateOut.model_validate(row, from_attributes=True)


def update_event_template(
    template_id: uuid.UUID, payload: MatterSubTypeEventTemplateUpdate, db: Session
) -> MatterSubTypeEventTemplateOut:
    row = db.get(MatterSubTypeEventTemplate, template_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event template not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        row.name = data["name"].strip()
    if "sort_order" in data and data["sort_order"] is not None:
        row.sort_order = data["sort_order"]
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.flush()
    return MatterSubTypeEventTemplateOut.model_validate(row, from_attributes=True)


def delete_event_template(template_id: uuid.UUID, db: Session) -> None:
    row = db.get(MatterSubTypeEventTemplate, template_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event template not found")
    db.delete(row)
    db.flush()


def _event_out(e: CaseEvent) -> CaseEventOut:
    return CaseEventOut(
        id=e.id,
        case_id=e.case_id,
        template_id=e.template_id,
        name=e.name,
        sort_order=e.sort_order,
        event_date=e.event_date,
        track_in_calendar=e.track_in_calendar,
        calendar_event_uid=e.calendar_event_uid,
        created_at=e.created_at,
        updated_at=e.updated_at,
    )


def _get_or_init_case_events(case_id: uuid.UUID, db: Session) -> list[CaseEvent]:
    existing = (
        db.execute(
            select(CaseEvent)
            .where(CaseEvent.case_id == case_id)
            .order_by(CaseEvent.sort_order, CaseEvent.created_at)
        )
        .scalars()
        .all()
    )
    if existing:
        return list(existing)

    case = db.get(Case, case_id)
    if not case or not case.matter_sub_type_id:
        return []

    templates = (
        db.execute(
            select(MatterSubTypeEventTemplate)
            .where(MatterSubTypeEventTemplate.matter_sub_type_id == case.matter_sub_type_id)
            .order_by(MatterSubTypeEventTemplate.sort_order, MatterSubTypeEventTemplate.created_at)
        )
        .scalars()
        .all()
    )
    if not templates:
        return []

    now = datetime.utcnow()
    out: list[CaseEvent] = []
    for t in templates:
        ce = CaseEvent(
            id=uuid.uuid4(),
            case_id=case_id,
            template_id=t.id,
            name=t.name,
            sort_order=t.sort_order,
            event_date=None,
            created_at=now,
            updated_at=now,
        )
        db.add(ce)
        out.append(ce)
    db.flush()
    return out


def get_case_events(case_id: uuid.UUID, db: Session) -> CaseEventsOut:
    rows = _get_or_init_case_events(case_id, db)
    return CaseEventsOut(case_id=case_id, events=[_event_out(e) for e in rows])


def create_custom_case_event(case_id: uuid.UUID, name: str, db: Session) -> CaseEventOut:
    """Add a case-specific event line (no admin template)."""
    _get_or_init_case_events(case_id, db)
    mx = db.execute(select(func.max(CaseEvent.sort_order)).where(CaseEvent.case_id == case_id)).scalar()
    next_order = (int(mx) + 1) if mx is not None else 0
    now = datetime.utcnow()
    ce = CaseEvent(
        id=uuid.uuid4(),
        case_id=case_id,
        template_id=None,
        name=name.strip(),
        sort_order=next_order,
        event_date=None,
        created_at=now,
        updated_at=now,
    )
    db.add(ce)
    db.flush()
    return _event_out(ce)


def update_case_event(
    case_id: uuid.UUID,
    event_id: uuid.UUID,
    payload: CaseEventUpdate,
    db: Session,
    *,
    actor_user_id: uuid.UUID,
) -> CaseEventOut:
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one field to update.",
        )
    _get_or_init_case_events(case_id, db)
    e = db.get(CaseEvent, event_id)
    if not e or e.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case event not found")
    if "event_date" in data:
        e.event_date = data["event_date"]
    if "track_in_calendar" in data:
        e.track_in_calendar = bool(data["track_in_calendar"])
    if "calendar_event_uid" in data:
        e.calendar_event_uid = data["calendar_event_uid"]
    e.updated_at = datetime.utcnow()
    db.add(e)
    db.flush()

    from app.event_tracked_tasks import sync_tracked_case_event_task

    case = db.get(Case, case_id)
    if case:
        sync_tracked_case_event_task(db, case=case, case_event=e, actor_user_id=actor_user_id)
    db.flush()
    return _event_out(e)
