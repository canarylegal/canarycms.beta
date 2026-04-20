"""List configured matter contact types (for case UI dropdowns)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import MatterContactTypeConfig, User
from app.schemas import MatterContactTypeOut

router = APIRouter(prefix="/matter-contact-types", tags=["matter-contact-types"])


@router.get("", response_model=list[MatterContactTypeOut])
def list_matter_contact_types(
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MatterContactTypeOut]:
    rows = (
        db.execute(select(MatterContactTypeConfig).order_by(MatterContactTypeConfig.sort_order, MatterContactTypeConfig.slug))
        .scalars()
        .all()
    )
    return [MatterContactTypeOut.model_validate(r, from_attributes=True) for r in rows]
