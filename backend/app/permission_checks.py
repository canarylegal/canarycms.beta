"""Category-based permissions; admins always pass."""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models import User, UserPermissionCategory, UserRole
from app.schemas import LedgerPostCreate


def _category(user: User, db: Session) -> UserPermissionCategory | None:
    if user.permission_category_id is None:
        return None
    return db.get(UserPermissionCategory, user.permission_category_id)


def assert_may_post_ledger(user: User, payload: LedgerPostCreate, db: Session) -> None:
    """Allow posting if admin, or no category (legacy), or category grants the relevant leg."""
    if user.role == UserRole.admin:
        return
    cat = _category(user, db)
    if cat is None:
        return
    if payload.client_direction and not cat.perm_post_client:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role is not permitted to post to the client account.",
        )
    if payload.office_direction and not cat.perm_post_office:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role is not permitted to post to the office account.",
        )


def user_may_approve_ledger(user: User, db: Session) -> bool:
    if user.role == UserRole.admin:
        return True
    cat = _category(user, db)
    return bool(cat and cat.perm_approve_payments)


def user_may_approve_invoice(user: User, db: Session) -> bool:
    if user.role == UserRole.admin:
        return True
    cat = _category(user, db)
    return bool(cat and cat.perm_approve_invoices)
