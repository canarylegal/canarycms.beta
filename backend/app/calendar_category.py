"""Canary-only calendar categories (not synced to Radicale)."""
from __future__ import annotations

import re
import uuid

from fastapi import HTTPException, status
from sqlalchemy import delete, select, tuple_
from sqlalchemy.orm import Session

from app.models import CalendarEventCategory, UserCalendarCategory


def normalize_calendar_color(value: str | None) -> str | None:
    if value is None:
        return None
    s = value.strip()
    if not s:
        return None
    if s.startswith("#"):
        s = s[1:]
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", s):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Color must be empty or #RRGGBB (6 hex digits)",
        )
    return f"#{s.upper()}"


def require_category_on_calendar(db: Session, calendar_id: uuid.UUID, category_id: uuid.UUID) -> UserCalendarCategory:
    cat = db.get(UserCalendarCategory, category_id)
    if not cat or cat.calendar_id != calendar_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found on this calendar")
    return cat


def set_event_category_link(
    db: Session,
    calendar_id: uuid.UUID,
    event_uid: str,
    category_id: uuid.UUID | None,
) -> None:
    db.execute(
        delete(CalendarEventCategory).where(
            CalendarEventCategory.calendar_id == calendar_id,
            CalendarEventCategory.event_uid == event_uid,
        )
    )
    if category_id is not None:
        require_category_on_calendar(db, calendar_id, category_id)
        db.add(
            CalendarEventCategory(
                calendar_id=calendar_id,
                event_uid=event_uid,
                category_id=category_id,
            )
        )


def delete_event_category_link(db: Session, calendar_id: uuid.UUID, event_uid: str) -> None:
    db.execute(
        delete(CalendarEventCategory).where(
            CalendarEventCategory.calendar_id == calendar_id,
            CalendarEventCategory.event_uid == event_uid,
        )
    )


def enrich_events_with_categories(db: Session, items: list[dict]) -> None:
    pairs: list[tuple[uuid.UUID, str]] = []
    for it in items:
        cid = it.get("calendar_id")
        uid = it.get("uid")
        if not cid or not uid:
            continue
        try:
            pairs.append((uuid.UUID(str(cid)), str(uid)))
        except ValueError:
            continue
    if not pairs:
        return
    uniq = list(dict.fromkeys(pairs))
    stmt = (
        select(CalendarEventCategory, UserCalendarCategory)
        .outerjoin(UserCalendarCategory, UserCalendarCategory.id == CalendarEventCategory.category_id)
        .where(tuple_(CalendarEventCategory.calendar_id, CalendarEventCategory.event_uid).in_(uniq))
    )
    by_key: dict[tuple[uuid.UUID, str], UserCalendarCategory | None] = {}
    for link, cat in db.execute(stmt).all():
        by_key[(link.calendar_id, link.event_uid)] = cat

    for it in items:
        cid = it.get("calendar_id")
        uid = it.get("uid")
        if not cid or not uid:
            continue
        try:
            key = (uuid.UUID(str(cid)), str(uid))
        except ValueError:
            continue
        cat = by_key.get(key)
        if cat is None:
            it["category_id"] = None
            it["category_name"] = None
            it["category_color"] = None
            continue
        it["category_id"] = str(cat.id)
        it["category_name"] = cat.name
        it["category_color"] = cat.color
