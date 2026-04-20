"""Admin billing templates (fees/disbursements per sub-type) + default VAT."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import BillingLineTemplate, BillingSettings, Case, MatterSubType, User
from app.schemas import BillingLineTemplateOut, InvoiceBillingDefaultsOut, InvoiceBillingDefaultsUser


def get_billing_settings(db: Session) -> BillingSettings:
    row = db.get(BillingSettings, 1)
    if row is None:
        row = BillingSettings(id=1, default_vat_percent=Decimal("20"))
        db.add(row)
        db.flush()
    return row


def update_default_vat_percent(db: Session, pct: Decimal) -> BillingSettings:
    if pct < 0 or pct > 100:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="VAT must be between 0 and 100.")
    row = get_billing_settings(db)
    row.default_vat_percent = pct
    db.add(row)
    db.flush()
    return row


def list_line_templates(sub_type_id: uuid.UUID, db: Session) -> list[BillingLineTemplate]:
    _require_sub_type(sub_type_id, db)
    return (
        db.execute(
            select(BillingLineTemplate)
            .where(BillingLineTemplate.matter_sub_type_id == sub_type_id)
            .order_by(BillingLineTemplate.line_kind, BillingLineTemplate.sort_order, BillingLineTemplate.created_at)
        )
        .scalars()
        .all()
    )


def _require_sub_type(sub_type_id: uuid.UUID, db: Session) -> MatterSubType:
    sub = db.get(MatterSubType, sub_type_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter sub type not found")
    return sub


def create_line_template(
    *,
    matter_sub_type_id: uuid.UUID,
    line_kind: str,
    label: str,
    default_amount_pence: int,
    sort_order: int,
    db: Session,
) -> BillingLineTemplate:
    _require_sub_type(matter_sub_type_id, db)
    if line_kind not in ("fee", "disbursement"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="line_kind must be fee or disbursement.")
    now = datetime.utcnow()
    row = BillingLineTemplate(
        id=uuid.uuid4(),
        matter_sub_type_id=matter_sub_type_id,
        line_kind=line_kind,
        label=label.strip(),
        default_amount_pence=default_amount_pence,
        sort_order=sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    return row


def update_line_template(
    template_id: uuid.UUID,
    *,
    label: str | None,
    default_amount_pence: int | None,
    sort_order: int | None,
    db: Session,
) -> BillingLineTemplate:
    row = db.get(BillingLineTemplate, template_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    if label is not None:
        row.label = label.strip()
    if default_amount_pence is not None:
        row.default_amount_pence = default_amount_pence
    if sort_order is not None:
        row.sort_order = sort_order
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.flush()
    return row


def delete_line_template(template_id: uuid.UUID, db: Session) -> None:
    row = db.get(BillingLineTemplate, template_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    db.delete(row)
    db.flush()


def invoice_billing_defaults_for_case(case_id: uuid.UUID, db: Session) -> InvoiceBillingDefaultsOut:
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    settings = get_billing_settings(db)
    vat = float(settings.default_vat_percent)
    fee_rows: list[BillingLineTemplate] = []
    dis_rows: list[BillingLineTemplate] = []
    if case.matter_sub_type_id:
        for r in list_line_templates(case.matter_sub_type_id, db):
            if r.line_kind == "fee":
                fee_rows.append(r)
            else:
                dis_rows.append(r)
    users = db.execute(select(User).where(User.is_active.is_(True)).order_by(User.display_name.asc())).scalars().all()
    return InvoiceBillingDefaultsOut(
        default_vat_percent=vat,
        fee_earner_user_id=case.fee_earner_user_id,
        fee_templates=[BillingLineTemplateOut.model_validate(x, from_attributes=True) for x in fee_rows],
        disbursement_templates=[BillingLineTemplateOut.model_validate(x, from_attributes=True) for x in dis_rows],
        users=[
            InvoiceBillingDefaultsUser(
                id=str(u.id),
                email=u.email,
                display_name=u.display_name or u.email or "",
            )
            for u in users
        ],
    )
