import os
import secrets
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.calendar_service import ensure_default_calendar
from app.db import get_db
from app.deps import get_current_user
from app.email_crypt import encrypt_password
from app.models import User
from app.radicale_htpasswd import remove_user, upsert_user
from app.permission_checks import user_may_approve_invoice, user_may_approve_ledger
from app.schemas import (
    LedgerPermissionsOut,
    UserCalDAVProvisionOut,
    UserCalDAVStatusOut,
    UserEmailHandlingUpdate,
    UserPublic,
)


router = APIRouter(prefix="/users", tags=["users"])

DEFAULT_OUTLOOK_MAIL_URL = "https://outlook.office.com/mail"


def _validate_http_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="URL must use http:// or https://",
        )
    if not parsed.netloc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid URL")
    return url


def _caldav_base_url() -> str:
    return (os.getenv("CANARY_CALDAV_PUBLIC_URL") or "http://localhost:5232").strip().rstrip("/")


def _caldav_principal_url(user_id: uuid.UUID) -> str:
    return f"{_caldav_base_url()}/{user_id}/"


def _caldav_username(user: User) -> str:
    return str(user.id)


class UserSummary(BaseModel):
    id: uuid.UUID
    email: EmailStr
    display_name: str
    role: str
    is_active: bool


@router.get("", response_model=list[UserSummary])
def list_users(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[UserSummary]:
    users = db.execute(select(User).order_by(User.display_name.asc())).scalars().all()
    return [UserSummary.model_validate(u, from_attributes=True) for u in users]


@router.get("/me/ledger-permissions", response_model=LedgerPermissionsOut)
def my_ledger_permissions(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> LedgerPermissionsOut:
    return LedgerPermissionsOut(
        can_approve_ledger=user_may_approve_ledger(user, db),
        can_approve_invoices=user_may_approve_invoice(user, db),
    )


@router.get("/me/calendar", response_model=UserCalDAVStatusOut)
def get_my_calendar(user: User = Depends(get_current_user)) -> UserCalDAVStatusOut:
    enabled = bool(user.caldav_password_enc)
    return UserCalDAVStatusOut(
        enabled=enabled,
        caldav_url=_caldav_principal_url(user.id),
        caldav_username=_caldav_username(user),
    )


@router.post("/me/calendar/enable", response_model=UserCalDAVProvisionOut)
def enable_my_calendar(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UserCalDAVProvisionOut:
    if user.caldav_password_enc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="CalDAV is already enabled. Use reset-password to rotate the app password, or disable first.",
        )
    plain = secrets.token_urlsafe(24)
    try:
        upsert_user(username=_caldav_username(user), plaintext_password=plain)
    except OSError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not write CalDAV credentials: {e}",
        ) from e
    now = datetime.now(timezone.utc)
    user.caldav_password_enc = encrypt_password(plain)
    user.updated_at = now
    db.add(user)
    db.commit()
    ensure_default_calendar(db, user)
    return UserCalDAVProvisionOut(
        caldav_url=_caldav_principal_url(user.id),
        caldav_username=_caldav_username(user),
        caldav_password=plain,
    )


@router.post("/me/calendar/reset-password", response_model=UserCalDAVProvisionOut)
def reset_my_caldav_password(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserCalDAVProvisionOut:
    if not user.caldav_password_enc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="CalDAV is not enabled")
    plain = secrets.token_urlsafe(24)
    try:
        upsert_user(username=_caldav_username(user), plaintext_password=plain)
    except OSError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Could not write CalDAV credentials: {e}",
        ) from e
    now = datetime.now(timezone.utc)
    user.caldav_password_enc = encrypt_password(plain)
    user.updated_at = now
    db.add(user)
    db.commit()
    return UserCalDAVProvisionOut(
        caldav_url=_caldav_principal_url(user.id),
        caldav_username=_caldav_username(user),
        caldav_password=plain,
    )


@router.delete("/me/calendar/disable", status_code=status.HTTP_204_NO_CONTENT)
def disable_my_calendar(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> None:
    if not user.caldav_password_enc:
        return None
    remove_user(_caldav_username(user))
    user.caldav_password_enc = None
    user.updated_at = datetime.now(timezone.utc)
    db.add(user)
    db.commit()
    return None


@router.put("/me/email-handling", response_model=UserPublic)
def put_my_email_handling(
    body: UserEmailHandlingUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserPublic:
    """Persist how the app top-bar E-mail button opens mail (desktop vs Outlook web)."""
    now = datetime.now(timezone.utc)
    user.email_launch_preference = body.email_launch_preference
    if body.email_launch_preference == "outlook_web":
        raw = (body.email_outlook_web_url or "").strip() or DEFAULT_OUTLOOK_MAIL_URL
        user.email_outlook_web_url = _validate_http_url(raw)
    else:
        user.email_outlook_web_url = None
    user.updated_at = now
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserPublic.model_validate(user, from_attributes=True)
