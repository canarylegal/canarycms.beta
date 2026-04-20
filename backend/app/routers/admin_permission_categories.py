"""Admin CRUD for user permission categories."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.models import User, UserPermissionCategory
from app.schemas import UserPermissionCategoryCreate, UserPermissionCategoryOut, UserPermissionCategoryPatch

router = APIRouter(prefix="/admin/permission-categories", tags=["admin-permission-categories"])


@router.get("", response_model=list[UserPermissionCategoryOut])
def list_categories(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[UserPermissionCategoryOut]:
    rows = (
        db.execute(select(UserPermissionCategory).order_by(UserPermissionCategory.name.asc()))
        .scalars()
        .all()
    )
    return [UserPermissionCategoryOut.model_validate(r, from_attributes=True) for r in rows]


@router.post("", response_model=UserPermissionCategoryOut, status_code=status.HTTP_201_CREATED)
def create_category(
    payload: UserPermissionCategoryCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserPermissionCategoryOut:
    now = datetime.utcnow()
    row = UserPermissionCategory(
        id=uuid.uuid4(),
        name=payload.name.strip(),
        perm_fee_earner=payload.perm_fee_earner,
        perm_post_client=payload.perm_post_client,
        perm_post_office=payload.perm_post_office,
        perm_approve_payments=payload.perm_approve_payments,
        perm_approve_invoices=payload.perm_approve_invoices,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Category name may already exist.")
    db.refresh(row)
    return UserPermissionCategoryOut.model_validate(row, from_attributes=True)


@router.patch("/{category_id}", response_model=UserPermissionCategoryOut)
def patch_category(
    category_id: uuid.UUID,
    payload: UserPermissionCategoryPatch,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserPermissionCategoryOut:
    row = db.get(UserPermissionCategory, category_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        row.name = data["name"].strip()
    for k in (
        "perm_fee_earner",
        "perm_post_client",
        "perm_post_office",
        "perm_approve_payments",
        "perm_approve_invoices",
    ):
        if k in data and data[k] is not None:
            setattr(row, k, data[k])
    row.updated_at = datetime.utcnow()
    db.add(row)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Update failed.")
    db.refresh(row)
    return UserPermissionCategoryOut.model_validate(row, from_attributes=True)


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_category(
    category_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(UserPermissionCategory, category_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    n = db.scalar(select(func.count()).where(User.permission_category_id == category_id)) or 0
    if int(n) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete a category that is still assigned to users.",
        )
    db.delete(row)
    db.commit()
    return None
