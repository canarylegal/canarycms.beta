"""Finance service — admin template CRUD + case-level finance initialisation/CRUD."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    FinanceCategory,
    FinanceCategoryTemplate,
    FinanceItem,
    FinanceItemTemplate,
    MatterSubType,
    Case,
)
from app.schemas import (
    FinanceCategoryCreate,
    FinanceCategoryOut,
    FinanceCategoryTemplateCreate,
    FinanceCategoryTemplateOut,
    FinanceCategoryTemplateUpdate,
    FinanceCategoryUpdate,
    FinanceItemCreate,
    FinanceItemOut,
    FinanceItemTemplateCreate,
    FinanceItemTemplateOut,
    FinanceItemTemplateUpdate,
    FinanceItemUpdate,
    FinanceOut,
    FinanceTemplateOut,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _cat_tmpl_out(cat: FinanceCategoryTemplate, items: list[FinanceItemTemplate]) -> FinanceCategoryTemplateOut:
    return FinanceCategoryTemplateOut(
        id=cat.id,
        matter_sub_type_id=cat.matter_sub_type_id,
        name=cat.name,
        sort_order=cat.sort_order,
        items=[
            FinanceItemTemplateOut(
                id=it.id,
                category_id=it.category_id,
                name=it.name,
                direction=it.direction,
                sort_order=it.sort_order,
            )
            for it in sorted(items, key=lambda x: (x.sort_order, x.created_at))
        ],
    )


def _item_out(item: FinanceItem) -> FinanceItemOut:
    return FinanceItemOut(
        id=item.id,
        category_id=item.category_id,
        template_item_id=item.template_item_id,
        name=item.name,
        direction=item.direction,
        amount_pence=item.amount_pence,
        sort_order=item.sort_order,
    )


def _cat_out(cat: FinanceCategory, items: list[FinanceItem]) -> FinanceCategoryOut:
    return FinanceCategoryOut(
        id=cat.id,
        case_id=cat.case_id,
        template_category_id=cat.template_category_id,
        name=cat.name,
        sort_order=cat.sort_order,
        items=[
            _item_out(it)
            for it in sorted(items, key=lambda x: (x.sort_order, x.created_at))
        ],
    )


# ---------------------------------------------------------------------------
# Admin template API
# ---------------------------------------------------------------------------

def get_template(sub_type_id: uuid.UUID, db: Session) -> FinanceTemplateOut:
    sub = db.get(MatterSubType, sub_type_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")

    cats = (
        db.execute(
            select(FinanceCategoryTemplate)
            .where(FinanceCategoryTemplate.matter_sub_type_id == sub_type_id)
            .order_by(FinanceCategoryTemplate.sort_order, FinanceCategoryTemplate.created_at)
        )
        .scalars()
        .all()
    )
    cat_ids = [c.id for c in cats]
    items_by_cat: dict[uuid.UUID, list[FinanceItemTemplate]] = {c.id: [] for c in cats}
    if cat_ids:
        all_items = (
            db.execute(
                select(FinanceItemTemplate).where(FinanceItemTemplate.category_id.in_(cat_ids))
            )
            .scalars()
            .all()
        )
        for it in all_items:
            items_by_cat[it.category_id].append(it)

    return FinanceTemplateOut(
        matter_sub_type_id=sub_type_id,
        categories=[_cat_tmpl_out(c, items_by_cat[c.id]) for c in cats],
    )


def create_category_template(payload: FinanceCategoryTemplateCreate, db: Session) -> FinanceCategoryTemplateOut:
    sub = db.get(MatterSubType, payload.matter_sub_type_id)
    if not sub:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub type not found")
    now = datetime.utcnow()
    cat = FinanceCategoryTemplate(
        id=uuid.uuid4(),
        matter_sub_type_id=payload.matter_sub_type_id,
        name=payload.name,
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(cat)
    db.flush()
    return _cat_tmpl_out(cat, [])


def update_category_template(cat_id: uuid.UUID, payload: FinanceCategoryTemplateUpdate, db: Session) -> FinanceCategoryTemplateOut:
    cat = db.get(FinanceCategoryTemplate, cat_id)
    if not cat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    if payload.name is not None:
        cat.name = payload.name
    if payload.sort_order is not None:
        cat.sort_order = payload.sort_order
    cat.updated_at = datetime.utcnow()
    db.flush()
    items = (
        db.execute(select(FinanceItemTemplate).where(FinanceItemTemplate.category_id == cat_id))
        .scalars().all()
    )
    return _cat_tmpl_out(cat, list(items))


def delete_category_template(cat_id: uuid.UUID, db: Session) -> None:
    cat = db.get(FinanceCategoryTemplate, cat_id)
    if not cat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    db.delete(cat)
    db.flush()


def create_item_template(payload: FinanceItemTemplateCreate, db: Session) -> FinanceItemTemplateOut:
    cat = db.get(FinanceCategoryTemplate, payload.category_id)
    if not cat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    now = datetime.utcnow()
    item = FinanceItemTemplate(
        id=uuid.uuid4(),
        category_id=payload.category_id,
        name=payload.name,
        direction=payload.direction,
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(item)
    db.flush()
    return FinanceItemTemplateOut(
        id=item.id,
        category_id=item.category_id,
        name=item.name,
        direction=item.direction,
        sort_order=item.sort_order,
    )


def update_item_template(item_id: uuid.UUID, payload: FinanceItemTemplateUpdate, db: Session) -> FinanceItemTemplateOut:
    item = db.get(FinanceItemTemplate, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    if payload.name is not None:
        item.name = payload.name
    if payload.direction is not None:
        item.direction = payload.direction
    if payload.sort_order is not None:
        item.sort_order = payload.sort_order
    item.updated_at = datetime.utcnow()
    db.flush()
    return FinanceItemTemplateOut(
        id=item.id,
        category_id=item.category_id,
        name=item.name,
        direction=item.direction,
        sort_order=item.sort_order,
    )


def delete_item_template(item_id: uuid.UUID, db: Session) -> None:
    item = db.get(FinanceItemTemplate, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    db.delete(item)
    db.flush()


# ---------------------------------------------------------------------------
# Case-level finance API
# ---------------------------------------------------------------------------

def _get_or_init_finance(case_id: uuid.UUID, db: Session) -> list[FinanceCategory]:
    """Return existing case finance categories, or seed from template if none exist."""
    existing = (
        db.execute(
            select(FinanceCategory).where(FinanceCategory.case_id == case_id).order_by(
                FinanceCategory.sort_order, FinanceCategory.created_at
            )
        )
        .scalars()
        .all()
    )
    if existing:
        return list(existing)

    # First access — check if case has a matter sub-type with a template.
    case = db.get(Case, case_id)
    if not case or not case.matter_sub_type_id:
        return []

    tmpl_cats = (
        db.execute(
            select(FinanceCategoryTemplate)
            .where(FinanceCategoryTemplate.matter_sub_type_id == case.matter_sub_type_id)
            .order_by(FinanceCategoryTemplate.sort_order, FinanceCategoryTemplate.created_at)
        )
        .scalars()
        .all()
    )
    if not tmpl_cats:
        return []

    cat_ids = [c.id for c in tmpl_cats]
    tmpl_items = (
        db.execute(
            select(FinanceItemTemplate)
            .where(FinanceItemTemplate.category_id.in_(cat_ids))
            .order_by(FinanceItemTemplate.sort_order, FinanceItemTemplate.created_at)
        )
        .scalars()
        .all()
    )
    items_by_cat: dict[uuid.UUID, list[FinanceItemTemplate]] = {c.id: [] for c in tmpl_cats}
    for it in tmpl_items:
        items_by_cat[it.category_id].append(it)

    now = datetime.utcnow()
    new_cats: list[FinanceCategory] = []
    for tmpl_cat in tmpl_cats:
        cat = FinanceCategory(
            id=uuid.uuid4(),
            case_id=case_id,
            template_category_id=tmpl_cat.id,
            name=tmpl_cat.name,
            sort_order=tmpl_cat.sort_order,
            created_at=now,
            updated_at=now,
        )
        db.add(cat)
        new_cats.append(cat)
        for tmpl_item in items_by_cat[tmpl_cat.id]:
            fi = FinanceItem(
                id=uuid.uuid4(),
                category_id=cat.id,
                template_item_id=tmpl_item.id,
                name=tmpl_item.name,
                direction=tmpl_item.direction,
                amount_pence=None,
                sort_order=tmpl_item.sort_order,
                created_at=now,
                updated_at=now,
            )
            db.add(fi)

    db.flush()
    return new_cats


def _load_items_for_cats(cat_ids: list[uuid.UUID], db: Session) -> dict[uuid.UUID, list[FinanceItem]]:
    result: dict[uuid.UUID, list[FinanceItem]] = {cid: [] for cid in cat_ids}
    if not cat_ids:
        return result
    rows = (
        db.execute(select(FinanceItem).where(FinanceItem.category_id.in_(cat_ids)))
        .scalars()
        .all()
    )
    for it in rows:
        result[it.category_id].append(it)
    return result


def get_finance(case_id: uuid.UUID, db: Session) -> FinanceOut:
    cats = _get_or_init_finance(case_id, db)
    cat_ids = [c.id for c in cats]
    items_by_cat = _load_items_for_cats(cat_ids, db)
    return FinanceOut(
        case_id=case_id,
        categories=[_cat_out(c, items_by_cat[c.id]) for c in cats],
    )


def create_finance_category(case_id: uuid.UUID, payload: FinanceCategoryCreate, db: Session) -> FinanceCategoryOut:
    now = datetime.utcnow()
    cat = FinanceCategory(
        id=uuid.uuid4(),
        case_id=case_id,
        template_category_id=None,
        name=payload.name,
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(cat)
    db.flush()
    return _cat_out(cat, [])


def update_finance_category(case_id: uuid.UUID, cat_id: uuid.UUID, payload: FinanceCategoryUpdate, db: Session) -> FinanceCategoryOut:
    cat = db.get(FinanceCategory, cat_id)
    if not cat or cat.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    if payload.name is not None:
        cat.name = payload.name
    if payload.sort_order is not None:
        cat.sort_order = payload.sort_order
    cat.updated_at = datetime.utcnow()
    db.flush()
    items = db.execute(select(FinanceItem).where(FinanceItem.category_id == cat_id)).scalars().all()
    return _cat_out(cat, list(items))


def delete_finance_category(case_id: uuid.UUID, cat_id: uuid.UUID, db: Session) -> None:
    cat = db.get(FinanceCategory, cat_id)
    if not cat or cat.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    db.delete(cat)
    db.flush()


def create_finance_item(case_id: uuid.UUID, payload: FinanceItemCreate, db: Session) -> FinanceItemOut:
    cat = db.get(FinanceCategory, payload.category_id)
    if not cat or cat.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    now = datetime.utcnow()
    item = FinanceItem(
        id=uuid.uuid4(),
        category_id=payload.category_id,
        template_item_id=None,
        name=payload.name,
        direction=payload.direction,
        amount_pence=None,
        sort_order=payload.sort_order,
        created_at=now,
        updated_at=now,
    )
    db.add(item)
    db.flush()
    return _item_out(item)


def update_finance_item(case_id: uuid.UUID, item_id: uuid.UUID, payload: FinanceItemUpdate, db: Session) -> FinanceItemOut:
    item = db.get(FinanceItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    # Verify item belongs to this case.
    cat = db.get(FinanceCategory, item.category_id)
    if not cat or cat.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    if payload.name is not None:
        item.name = payload.name
    if payload.direction is not None:
        item.direction = payload.direction
    if payload.amount_pence is not None:
        item.amount_pence = payload.amount_pence
    elif "amount_pence" in payload.model_fields_set and payload.amount_pence is None:
        item.amount_pence = None
    if payload.sort_order is not None:
        item.sort_order = payload.sort_order
    item.updated_at = datetime.utcnow()
    db.flush()
    return _item_out(item)


def delete_finance_item(case_id: uuid.UUID, item_id: uuid.UUID, db: Session) -> None:
    item = db.get(FinanceItem, item_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    cat = db.get(FinanceCategory, item.category_id)
    if not cat or cat.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    db.delete(item)
    db.flush()
