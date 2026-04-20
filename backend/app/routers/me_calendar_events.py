"""In-app calendar REST API backed by Radicale (CalDAV)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.calendar_service import (
    list_merged_events,
    pick_default_owned_calendar_id,
    require_write,
    resolve_calendar_access,
    sync_remote_calendars_into_db,
)
from app.db import get_db
from app.deps import get_current_user
from app.models import User
from app.calendar_category import (
    delete_event_category_link,
    enrich_events_with_categories,
    set_event_category_link,
)
from app.radicale_calendar import (
    create_event_on_calendar,
    delete_event_on_principal,
    event_uid_from_href,
    load_event_on_principal,
    parse_caldav_event,
    parse_event_href,
    ref_to_href,
    update_event_on_principal,
)
from app.schemas import CalendarEventCreate, CalendarEventOut, CalendarEventPatch

router = APIRouter(prefix="/users/me/calendar", tags=["calendar"])


def _require_caldav(user: User) -> None:
    if not user.caldav_password_enc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Enable CalDAV under User settings to use the in-app calendar.",
        )


def _parse_range_param(value: str) -> datetime:
    s = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_calendar_ids(raw: str | None) -> list[uuid.UUID] | None:
    if not raw or not raw.strip():
        return None
    out: list[uuid.UUID] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        out.append(uuid.UUID(p))
    return out or None


@router.get("/events", response_model=list[CalendarEventOut])
def get_calendar_events(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start: str = Query(..., description="ISO8601 window start"),
    end: str = Query(..., description="ISO8601 window end"),
    calendar_ids: str | None = Query(None, description="Comma-separated calendar UUIDs; omit for all accessible"),
) -> list[CalendarEventOut]:
    _require_caldav(user)
    rs = _parse_range_param(start)
    re = _parse_range_param(end)
    ids = _parse_calendar_ids(calendar_ids)
    raw = list_merged_events(db, user, range_start=rs, range_end=re, calendar_ids=ids)
    return [CalendarEventOut.model_validate(x) for x in raw]


@router.post("/events", response_model=CalendarEventOut)
def post_calendar_event(
    body: CalendarEventCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarEventOut:
    _require_caldav(user)
    sync_remote_calendars_into_db(db, user)
    cal_id = body.calendar_id
    if cal_id is None:
        cal_id = pick_default_owned_calendar_id(db, user)
    access = resolve_calendar_access(db, user, cal_id)
    require_write(access)
    if not access.dav_user.caldav_password_enc:
        raise HTTPException(status_code=502, detail="Calendar owner CalDAV unavailable")
    raw = create_event_on_calendar(
        access.dav_user,
        access.calendar.radicale_slug,
        title=body.title,
        start=body.start,
        end=body.end,
        all_day=body.all_day,
        description=body.description,
        calendar_display_name=access.calendar.name,
        calendar_id=str(access.calendar.id),
    )
    raw["can_edit"] = True
    if body.category_id is not None:
        set_event_category_link(db, access.calendar.id, raw["uid"], body.category_id)
    enrich_events_with_categories(db, [raw])
    db.commit()
    return CalendarEventOut.model_validate(raw)


def _access_for_event(db: Session, user: User, event_ref: str):
    from app.calendar_service import get_calendar_for_owner

    href = ref_to_href(event_ref)
    owner_id, slug = parse_event_href(href)
    uc = get_calendar_for_owner(db, owner_id, slug)
    if uc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calendar not registered")
    access = resolve_calendar_access(db, user, uc.id)
    return access, href


@router.patch("/events/{event_ref}", response_model=CalendarEventOut)
def patch_calendar_event(
    event_ref: str,
    body: CalendarEventPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarEventOut:
    _require_caldav(user)
    access, href = _access_for_event(db, user, event_ref)
    require_write(access)
    updates = body.model_dump(exclude_unset=True)
    cat_set = "category_id" in updates
    new_cat = updates.pop("category_id", None) if cat_set else None

    if updates:
        raw = update_event_on_principal(
            access.dav_user,
            href,
            title=updates.get("title"),
            start=updates.get("start"),
            end=updates.get("end"),
            all_day=updates.get("all_day"),
            description=updates.get("description"),
            calendar_display_name=access.calendar.name,
            calendar_id=str(access.calendar.id),
        )
    else:
        ev = load_event_on_principal(access.dav_user, href)
        raw = parse_caldav_event(ev, access.calendar.name, calendar_id=str(access.calendar.id))
    raw["can_edit"] = access.permission != "read"

    if cat_set:
        set_event_category_link(db, access.calendar.id, raw["uid"], new_cat)

    enrich_events_with_categories(db, [raw])
    db.commit()
    return CalendarEventOut.model_validate(raw)


@router.delete("/events/{event_ref}", status_code=status.HTTP_204_NO_CONTENT)
def delete_calendar_event(
    event_ref: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    access, href = _access_for_event(db, user, event_ref)
    require_write(access)
    uid = event_uid_from_href(access.dav_user, href)
    delete_event_on_principal(access.dav_user, href)
    delete_event_category_link(db, access.calendar.id, uid)
    db.commit()
