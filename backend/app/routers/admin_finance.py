"""Admin finance template endpoints."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.finance_service import (
    create_category_template,
    create_item_template,
    delete_category_template,
    delete_item_template,
    get_template,
    update_category_template,
    update_item_template,
)
from app.models import User
from app.schemas import (
    FinanceCategoryTemplateCreate,
    FinanceCategoryTemplateOut,
    FinanceCategoryTemplateUpdate,
    FinanceItemTemplateCreate,
    FinanceItemTemplateOut,
    FinanceItemTemplateUpdate,
    FinanceTemplateOut,
)

router = APIRouter(prefix="/admin/finance", tags=["admin-finance"])


@router.get("/templates/{sub_type_id}", response_model=FinanceTemplateOut)
def read_template(
    sub_type_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FinanceTemplateOut:
    return get_template(sub_type_id, db)


@router.post("/templates/categories", response_model=FinanceCategoryTemplateOut, status_code=status.HTTP_201_CREATED)
def add_category_template(
    payload: FinanceCategoryTemplateCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FinanceCategoryTemplateOut:
    result = create_category_template(payload, db)
    db.commit()
    return result


@router.patch("/templates/categories/{cat_id}", response_model=FinanceCategoryTemplateOut)
def edit_category_template(
    cat_id: uuid.UUID,
    payload: FinanceCategoryTemplateUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FinanceCategoryTemplateOut:
    result = update_category_template(cat_id, payload, db)
    db.commit()
    return result


@router.delete("/templates/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_category_template(
    cat_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    delete_category_template(cat_id, db)
    db.commit()


@router.post("/templates/items", response_model=FinanceItemTemplateOut, status_code=status.HTTP_201_CREATED)
def add_item_template(
    payload: FinanceItemTemplateCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FinanceItemTemplateOut:
    result = create_item_template(payload, db)
    db.commit()
    return result


@router.patch("/templates/items/{item_id}", response_model=FinanceItemTemplateOut)
def edit_item_template(
    item_id: uuid.UUID,
    payload: FinanceItemTemplateUpdate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> FinanceItemTemplateOut:
    result = update_item_template(item_id, payload, db)
    db.commit()
    return result


@router.delete("/templates/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_item_template(
    item_id: uuid.UUID,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    delete_item_template(item_id, db)
    db.commit()
