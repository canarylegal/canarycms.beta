"""Ledger endpoints: GET /cases/{case_id}/ledger and POST /cases/{case_id}/ledger/post."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.ledger_service import approve_ledger_pair, get_ledger, post_transaction
from app.models import User
from app.permission_checks import user_may_approve_ledger
from app.schemas import LedgerOut, LedgerPostCreate

router = APIRouter(prefix="/cases", tags=["ledger"])


@router.get("/{case_id}/ledger", response_model=LedgerOut)
def read_ledger(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LedgerOut:
    require_case_access(case_id, user, db)
    return get_ledger(case_id, db)


@router.post("/{case_id}/ledger/post", status_code=status.HTTP_204_NO_CONTENT)
def create_posting(
    case_id: uuid.UUID,
    payload: LedgerPostCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    post_transaction(case_id, payload, user, db)
    db.commit()


@router.post("/{case_id}/ledger/approve/{pair_id}", status_code=status.HTTP_204_NO_CONTENT)
def approve_posting(
    case_id: uuid.UUID,
    pair_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    if not user_may_approve_ledger(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to approve ledger postings.",
        )
    require_case_access(case_id, user, db)
    approve_ledger_pair(case_id, pair_id, db)
    db.commit()
