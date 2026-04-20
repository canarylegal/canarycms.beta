"""Admin CRUD for matter contact type labels (slugs are fixed for system types)."""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.matter_contact_constants import SYSTEM_MATTER_CONTACT_SLUGS
from app.models import MatterContactTypeConfig, User
from app.schemas import MatterContactTypeAdminCreate, MatterContactTypeAdminUpdate, MatterContactTypeOut

router = APIRouter(prefix="/admin/matter-contact-types", tags=["admin-matter-contact-types"])

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@router.get("", response_model=list[MatterContactTypeOut])
def admin_list(_admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[MatterContactTypeOut]:
    rows = (
        db.execute(select(MatterContactTypeConfig).order_by(MatterContactTypeConfig.sort_order, MatterContactTypeConfig.slug))
        .scalars()
        .all()
    )
    return [MatterContactTypeOut.model_validate(r, from_attributes=True) for r in rows]


@router.post("", response_model=MatterContactTypeOut, status_code=status.HTTP_201_CREATED)
def admin_create(
    payload: MatterContactTypeAdminCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterContactTypeOut:
    slug = payload.slug.strip().lower()
    if not _SLUG_RE.fullmatch(slug):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Slug must be lowercase letters, digits, and single hyphens (e.g. 'other-party').",
        )
    exists = db.execute(select(MatterContactTypeConfig).where(MatterContactTypeConfig.slug == slug)).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That slug is already in use.")
    row = MatterContactTypeConfig(
        slug=slug,
        label=payload.label.strip(),
        sort_order=payload.sort_order,
        is_system=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return MatterContactTypeOut.model_validate(row, from_attributes=True)


@router.patch("/{type_id}", response_model=MatterContactTypeOut)
def admin_update(
    type_id: uuid.UUID,
    payload: MatterContactTypeAdminUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> MatterContactTypeOut:
    row = db.get(MatterContactTypeConfig, type_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact type not found.")
    data = payload.model_dump(exclude_unset=True)
    if row.is_system:
        if "label" in data or "sort_order" in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="System contact types cannot be renamed or reordered.",
            )
    else:
        if "label" in data:
            row.label = data["label"].strip()
        if "sort_order" in data:
            row.sort_order = data["sort_order"]
    db.add(row)
    db.commit()
    db.refresh(row)
    return MatterContactTypeOut.model_validate(row, from_attributes=True)


@router.delete("/{type_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete(
    type_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(MatterContactTypeConfig, type_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact type not found.")
    if row.is_system or row.slug in SYSTEM_MATTER_CONTACT_SLUGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This contact type cannot be deleted.",
        )
    db.delete(row)
    db.commit()
