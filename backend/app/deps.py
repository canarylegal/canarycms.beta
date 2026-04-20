from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Case, CaseAccessMode, CaseAccessRule, CaseLockMode, User
from app.security import decode_access_token


_bearer = HTTPBearer(auto_error=False)


def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    try:
        payload = decode_access_token(creds.credentials)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = db.get(User, payload.user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User inactive or not found")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role.value != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin required")
    return user


def require_case_access(case_id, user: User, db: Session) -> Case:
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")

    # Admins can always access (including to manage locks/rules).
    if user.role.value == "admin":
        return case

    if not case.is_locked or case.lock_mode == CaseLockMode.none:
        return case

    rules = (
        db.execute(select(CaseAccessRule).where(CaseAccessRule.case_id == case_id, CaseAccessRule.user_id == user.id))
        .scalars()
        .all()
    )
    mode = case.lock_mode

    if mode == CaseLockMode.whitelist:
        # must have allow
        if any(r.mode == CaseAccessMode.allow for r in rules):
            return case
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Case is locked (whitelist)")

    if mode == CaseLockMode.blacklist:
        # denied if any deny
        if any(r.mode == CaseAccessMode.deny for r in rules):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Case is locked (blacklist)")
        return case

    return case

