"""Admin: event line templates per matter sub-type (Sub-menus > Events)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.event_service import (
    create_event_template,
    delete_event_template,
    list_event_templates,
    update_event_template,
)
from app.models import User
from app.schemas import (
    MatterSubTypeEventTemplateCreate,
    MatterSubTypeEventTemplateOut,
    MatterSubTypeEventTemplateUpdate,
)

router = APIRouter(prefix="/admin/sub-menus/events", tags=["admin-sub-menus-events"])


@router.get("/templates/{sub_type_id}", response_model=list[MatterSubTypeEventTemplateOut])
def read_event_templates(
    sub_type_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[MatterSubTypeEventTemplateOut]:
    return list_event_templates(sub_type_id, db)


@router.post("/templates", response_model=MatterSubTypeEventTemplateOut, status_code=status.HTTP_201_CREATED)
def add_event_template(
    payload: MatterSubTypeEventTemplateCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeEventTemplateOut:
    out = create_event_template(payload, db)
    db.commit()
    return out


@router.patch("/templates/{template_id}", response_model=MatterSubTypeEventTemplateOut)
def edit_event_template(
    template_id: uuid.UUID,
    payload: MatterSubTypeEventTemplateUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterSubTypeEventTemplateOut:
    out = update_event_template(template_id, payload, db)
    db.commit()
    return out


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_event_template(
    template_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    delete_event_template(template_id, db)
    db.commit()
