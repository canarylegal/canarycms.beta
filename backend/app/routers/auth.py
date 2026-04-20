import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.models import User, UserRole
from app.schemas import (
    BootstrapAdminRequest,
    Cancel2FASetupRequest,
    ChangePasswordRequest,
    LoginRequest,
    Setup2FAResponse,
    TokenResponse,
    UserDisable2FARequest,
    UserPublic,
    Verify2FARequest,
)
from app.security import (
    build_totp_uri,
    create_access_token,
    generate_totp_secret,
    hash_password,
    verify_password,
    verify_totp,
)
from app.audit import log_event


router = APIRouter(prefix="/auth", tags=["auth"])


def _bootstrap_token() -> str:
    token = os.getenv("BOOTSTRAP_ADMIN_TOKEN")
    if not token:
        raise RuntimeError("BOOTSTRAP_ADMIN_TOKEN is not set")
    return token


@router.post("/bootstrap-admin", response_model=UserPublic)
def bootstrap_admin(payload: BootstrapAdminRequest, db: Session = Depends(get_db)) -> UserPublic:
    if payload.token != _bootstrap_token():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid bootstrap token")

    existing = db.execute(select(User).where(User.role == UserRole.admin)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Admin already exists")

    user = User(
        email=str(payload.email).lower(),
        password_hash=hash_password(payload.password),
        display_name=payload.display_name,
        role=UserRole.admin,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return UserPublic.model_validate(user, from_attributes=True)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.execute(select(User).where(User.email == str(payload.email).lower())).scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if user.is_2fa_enabled:
        if not payload.totp_code or not user.totp_secret:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="2FA required")
        if not verify_totp(secret=user.totp_secret, code=payload.totp_code):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid 2FA code")

    token = create_access_token(user_id=str(user.id), role=user.role.value)
    log_event(
        db,
        actor_user_id=user.id,
        action="auth.login",
        entity_type="user",
        entity_id=str(user.id),
        meta={"email": user.email},
    )
    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserPublic)
def me(user: User = Depends(get_current_user)) -> UserPublic:
    return UserPublic.model_validate(user, from_attributes=True)


@router.post("/2fa/setup", response_model=Setup2FAResponse)
def setup_2fa(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Setup2FAResponse:
    if user.is_2fa_enabled:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="2FA already enabled")

    if not user.totp_secret:
        user.totp_secret = generate_totp_secret()
        db.add(user)
        db.commit()
        db.refresh(user)

    issuer = os.getenv("TOTP_ISSUER", "Canary")
    uri = build_totp_uri(secret=user.totp_secret, email=user.email, issuer=issuer)
    return Setup2FAResponse(secret=user.totp_secret, otpauth_uri=uri)


@router.post("/2fa/verify", response_model=UserPublic)
def verify_2fa(
    payload: Verify2FARequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserPublic:
    if not user.totp_secret:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="2FA not set up")
    if not verify_totp(secret=user.totp_secret, code=payload.code):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")

    user.is_2fa_enabled = True
    db.add(user)
    db.commit()
    db.refresh(user)
    log_event(
        db,
        actor_user_id=user.id,
        action="auth.2fa.enable",
        entity_type="user",
        entity_id=str(user.id),
    )
    return UserPublic.model_validate(user, from_attributes=True)


@router.post("/2fa/disable", status_code=status.HTTP_204_NO_CONTENT)
def disable_my_2fa(
    payload: UserDisable2FARequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if not user.is_2fa_enabled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="2FA is not enabled")
    if not user.totp_secret:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="2FA secret missing")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect password")
    if not verify_totp(secret=user.totp_secret, code=payload.totp_code.strip()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid authenticator code")

    user.totp_secret = None
    user.is_2fa_enabled = False
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="auth.2fa.disable_self",
        entity_type="user",
        entity_id=str(user.id),
    )
    return None


@router.post("/2fa/cancel-setup", status_code=status.HTTP_204_NO_CONTENT)
def cancel_my_2fa_setup(
    payload: Cancel2FASetupRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if user.is_2fa_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="2FA is already enabled — use disable instead of cancel",
        )
    if not user.totp_secret:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No 2FA setup in progress")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Incorrect password")

    user.totp_secret = None
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="auth.2fa.cancel_setup",
        entity_type="user",
        entity_id=str(user.id),
    )
    return None


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")

    user.password_hash = hash_password(payload.new_password)
    user.updated_at = datetime.utcnow()

    # Force 2FA re-verify if enabled: keep secret but require user to re-enter code next login is already enforced.
    db.add(user)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="auth.password.change",
        entity_type="user",
        entity_id=str(user.id),
    )
    return None

