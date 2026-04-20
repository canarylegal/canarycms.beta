"""User calendar metadata, sharing, and access checks (Radicale data stays on owner principal)."""
from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User, UserCalendar, UserCalendarShare, UserCalendarSubscription

Permission = Literal["owner", "read", "write"]


def default_calendar_title(user: User) -> str:
    n = (user.display_name or "User").strip() or "User"
    if n.endswith("'s"):
        n = n[:-2]
    # "James's Calendar" vs "Chris' Calendar"
    if n and n[-1].lower() == "s":
        return f"{n}' Calendar"
    return f"{n}'s Calendar"


def new_radicale_slug() -> str:
    return f"cal-{uuid.uuid4().hex[:10]}"


def sync_remote_calendars_into_db(db: Session, user: User) -> None:
    """Import Radicale collections missing from DB for this owner (by slug)."""
    if not user.caldav_password_enc:
        return
    from app.radicale_calendar import list_calendar_slugs_remote

    remote = list_calendar_slugs_remote(user)
    existing_slugs = set(
        db.execute(select(UserCalendar.radicale_slug).where(UserCalendar.owner_user_id == user.id)).scalars().all()
    )
    added = False
    for slug, display in remote:
        if slug in existing_slugs:
            continue
        disp = (display or slug)[:200]
        if slug == "canary" and disp in ("Canary", "canary"):
            disp = default_calendar_title(user)
        db.add(
            UserCalendar(
                owner_user_id=user.id,
                name=disp,
                radicale_slug=slug,
                is_public=False,
            )
        )
        added = True
    if added:
        db.commit()


def ensure_default_calendar(db: Session, user: User) -> UserCalendar:
    """Ensure at least one calendar row; create default Radicale collection if principal is empty."""
    from app.radicale_calendar import ensure_calendar_remote

    sync_remote_calendars_into_db(db, user)
    row = db.execute(select(UserCalendar).where(UserCalendar.owner_user_id == user.id).limit(1)).scalar_one_or_none()
    if row:
        return row
    slug = "canary"
    title = default_calendar_title(user)
    ensure_calendar_remote(user, slug=slug, display_name=title)
    row = UserCalendar(owner_user_id=user.id, name=title, radicale_slug=slug, is_public=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_calendar_for_owner(db: Session, owner_id: uuid.UUID, slug: str) -> UserCalendar | None:
    return db.execute(
        select(UserCalendar).where(UserCalendar.owner_user_id == owner_id, UserCalendar.radicale_slug == slug)
    ).scalar_one_or_none()


@dataclass(frozen=True)
class CalendarAccess:
    calendar: UserCalendar
    permission: Permission
    dav_user: User


def resolve_calendar_access(db: Session, requesting: User, calendar_id: uuid.UUID) -> CalendarAccess:
    uc = db.get(UserCalendar, calendar_id)
    if not uc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calendar not found")

    if uc.owner_user_id == requesting.id:
        owner = requesting
        return CalendarAccess(uc, "owner", owner)

    share = db.execute(
        select(UserCalendarShare).where(
            UserCalendarShare.calendar_id == calendar_id,
            UserCalendarShare.grantee_user_id == requesting.id,
        )
    ).scalar_one_or_none()
    if share:
        owner = db.get(User, uc.owner_user_id)
        if not owner:
            raise HTTPException(status_code=404, detail="Calendar owner missing")
        return CalendarAccess(uc, "write" if share.can_write else "read", owner)

    sub = db.execute(
        select(UserCalendarSubscription).where(
            UserCalendarSubscription.calendar_id == calendar_id,
            UserCalendarSubscription.subscriber_user_id == requesting.id,
        )
    ).scalar_one_or_none()
    if sub and uc.is_public:
        owner = db.get(User, uc.owner_user_id)
        if not owner:
            raise HTTPException(status_code=404, detail="Calendar owner missing")
        return CalendarAccess(uc, "read", owner)

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access to this calendar")


def list_accessible_calendars(
    db: Session,
    requesting: User,
    *,
    filter_ids: list[uuid.UUID] | None = None,
) -> list[CalendarAccess]:
    owned = db.execute(select(UserCalendar).where(UserCalendar.owner_user_id == requesting.id)).scalars().all()

    shared_ids = db.execute(
        select(UserCalendar, UserCalendarShare.can_write)
        .join(UserCalendarShare, UserCalendarShare.calendar_id == UserCalendar.id)
        .where(UserCalendarShare.grantee_user_id == requesting.id)
    ).all()

    subscribed = db.execute(
        select(UserCalendar)
        .join(UserCalendarSubscription, UserCalendarSubscription.calendar_id == UserCalendar.id)
        .where(
            UserCalendarSubscription.subscriber_user_id == requesting.id,
            UserCalendar.is_public.is_(True),  # noqa: E712
        )
    ).scalars().all()

    out: list[CalendarAccess] = []
    for uc in owned:
        if filter_ids is not None and uc.id not in filter_ids:
            continue
        out.append(CalendarAccess(uc, "owner", requesting))

    for uc, can_write in shared_ids:
        if filter_ids is not None and uc.id not in filter_ids:
            continue
        owner = db.get(User, uc.owner_user_id)
        if not owner:
            continue
        perm: Permission = "write" if can_write else "read"
        out.append(CalendarAccess(uc, perm, owner))

    for uc in subscribed:
        if filter_ids is not None and uc.id not in filter_ids:
            continue
        if any(a.calendar.id == uc.id for a in out):
            continue
        owner = db.get(User, uc.owner_user_id)
        if not owner:
            continue
        out.append(CalendarAccess(uc, "read", owner))

    return out


def require_write(access: CalendarAccess) -> None:
    if access.permission == "read":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Read-only access to this calendar")


def list_merged_events(
    db: Session,
    requesting: User,
    *,
    range_start: datetime,
    range_end: datetime,
    calendar_ids: list[uuid.UUID] | None,
):
    from app.radicale_calendar import list_events_for_multiple_slugs

    # Sync runs on GET /users/me/calendars; avoid a second Radicale list on every events fetch.
    accesses = list_accessible_calendars(db, requesting, filter_ids=calendar_ids)
    by_owner: dict[uuid.UUID, list[CalendarAccess]] = defaultdict(list)
    for a in accesses:
        if not a.dav_user.caldav_password_enc:
            continue
        by_owner[a.dav_user.id].append(a)

    out: list[dict] = []
    for accs in by_owner.values():
        dav_user = accs[0].dav_user
        items = [(a.calendar.radicale_slug, a.calendar.name, str(a.calendar.id)) for a in accs]
        can_edit = {str(a.calendar.id): a.permission != "read" for a in accs}
        for item in list_events_for_multiple_slugs(dav_user, items, range_start, range_end):
            cid = item.get("calendar_id")
            item["can_edit"] = can_edit.get(str(cid), False) if cid is not None else False
            out.append(item)
    from app.calendar_category import enrich_events_with_categories

    enrich_events_with_categories(db, out)
    return out


def pick_default_owned_calendar_id(db: Session, user: User) -> uuid.UUID:
    sync_remote_calendars_into_db(db, user)
    rows = db.execute(
        select(UserCalendar.id).where(UserCalendar.owner_user_id == user.id).order_by(UserCalendar.created_at.asc())
    ).scalars().all()
    if not rows:
        return ensure_default_calendar(db, user).id
    return rows[0]
