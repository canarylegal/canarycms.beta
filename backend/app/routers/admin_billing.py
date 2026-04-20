"""Admin: default VAT + per-sub-type invoice line templates."""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.billing_service import (
    create_line_template,
    delete_line_template,
    get_billing_settings,
    list_line_templates,
    update_default_vat_percent,
    update_line_template,
)
from app.db import get_db
from app.deps import require_admin
from app.models import User
from app.schemas import (
    BillingLineTemplateCreate,
    BillingLineTemplateOut,
    BillingLineTemplateUpdate,
    BillingSettingsOut,
    BillingSettingsUpdate,
)

router = APIRouter(prefix="/admin/billing", tags=["admin-billing"])


@router.get("/settings", response_model=BillingSettingsOut)
def read_settings(_admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> BillingSettingsOut:
    row = get_billing_settings(db)
    return BillingSettingsOut(default_vat_percent=float(row.default_vat_percent))


@router.patch("/settings", response_model=BillingSettingsOut)
def patch_settings(
    payload: BillingSettingsUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> BillingSettingsOut:
    row = update_default_vat_percent(db, Decimal(str(payload.default_vat_percent)))
    db.commit()
    return BillingSettingsOut(default_vat_percent=float(row.default_vat_percent))


@router.get("/templates/{sub_type_id}", response_model=list[BillingLineTemplateOut])
def read_templates(
    sub_type_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[BillingLineTemplateOut]:
    rows = list_line_templates(sub_type_id, db)
    return [BillingLineTemplateOut.model_validate(r, from_attributes=True) for r in rows]


@router.post("/templates", response_model=BillingLineTemplateOut, status_code=status.HTTP_201_CREATED)
def add_template(
    payload: BillingLineTemplateCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> BillingLineTemplateOut:
    row = create_line_template(
        matter_sub_type_id=payload.matter_sub_type_id,
        line_kind=payload.line_kind,
        label=payload.label,
        default_amount_pence=payload.default_amount_pence,
        sort_order=payload.sort_order,
        db=db,
    )
    db.commit()
    return BillingLineTemplateOut.model_validate(row, from_attributes=True)


@router.patch("/templates/{template_id}", response_model=BillingLineTemplateOut)
def edit_template(
    template_id: uuid.UUID,
    payload: BillingLineTemplateUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> BillingLineTemplateOut:
    data = payload.model_dump(exclude_unset=True)
    row = update_line_template(
        template_id,
        label=data.get("label"),
        default_amount_pence=data.get("default_amount_pence"),
        sort_order=data.get("sort_order"),
        db=db,
    )
    db.commit()
    return BillingLineTemplateOut.model_validate(row, from_attributes=True)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_template(
    template_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    delete_line_template(template_id, db)
    db.commit()
