import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.models import User, UserRole
from app.schemas import AdminUserCreate, AdminUserPublic, AdminUserSetPassword, AdminUserUpdate
from app.audit import log_event
from app.security import hash_password


router = APIRouter(prefix="/admin/users", tags=["admin-users"])


@router.get("", response_model=list[AdminUserPublic])
def list_users(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> list[AdminUserPublic]:
    users = db.execute(select(User).order_by(User.created_at.desc())).scalars().all()
    return [AdminUserPublic.model_validate(u, from_attributes=True) for u in users]


@router.post("", response_model=AdminUserPublic, status_code=status.HTTP_201_CREATED)
def create_user(payload: AdminUserCreate, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> AdminUserPublic:
    email = str(payload.email).lower()
    existing = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already exists")

    jt = (payload.job_title or "").strip() or None
    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name,
        job_title=jt,
        role=payload.role,
        is_active=payload.is_active,
        permission_category_id=payload.permission_category_id,
        is_2fa_enabled=False,
        totp_secret=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_event(
        db,
        actor_user_id=admin.id,
        action="admin.user.create",
        entity_type="user",
        entity_id=str(user.id),
        meta={"email": user.email, "role": user.role.value, "is_active": user.is_active},
    )
    return AdminUserPublic.model_validate(user, from_attributes=True)


@router.patch("/{user_id}", response_model=AdminUserPublic)
def update_user(
    user_id: uuid.UUID,
    payload: AdminUserUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserPublic:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    data = payload.model_dump(exclude_unset=True)
    if "job_title" in data:
        data["job_title"] = (data["job_title"] or "").strip() or None
    for k, v in data.items():
        setattr(user, k, v)
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    log_event(
        db,
        actor_user_id=admin.id,
        action="admin.user.update",
        entity_type="user",
        entity_id=str(user.id),
        meta=payload.model_dump(exclude_unset=True),
    )
    return AdminUserPublic.model_validate(user, from_attributes=True)


@router.post("/{user_id}/set-password", status_code=status.HTTP_204_NO_CONTENT)
def set_password(
    user_id: uuid.UUID,
    payload: AdminUserSetPassword,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    user.password_hash = hash_password(payload.password)
    user.updated_at = datetime.utcnow()
    # Security: if admin resets password, force 2FA re-enrolment
    user.totp_secret = None
    user.is_2fa_enabled = False

    db.add(user)
    db.commit()
    log_event(
        db,
        actor_user_id=admin.id,
        action="admin.user.set_password",
        entity_type="user",
        entity_id=str(user.id),
    )
    return None


@router.post("/{user_id}/disable-2fa", status_code=status.HTTP_204_NO_CONTENT)
def disable_2fa(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    user.totp_secret = None
    user.is_2fa_enabled = False
    user.updated_at = datetime.utcnow()
    db.add(user)
    db.commit()
    log_event(
        db,
        actor_user_id=admin.id,
        action="admin.user.disable_2fa",
        entity_type="user",
        entity_id=str(user.id),
    )
    return None

