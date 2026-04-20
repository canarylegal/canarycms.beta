"""Ledger service — double-entry posting logic adhering to SAR 2019."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import LedgerAccount, LedgerAccountType, LedgerDirection, LedgerEntry, User, UserRole
from app.permission_checks import assert_may_post_ledger
from app.schemas import LedgerAccountSummary, LedgerEntryOut, LedgerOut, LedgerPostCreate


def _get_or_create_accounts(case_id: uuid.UUID, db: Session) -> dict[str, LedgerAccount]:
    """Return {account_type: LedgerAccount}, creating rows if they don't exist yet."""
    rows = (
        db.execute(
            select(LedgerAccount).where(LedgerAccount.case_id == case_id)
        )
        .scalars()
        .all()
    )
    by_type: dict[str, LedgerAccount] = {r.account_type.value: r for r in rows}
    changed = False
    for atype in (LedgerAccountType.client, LedgerAccountType.office):
        if atype.value not in by_type:
            acc = LedgerAccount(
                id=uuid.uuid4(),
                case_id=case_id,
                account_type=atype,
                created_at=datetime.utcnow(),
            )
            db.add(acc)
            by_type[atype.value] = acc
            changed = True
    if changed:
        db.flush()
    return by_type


def _balance(account_id: uuid.UUID, db: Session, *, approved_only: bool = True) -> int:
    """Net balance in pence: sum(credits) - sum(debits)."""
    q = select(LedgerEntry).where(LedgerEntry.account_id == account_id)
    if approved_only:
        q = q.where(LedgerEntry.is_approved.is_(True))
    entries = db.execute(q).scalars().all()
    total = 0
    for e in entries:
        if e.direction == LedgerDirection.credit:
            total += e.amount_pence
        else:
            total -= e.amount_pence
    return total


def post_transaction(
    case_id: uuid.UUID,
    payload: LedgerPostCreate,
    user: User,
    db: Session,
) -> uuid.UUID:
    """
    Create a double-entry posting.

    At least one of client_direction / office_direction must be supplied.
    For a single-account entry (rare but allowed for office-only disbursements),
    only the relevant direction need be set.

    SAR no-deficit rule: client account balance must never go below zero after
    any posting. (Office account may go into overdraft to represent unpaid bills.)
    """
    if not payload.client_direction and not payload.office_direction:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one of client_direction or office_direction is required.",
        )

    assert_may_post_ledger(user, payload, db)

    accounts = _get_or_create_accounts(case_id, db)
    pair_id = uuid.uuid4()
    now = datetime.utcnow()
    legs: list[LedgerEntry] = []
    is_approved = user.role == UserRole.admin

    if payload.client_direction:
        legs.append(
            LedgerEntry(
                id=uuid.uuid4(),
                account_id=accounts["client"].id,
                pair_id=pair_id,
                direction=LedgerDirection(payload.client_direction),
                amount_pence=payload.amount_pence,
                description=payload.description,
                reference=payload.reference,
                contact_label=payload.contact_label,
                posted_by_user_id=user.id,
                posted_at=now,
                is_approved=is_approved,
            )
        )

    if payload.office_direction:
        legs.append(
            LedgerEntry(
                id=uuid.uuid4(),
                account_id=accounts["office"].id,
                pair_id=pair_id,
                direction=LedgerDirection(payload.office_direction),
                amount_pence=payload.amount_pence,
                description=payload.description,
                reference=payload.reference,
                contact_label=payload.contact_label,
                posted_by_user_id=user.id,
                posted_at=now,
                is_approved=is_approved,
            )
        )

    for leg in legs:
        db.add(leg)
    db.flush()

    # SAR no-deficit check on client account (approved postings only affect balance).
    client_balance = _balance(accounts["client"].id, db, approved_only=True)
    if client_balance < 0:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Posting rejected: client account would go into deficit "
                f"(balance would be £{abs(client_balance)/100:.2f} DR). "
                "SAR 2019 prohibits a debit balance on a client account."
            ),
        )

    return pair_id


def delete_ledger_pair_unapproved(case_id: uuid.UUID, pair_id: uuid.UUID, db: Session) -> None:
    """Remove both legs of an unapproved posting (e.g. void draft invoice)."""
    accounts = _get_or_create_accounts(case_id, db)
    aid = {accounts["client"].id, accounts["office"].id}
    legs = (
        db.execute(
            select(LedgerEntry).where(
                LedgerEntry.pair_id == pair_id,
                LedgerEntry.account_id.in_(aid),
            )
        )
        .scalars()
        .all()
    )
    if not legs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Posting not found")
    if any(e.is_approved for e in legs):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove an approved posting; use a reversal instead.",
        )
    for e in legs:
        db.delete(e)
    db.flush()


def get_ledger(case_id: uuid.UUID, db: Session) -> LedgerOut:
    accounts = _get_or_create_accounts(case_id, db)

    all_entries = (
        db.execute(
            select(LedgerEntry)
            .where(
                LedgerEntry.account_id.in_(
                    [accounts["client"].id, accounts["office"].id]
                )
            )
            .order_by(LedgerEntry.posted_at)
        )
        .scalars()
        .all()
    )

    account_id_to_type = {
        accounts["client"].id: "client",
        accounts["office"].id: "office",
    }

    entry_outs: list[LedgerEntryOut] = []
    for e in all_entries:
        entry_outs.append(
            LedgerEntryOut(
                id=e.id,
                pair_id=e.pair_id,
                account_type=account_id_to_type[e.account_id],
                direction=e.direction.value,
                amount_pence=e.amount_pence,
                description=e.description,
                reference=e.reference,
                contact_label=e.contact_label,
                posted_by_user_id=e.posted_by_user_id,
                posted_at=e.posted_at,
                is_approved=e.is_approved,
            )
        )

    client_balance = _balance(accounts["client"].id, db, approved_only=True)
    office_balance = _balance(accounts["office"].id, db, approved_only=True)

    return LedgerOut(
        entries=entry_outs,
        client=LedgerAccountSummary(account_type="client", balance_pence=client_balance),
        office=LedgerAccountSummary(account_type="office", balance_pence=office_balance),
    )


def approve_ledger_pair(case_id: uuid.UUID, pair_id: uuid.UUID, db: Session) -> None:
    """Mark both legs of a posting approved; re-validates SAR client balance."""
    accounts = _get_or_create_accounts(case_id, db)
    aid = {accounts["client"].id, accounts["office"].id}
    legs = (
        db.execute(
            select(LedgerEntry).where(
                LedgerEntry.pair_id == pair_id,
                LedgerEntry.account_id.in_(aid),
            )
        )
        .scalars()
        .all()
    )
    if not legs:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Posting not found")
    if any(e.account_id not in aid for e in legs):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid posting")
    for e in legs:
        e.is_approved = True
    db.flush()

    client_balance = _balance(accounts["client"].id, db, approved_only=True)
    if client_balance < 0:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Approving this posting would put the client account into deficit "
                f"(balance would be £{abs(client_balance)/100:.2f} DR)."
            ),
        )
