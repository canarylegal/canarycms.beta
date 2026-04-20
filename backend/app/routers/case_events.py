"""Per-case Events sub-menu (dated rows seeded from matter sub-type template)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.event_service import create_custom_case_event, get_case_events, update_case_event
from app.models import User
from app.schemas import CaseEventCreate, CaseEventOut, CaseEventsOut, CaseEventUpdate

router = APIRouter(prefix="/cases", tags=["case-events"])


@router.post("/{case_id}/events", response_model=CaseEventOut, status_code=201)
def add_custom_case_event(
    case_id: uuid.UUID,
    payload: CaseEventCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseEventOut:
    require_case_access(case_id, user, db)
    out = create_custom_case_event(case_id, payload.name, db)
    db.commit()
    return out


@router.get("/{case_id}/events", response_model=CaseEventsOut)
def read_case_events(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseEventsOut:
    require_case_access(case_id, user, db)
    result = get_case_events(case_id, db)
    db.commit()
    return result


@router.patch("/{case_id}/events/{event_id}", response_model=CaseEventOut)
def patch_case_event(
    case_id: uuid.UUID,
    event_id: uuid.UUID,
    payload: CaseEventUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseEventOut:
    require_case_access(case_id, user, db)
    out = update_case_event(case_id, event_id, payload, db, actor_user_id=user.id)
    db.commit()
    return out
