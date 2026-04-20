import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import Case, CaseAccessMode, CaseAccessRule, CaseLockMode, User, UserRole
from app.audit import log_event


router = APIRouter(prefix="/cases/{case_id}/access", tags=["case-access"])


class UpsertCaseAccessRule(BaseModel):
    user_id: uuid.UUID
    mode: CaseAccessMode


class CaseAccessRuleOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    user_id: uuid.UUID
    mode: CaseAccessMode


def _sync_blacklist_lock(case_id: uuid.UUID, db: Session) -> None:
    """Set case lock to blacklist when any deny rules exist; otherwise unlock."""
    # Session uses autoflush=False (see db.SessionLocal). Pending rule INSERT/UPDATE must hit the
    # DB before COUNT runs, or we wrongly clear is_locked / lock_mode while deny rows still commit.
    db.flush()
    case = db.get(Case, case_id)
    if not case:
        return
    n = db.execute(
        select(func.count())
        .select_from(CaseAccessRule)
        .where(CaseAccessRule.case_id == case_id, CaseAccessRule.mode == CaseAccessMode.deny)
    ).scalar_one()
    if n > 0:
        case.is_locked = True
        case.lock_mode = CaseLockMode.blacklist
    else:
        case.is_locked = False
        case.lock_mode = CaseLockMode.none
    case.updated_at = datetime.utcnow()
    db.add(case)


@router.get("", response_model=list[CaseAccessRuleOut])
def list_rules(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CaseAccessRuleOut]:
    require_case_access(case_id, user, db)
    rules = db.execute(select(CaseAccessRule).where(CaseAccessRule.case_id == case_id)).scalars().all()
    return [CaseAccessRuleOut.model_validate(r, from_attributes=True) for r in rules]


@router.put("", response_model=CaseAccessRuleOut)
def upsert_rule(
    case_id: uuid.UUID,
    payload: UpsertCaseAccessRule,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseAccessRuleOut:
    require_case_access(case_id, user, db)

    if payload.mode != CaseAccessMode.deny and user.role != UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators may set allow rules",
        )

    target = db.get(User, payload.user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if target.role == UserRole.admin and payload.mode == CaseAccessMode.deny:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot revoke access for administrators",
        )

    existing = (
        db.execute(
            select(CaseAccessRule).where(
                CaseAccessRule.case_id == case_id,
                CaseAccessRule.user_id == payload.user_id,
            )
        )
        .scalars()
        .one_or_none()
    )
    if existing:
        existing.mode = payload.mode
        db.add(existing)
        _sync_blacklist_lock(case_id, db)
        db.commit()
        db.refresh(existing)
        log_event(
            db,
            actor_user_id=user.id,
            action="case.access.upsert",
            entity_type="case_access_rule",
            entity_id=str(existing.id),
            meta={"case_id": str(case_id), "user_id": str(payload.user_id), "mode": payload.mode.value},
        )
        return CaseAccessRuleOut.model_validate(existing, from_attributes=True)

    rule = CaseAccessRule(case_id=case_id, user_id=payload.user_id, mode=payload.mode)
    db.add(rule)
    _sync_blacklist_lock(case_id, db)
    db.commit()
    db.refresh(rule)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.access.upsert",
        entity_type="case_access_rule",
        entity_id=str(rule.id),
        meta={"case_id": str(case_id), "user_id": str(payload.user_id), "mode": payload.mode.value},
    )
    return CaseAccessRuleOut.model_validate(rule, from_attributes=True)


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(
    case_id: uuid.UUID,
    user_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)

    res = db.execute(
        delete(CaseAccessRule).where(CaseAccessRule.case_id == case_id, CaseAccessRule.user_id == user_id)
    )
    if res.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Rule not found")
    _sync_blacklist_lock(case_id, db)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.access.delete",
        entity_type="case_access_rule",
        entity_id=f"{case_id}:{user_id}",
        meta={"case_id": str(case_id), "user_id": str(user_id)},
    )
    return None
