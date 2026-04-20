"""Case invoices: lines stored in DB; pending office posting until approved or voided."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ledger_service import approve_ledger_pair, delete_ledger_pair_unapproved, get_ledger, post_transaction
from app.models import Case, CaseInvoice, CaseInvoiceLine, InvoiceSeq, User
from app.permission_checks import user_may_approve_invoice
from app.schemas import CaseInvoiceCreate, CaseInvoiceLineOut, CaseInvoiceOut, CaseInvoicesOut, LedgerPostCreate

INV_PENDING = "pending_approval"
INV_APPROVED = "approved"
INV_VOIDED = "voided"


def _next_invoice_number(db: Session) -> str:
    row = db.get(InvoiceSeq, 1)
    if row is None:
        row = InvoiceSeq(id=1, next_num=1)
        db.add(row)
        db.flush()
    n = int(row.next_num)
    row.next_num = n + 1
    db.add(row)
    db.flush()
    return f"INV-{n:07d}"


def list_case_invoices(case_id: uuid.UUID, db: Session) -> CaseInvoicesOut:
    rows = (
        db.execute(
            select(CaseInvoice)
            .where(CaseInvoice.case_id == case_id)
            .order_by(CaseInvoice.created_at.desc())
        )
        .scalars()
        .all()
    )
    out: list[CaseInvoiceOut] = []
    for inv in rows:
        lines = (
            db.execute(select(CaseInvoiceLine).where(CaseInvoiceLine.invoice_id == inv.id))
            .scalars()
            .all()
        )
        cu = db.get(User, inv.credit_user_id) if inv.credit_user_id else None
        credit_name = (cu.display_name or cu.email or "").strip() if cu else None
        out.append(
            CaseInvoiceOut(
                id=inv.id,
                case_id=inv.case_id,
                invoice_number=inv.invoice_number,
                status=inv.status,
                total_pence=int(inv.total_pence),
                payee_name=inv.payee_name,
                credit_user_id=inv.credit_user_id,
                credit_user_display_name=credit_name,
                contact_id=inv.contact_id,
                ledger_pair_id=inv.ledger_pair_id,
                created_by_user_id=inv.created_by_user_id,
                approved_by_user_id=inv.approved_by_user_id,
                approved_at=inv.approved_at,
                voided_at=inv.voided_at,
                created_at=inv.created_at,
                lines=[
                    CaseInvoiceLineOut(
                        id=ln.id,
                        line_type=ln.line_type,
                        description=ln.description,
                        amount_pence=int(ln.amount_pence),
                        tax_pence=int(ln.tax_pence),
                        credit_user_id=ln.credit_user_id,
                    )
                    for ln in lines
                ],
            )
        )
    return CaseInvoicesOut(case_id=case_id, invoices=out)


def create_case_invoice(case_id: uuid.UUID, payload: CaseInvoiceCreate, user: User, db: Session) -> CaseInvoiceOut:
    if not payload.lines:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="At least one invoice line is required.")
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")

    credit_u = db.get(User, payload.credit_user_id)
    if not credit_u:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Credit user not found.")
    payee_display = (credit_u.display_name or credit_u.email or "").strip()

    total = 0
    line_rows: list[CaseInvoiceLine] = []
    now = datetime.utcnow()
    inv_id = uuid.uuid4()
    inv_num = _next_invoice_number(db)

    for spec in payload.lines:
        ln = CaseInvoiceLine(
            id=uuid.uuid4(),
            invoice_id=inv_id,
            line_type=spec.line_type,
            description=spec.description.strip(),
            amount_pence=spec.amount_pence,
            tax_pence=spec.tax_pence,
            credit_user_id=spec.credit_user_id,
        )
        total += spec.amount_pence + spec.tax_pence
        line_rows.append(ln)

    if total <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invoice total must be positive.")

    pair_id = post_transaction(
        case_id,
        LedgerPostCreate(
            description=f"Invoice {inv_num} (pending approval)",
            reference=inv_num,
            contact_label=None,
            amount_pence=total,
            client_direction=None,
            office_direction="debit",
        ),
        user,
        db,
    )

    inv = CaseInvoice(
        id=inv_id,
        case_id=case_id,
        invoice_number=inv_num,
        status=INV_PENDING,
        ledger_pair_id=pair_id,
        reversal_pair_id=None,
        total_pence=total,
        payee_name=(payload.payee_name.strip() if payload.payee_name else None) or payee_display or None,
        credit_user_id=payload.credit_user_id,
        contact_id=payload.contact_id,
        created_by_user_id=user.id,
        approved_by_user_id=None,
        approved_at=None,
        voided_at=None,
        created_at=now,
    )
    db.add(inv)
    for ln in line_rows:
        db.add(ln)
    db.flush()
    return list_case_invoices(case_id, db).invoices[0]


def approve_case_invoice(case_id: uuid.UUID, invoice_id: uuid.UUID, user: User, db: Session) -> None:
    if not user_may_approve_invoice(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to approve invoices.",
        )
    inv = db.get(CaseInvoice, invoice_id)
    if not inv or inv.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    if inv.status != INV_PENDING:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invoice is not pending approval.")
    if not inv.ledger_pair_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invoice has no ledger posting.")

    approve_ledger_pair(case_id, inv.ledger_pair_id, db)
    inv.status = INV_APPROVED
    inv.approved_by_user_id = user.id
    inv.approved_at = datetime.utcnow()
    db.add(inv)
    db.flush()


def void_case_invoice(case_id: uuid.UUID, invoice_id: uuid.UUID, user: User, db: Session) -> None:
    if not user_may_approve_invoice(user, db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to void invoices.",
        )
    inv = db.get(CaseInvoice, invoice_id)
    if not inv or inv.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Invoice not found")
    if inv.status == INV_VOIDED:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invoice already voided.")

    now = datetime.utcnow()
    if inv.status == INV_PENDING:
        if inv.ledger_pair_id:
            delete_ledger_pair_unapproved(case_id, inv.ledger_pair_id, db)
        inv.status = INV_VOIDED
        inv.voided_at = now
        db.add(inv)
        db.flush()
        return

    # Approved: post reversal (office credit) and require office balance check per spec
    if inv.status != INV_APPROVED or not inv.ledger_pair_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot void this invoice.")

    ledger = get_ledger(case_id, db)
    office_bal = ledger.office.balance_pence
    total = int(inv.total_pence)
    # After reversal (office credit), office balance increases by total (less negative DR).
    if office_bal + total > 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Voiding this invoice is not allowed: the office account balance would be above £0.00 "
                f"after reversal (current office balance {office_bal / 100:.2f})."
            ),
        )

    rev_id = post_transaction(
        case_id,
        LedgerPostCreate(
            description=f"Reversal of invoice {inv.invoice_number}",
            reference=inv.invoice_number,
            contact_label=None,
            amount_pence=total,
            client_direction=None,
            office_direction="credit",
        ),
        user,
        db,
    )
    approve_ledger_pair(case_id, rev_id, db)

    inv.status = INV_VOIDED
    inv.voided_at = now
    inv.reversal_pair_id = rev_id
    db.add(inv)
    db.flush()
