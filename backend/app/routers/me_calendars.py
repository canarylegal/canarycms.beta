"""User calendar CRUD, sharing, public directory, and subscriptions."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.calendar_category import normalize_calendar_color
from app.calendar_service import (
    ensure_default_calendar,
    list_accessible_calendars,
    new_radicale_slug,
    resolve_calendar_access,
    sync_remote_calendars_into_db,
)
from app.db import get_db
from app.deps import get_current_user
from app.models import User, UserCalendar, UserCalendarCategory, UserCalendarShare, UserCalendarSubscription
from app.radicale_calendar import delete_calendar_remote, ensure_calendar_remote
from app.schemas import (
    CalendarCategoryCreate,
    CalendarCategoryOut,
    CalendarCategoryPatch,
    CalendarCreate,
    CalendarDirectoryRow,
    CalendarOwnerMini,
    CalendarPatch,
    CalendarShareCreate,
    CalendarShareOut,
    CalendarSubscribeIn,
    UserCalendarOut,
)

router = APIRouter(prefix="/users/me/calendars", tags=["calendars"])


def _require_caldav(user: User) -> None:
    if not user.caldav_password_enc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Enable CalDAV under User settings to use calendars.",
        )


def _mini(u: User) -> CalendarOwnerMini:
    return CalendarOwnerMini(id=u.id, display_name=u.display_name, email=u.email)  # type: ignore[arg-type]


@router.get("", response_model=list[UserCalendarOut])
def list_my_calendars(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[UserCalendarOut]:
    _require_caldav(user)
    sync_remote_calendars_into_db(db, user)
    out: list[UserCalendarOut] = []

    owned = db.execute(select(UserCalendar).where(UserCalendar.owner_user_id == user.id)).scalars().all()
    for uc in owned:
        own = db.get(User, uc.owner_user_id)
        assert own
        out.append(
            UserCalendarOut(
                id=uc.id,
                name=uc.name,
                radicale_slug=uc.radicale_slug,
                is_public=uc.is_public,
                access="owner",
                source="owned",
                owner=_mini(own),
            )
        )

    shared_rows = db.execute(
        select(UserCalendar, UserCalendarShare.can_write)
        .join(UserCalendarShare, UserCalendarShare.calendar_id == UserCalendar.id)
        .where(UserCalendarShare.grantee_user_id == user.id)
    ).all()
    for uc, can_write in shared_rows:
        own = db.get(User, uc.owner_user_id)
        if not own:
            continue
        out.append(
            UserCalendarOut(
                id=uc.id,
                name=uc.name,
                radicale_slug=uc.radicale_slug,
                is_public=uc.is_public,
                access="write" if can_write else "read",
                source="share",
                owner=_mini(own),
            )
        )

    subscribed = db.execute(
        select(UserCalendar)
        .join(UserCalendarSubscription, UserCalendarSubscription.calendar_id == UserCalendar.id)
        .where(UserCalendarSubscription.subscriber_user_id == user.id, UserCalendar.is_public.is_(True))  # noqa: E712
    ).scalars().all()
    have_ids = {x.id for x in out}
    for uc in subscribed:
        if uc.id in have_ids:
            continue
        own = db.get(User, uc.owner_user_id)
        if not own:
            continue
        out.append(
            UserCalendarOut(
                id=uc.id,
                name=uc.name,
                radicale_slug=uc.radicale_slug,
                is_public=uc.is_public,
                access="read",
                source="subscription",
                owner=_mini(own),
            )
        )

    return out


@router.post("", response_model=UserCalendarOut)
def create_my_calendar(
    body: CalendarCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserCalendarOut:
    _require_caldav(user)
    sync_remote_calendars_into_db(db, user)
    name = body.name.strip()
    slug = new_radicale_slug()
    for _ in range(25):
        exists = db.execute(
            select(UserCalendar.id).where(UserCalendar.owner_user_id == user.id, UserCalendar.radicale_slug == slug)
        ).first()
        if not exists:
            break
        slug = new_radicale_slug()
    else:
        raise HTTPException(status_code=500, detail="Could not allocate calendar id")
    ensure_calendar_remote(user, slug=slug, display_name=name)
    row = UserCalendar(owner_user_id=user.id, name=name[:200], radicale_slug=slug, is_public=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return UserCalendarOut(
        id=row.id,
        name=row.name,
        radicale_slug=row.radicale_slug,
        is_public=row.is_public,
        access="owner",
        source="owned",
        owner=_mini(user),
    )


@router.patch("/{calendar_id}", response_model=UserCalendarOut)
def patch_my_calendar(
    calendar_id: uuid.UUID,
    body: CalendarPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserCalendarOut:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change calendar settings")
    uc = access.calendar
    if body.name is not None:
        uc.name = body.name.strip()[:200]
    if body.is_public is not None:
        uc.is_public = body.is_public
    uc.updated_at = datetime.now(timezone.utc)
    db.add(uc)
    db.commit()
    db.refresh(uc)
    own = db.get(User, uc.owner_user_id)
    assert own
    return UserCalendarOut(
        id=uc.id,
        name=uc.name,
        radicale_slug=uc.radicale_slug,
        is_public=uc.is_public,
        access="owner",
        source="owned",
        owner=_mini(own),
    )


@router.delete("/{calendar_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_my_calendar(
    calendar_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the calendar owner can delete this calendar")
    uc = access.calendar
    owned_n = db.execute(
        select(func.count()).select_from(UserCalendar).where(UserCalendar.owner_user_id == user.id)
    ).scalar_one()
    last_owned = owned_n <= 1

    delete_calendar_remote(user, uc.radicale_slug)
    db.delete(uc)
    db.commit()

    if last_owned:
        ensure_default_calendar(db, user)
    return None


@router.get("/{calendar_id}/categories", response_model=list[CalendarCategoryOut])
def list_calendar_categories(
    calendar_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CalendarCategoryOut]:
    _require_caldav(user)
    resolve_calendar_access(db, user, calendar_id)
    rows = (
        db.execute(
            select(UserCalendarCategory)
            .where(UserCalendarCategory.calendar_id == calendar_id)
            .order_by(UserCalendarCategory.name.asc())
        )
        .scalars()
        .all()
    )
    return [CalendarCategoryOut(id=r.id, calendar_id=r.calendar_id, name=r.name, color=r.color) for r in rows]


@router.post("/{calendar_id}/categories", response_model=CalendarCategoryOut)
def create_calendar_category(
    calendar_id: uuid.UUID,
    body: CalendarCategoryCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarCategoryOut:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the calendar owner can create categories")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    col = normalize_calendar_color(body.color)
    row = UserCalendarCategory(calendar_id=calendar_id, name=name[:120], color=col)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A category with this name already exists") from None
    db.refresh(row)
    return CalendarCategoryOut(id=row.id, calendar_id=row.calendar_id, name=row.name, color=row.color)


@router.patch("/{calendar_id}/categories/{category_id}", response_model=CalendarCategoryOut)
def patch_calendar_category(
    calendar_id: uuid.UUID,
    category_id: uuid.UUID,
    body: CalendarCategoryPatch,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CalendarCategoryOut:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the calendar owner can edit categories")
    row = db.get(UserCalendarCategory, category_id)
    if not row or row.calendar_id != calendar_id:
        raise HTTPException(status_code=404, detail="Category not found")
    data = body.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        row.name = data["name"].strip()[:120]
    if "color" in data:
        row.color = normalize_calendar_color(data["color"])
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A category with this name already exists") from None
    db.refresh(row)
    return CalendarCategoryOut(id=row.id, calendar_id=row.calendar_id, name=row.name, color=row.color)


@router.delete("/{calendar_id}/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_calendar_category(
    calendar_id: uuid.UUID,
    category_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the calendar owner can delete categories")
    row = db.get(UserCalendarCategory, category_id)
    if not row or row.calendar_id != calendar_id:
        raise HTTPException(status_code=404, detail="Category not found")
    db.delete(row)
    db.commit()
    return None


@router.get("/directory", response_model=list[CalendarDirectoryRow])
def search_calendar_directory(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    q: str = Query(..., min_length=1, max_length=100),
) -> list[CalendarDirectoryRow]:
    _require_caldav(user)
    sync_remote_calendars_into_db(db, user)
    term = f"%{q.strip()}%"
    accessible = list_accessible_calendars(db, user, filter_ids=None)
    have_ids = {a.calendar.id for a in accessible}

    share_cal_ids = db.execute(
        select(UserCalendarShare.calendar_id).where(UserCalendarShare.grantee_user_id == user.id)
    ).scalars().all()
    share_set = set(share_cal_ids)

    stmt = (
        select(UserCalendar)
        .where(
            UserCalendar.owner_user_id != user.id,
            UserCalendar.name.ilike(term),
            or_(
                UserCalendar.is_public.is_(True),  # noqa: E712
                UserCalendar.id.in_(select(UserCalendarShare.calendar_id).where(UserCalendarShare.grantee_user_id == user.id)),
            ),
        )
        .limit(40)
    )
    rows = db.execute(stmt).scalars().all()
    out: list[CalendarDirectoryRow] = []
    for uc in rows:
        own = db.get(User, uc.owner_user_id)
        if not own:
            continue
        shared_directly = uc.id in share_set
        already = uc.id in have_ids
        can_sub = bool(uc.is_public and uc.id not in have_ids)
        out.append(
            CalendarDirectoryRow(
                id=uc.id,
                name=uc.name,
                owner=_mini(own),
                is_public=uc.is_public,
                shared_directly=shared_directly,
                already_in_my_list=already,
                can_subscribe=can_sub,
            )
        )
    return out


@router.post("/subscribe", status_code=status.HTTP_204_NO_CONTENT)
def subscribe_public_calendar(
    body: CalendarSubscribeIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    uc = db.get(UserCalendar, body.calendar_id)
    if not uc or not uc.is_public:
        raise HTTPException(status_code=404, detail="Public calendar not found")
    if uc.owner_user_id == user.id:
        raise HTTPException(status_code=400, detail="You already own this calendar")
    if db.execute(select(UserCalendarSubscription).where(
            UserCalendarSubscription.calendar_id == uc.id,
            UserCalendarSubscription.subscriber_user_id == user.id,
    )).scalar_one_or_none():
        return None
    db.add(UserCalendarSubscription(subscriber_user_id=user.id, calendar_id=uc.id))
    db.commit()
    return None


@router.delete("/{calendar_id}/subscription", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe_calendar(
    calendar_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    db.execute(
        delete(UserCalendarSubscription).where(
            UserCalendarSubscription.calendar_id == calendar_id,
            UserCalendarSubscription.subscriber_user_id == user.id,
        )
    )
    db.commit()
    return None


@router.get("/{calendar_id}/shares", response_model=list[CalendarShareOut])
def list_calendar_shares(
    calendar_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CalendarShareOut]:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can list shares")
    rows = db.execute(select(UserCalendarShare).where(UserCalendarShare.calendar_id == calendar_id)).scalars().all()
    out: list[CalendarShareOut] = []
    for sh in rows:
        g = db.get(User, sh.grantee_user_id)
        if g:
            out.append(
                CalendarShareOut(
                    grantee_user_id=g.id,
                    grantee_display_name=g.display_name,
                    grantee_email=g.email,  # type: ignore[arg-type]
                    can_write=sh.can_write,
                )
            )
    return out


@router.post("/{calendar_id}/shares", status_code=status.HTTP_204_NO_CONTENT)
def add_calendar_share(
    calendar_id: uuid.UUID,
    body: CalendarShareCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can share")
    grantee = db.get(User, body.grantee_user_id)
    if not grantee or not grantee.is_active:
        raise HTTPException(status_code=404, detail="User not found")
    if grantee.id == user.id:
        raise HTTPException(status_code=400, detail="Cannot share with yourself")
    existing = db.execute(
        select(UserCalendarShare).where(
            UserCalendarShare.calendar_id == calendar_id,
            UserCalendarShare.grantee_user_id == grantee.id,
        )
    ).scalar_one_or_none()
    if existing:
        existing.can_write = body.can_write
        db.add(existing)
    else:
        db.add(UserCalendarShare(calendar_id=calendar_id, grantee_user_id=grantee.id, can_write=body.can_write))
    db.commit()
    return None


@router.delete("/{calendar_id}/shares/{grantee_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_calendar_share(
    calendar_id: uuid.UUID,
    grantee_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _require_caldav(user)
    access = resolve_calendar_access(db, user, calendar_id)
    if access.permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can remove shares")
    db.execute(
        delete(UserCalendarShare).where(
            UserCalendarShare.calendar_id == calendar_id,
            UserCalendarShare.grantee_user_id == grantee_id,
        )
    )
    db.commit()
    return None
