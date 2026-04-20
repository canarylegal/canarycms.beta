"""Read/write Radicale CalDAV on behalf of a Canary user (server-side client)."""
from __future__ import annotations

import base64
import os
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import unquote, urlparse

import caldav
from caldav.lib.error import AuthorizationError
from fastapi import HTTPException, status
from icalendar import Calendar as ICal
from icalendar import Event as ICalEvent

from app.email_crypt import decrypt_password
from app.models import User


def _internal_base() -> str:
    return (os.getenv("RADICALE_INTERNAL_URL") or "http://radicale:5232").strip().rstrip("/")


def principal_url_for_user(user_id: uuid.UUID) -> str:
    return f"{_internal_base()}/{user_id}/"


def _caldav_client(user: User) -> caldav.DAVClient:
    assert user.caldav_password_enc
    pwd = decrypt_password(user.caldav_password_enc)
    return caldav.DAVClient(
        url=principal_url_for_user(user.id),
        username=str(user.id),
        password=pwd,
    )


def href_to_ref(href: str) -> str:
    return base64.urlsafe_b64encode(href.encode("utf-8")).decode("ascii").rstrip("=")


def ref_to_href(ref: str) -> str:
    pad = "=" * (-len(ref) % 4)
    return base64.urlsafe_b64decode(ref + pad).decode("utf-8")


def _principal(user: User) -> caldav.Principal:
    return _caldav_client(user).principal()


def _slug_from_calendar(cal: caldav.Calendar) -> str:
    u = str(cal.url).rstrip("/")
    return u.split("/")[-1]


def list_calendar_slugs_remote(user: User) -> list[tuple[str, str]]:
    """Return (radicale_slug, display_name) for each collection on the principal."""
    try:
        principal = _principal(user)
        out: list[tuple[str, str]] = []
        for cal in principal.calendars():
            slug = _slug_from_calendar(cal)
            try:
                disp = cal.name or slug
            except Exception:
                disp = slug
            out.append((slug, disp))
        return out
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def ensure_calendar_remote(user: User, *, slug: str, display_name: str) -> caldav.Calendar:
    try:
        principal = _principal(user)
        for cal in principal.calendars():
            if _slug_from_calendar(cal) == slug:
                return cal
        return principal.make_calendar(name=display_name, cal_id=slug)
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def get_caldav_calendar(user: User, slug: str) -> caldav.Calendar | None:
    try:
        principal = _principal(user)
        for cal in principal.calendars():
            if _slug_from_calendar(cal) == slug:
                return cal
        return None
    except Exception:
        return None


def delete_calendar_remote(user: User, slug: str) -> None:
    """Remove the CalDAV calendar collection from Radicale. No-op if it is already absent."""
    cal = get_caldav_calendar(user, slug)
    if cal is None:
        return
    try:
        cal.delete()
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def _caldav_http_exc(e: Exception) -> HTTPException:
    if isinstance(e, AuthorizationError):
        return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Radicale rejected credentials")
    msg = str(e) or type(e).__name__
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"CalDAV error: {msg}")


def parse_event_href(href: str) -> tuple[uuid.UUID, str]:
    path = urlparse(href).path
    parts = [unquote(p) for p in path.split("/") if p]
    if len(parts) < 3:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid event URL")
    try:
        owner_id = uuid.UUID(parts[0])
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid event URL") from e
    return owner_id, parts[1]


def load_event_on_principal(owner: User, href: str) -> caldav.Event:
    client = _caldav_client(owner)
    principal = client.principal()
    last_err: Exception | None = None
    for cal in principal.calendars():
        try:
            ev = cal.event_by_url(href)
            ev.load()
            return ev
        except Exception as e:
            last_err = e
            continue
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found") from last_err


def _format_end_dt(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _at_local_midnight(dt: datetime) -> bool:
    return dt.hour == 0 and dt.minute == 0 and dt.second == 0 and dt.microsecond == 0


def _midnight_span_all_day_dates(dtstart: datetime, dtend: object) -> tuple[date, date] | None:
    """Many clients encode all-day as DATE-TIME at 00:00 with exclusive end (RFC-style). Treat as all-day."""
    if not isinstance(dtend, datetime):
        return None
    if dtstart.tzinfo != dtend.tzinfo:
        return None
    if not _at_local_midnight(dtstart) or not _at_local_midnight(dtend):
        return None
    d0 = dtstart.date()
    d1 = dtend.date()
    if d1 <= d0:
        return None
    return (d0, d1)


def parse_caldav_event(
    ev: caldav.Event,
    calendar_name: str | None = None,
    *,
    calendar_id: str | None = None,
) -> dict[str, Any]:
    ev.load()
    ical = ICal.from_ical(ev.data)
    vevent = None
    for c in ical.walk("VEVENT"):
        vevent = c
        break
    if vevent is None:
        raise ValueError("No VEVENT in calendar object")

    uid_raw = vevent.get("uid")
    uid = str(uid_raw) if uid_raw else str(ev.url)
    summary_raw = vevent.get("summary")
    summary = str(summary_raw) if summary_raw else "(no title)"
    desc = vevent.get("description")
    description = str(desc) if desc else None

    dtstart = vevent.decoded("DTSTART")
    dtend_prop = vevent.get("dtend")
    dtend_decoded = vevent.decoded("DTEND") if dtend_prop else None

    all_day = not isinstance(dtstart, datetime)
    midnight_span: tuple[date, date] | None = None
    if not all_day and isinstance(dtstart, datetime) and dtend_decoded is not None:
        midnight_span = _midnight_span_all_day_dates(dtstart, dtend_decoded)
        if midnight_span is not None:
            all_day = True

    if all_day:
        if midnight_span is not None:
            d0, d1 = midnight_span
        else:
            d0 = dtstart.date() if isinstance(dtstart, datetime) else dtstart
            if dtend_decoded:
                d1 = dtend_decoded.date() if isinstance(dtend_decoded, datetime) else dtend_decoded
            else:
                d1 = d0 + timedelta(days=1)
        # RFC 5545: DTEND is exclusive; same-day DTSTART/DTEND is invalid — treat as one local day.
        if d1 <= d0:
            d1 = d0 + timedelta(days=1)
        start_s = d0.isoformat()
        end_s = d1.isoformat()
    else:
        if not isinstance(dtstart, datetime):
            st = dtstart if isinstance(dtstart, date) else datetime.now(timezone.utc).date()
            dtstart = datetime.combine(st, datetime.min.time(), tzinfo=timezone.utc)
        if dtstart.tzinfo is None:
            dtstart = dtstart.replace(tzinfo=timezone.utc)
        start_s = _format_end_dt(dtstart)
        if dtend_decoded:
            end = dtend_decoded
            if isinstance(end, date) and not isinstance(end, datetime):
                end = datetime.combine(end, datetime.min.time(), tzinfo=timezone.utc)
            if isinstance(end, datetime) and end.tzinfo is None:
                end = end.replace(tzinfo=timezone.utc)
            end_s = _format_end_dt(end)
        else:
            end_s = _format_end_dt(dtstart + timedelta(hours=1))

    href = str(ev.url)
    out: dict[str, Any] = {
        "id": href_to_ref(href),
        "uid": uid,
        "title": summary,
        "start": start_s,
        "end": end_s,
        "all_day": all_day,
        "description": description,
        "calendar_name": calendar_name,
    }
    if calendar_id:
        out["calendar_id"] = calendar_id
    return out


def list_events_for_multiple_slugs(
    dav_user: User,
    items: list[tuple[str, str, str]],
    range_start: datetime,
    range_end: datetime,
) -> list[dict[str, Any]]:
    """Fetch events for many calendars with one principal + one calendar listing (not N×)."""
    if not items:
        return []
    try:
        principal = _principal(dav_user)
        by_slug: dict[str, caldav.Calendar] = {}
        for cal in principal.calendars():
            by_slug[_slug_from_calendar(cal)] = cal

        out: list[dict[str, Any]] = []
        for slug, display_name, calendar_id in items:
            cal = by_slug.get(slug)
            if not cal:
                continue
            evs = cal.date_search(start=range_start, end=range_end, expand=True)
            for raw in evs:
                try:
                    out.append(
                        parse_caldav_event(
                            raw,
                            display_name,
                            calendar_id=str(calendar_id),
                        )
                    )
                except Exception:
                    continue
        return out
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def list_events_on_calendar(
    dav_user: User,
    slug: str,
    range_start: datetime,
    range_end: datetime,
    *,
    calendar_display_name: str,
    calendar_id: str,
) -> list[dict[str, Any]]:
    return list_events_for_multiple_slugs(
        dav_user,
        [(slug, calendar_display_name, calendar_id)],
        range_start,
        range_end,
    )


def create_event_on_calendar(
    dav_user: User,
    slug: str,
    *,
    title: str,
    start: datetime | date,
    end: datetime | date,
    all_day: bool,
    description: str | None,
    calendar_display_name: str,
    calendar_id: str,
) -> dict[str, Any]:
    try:
        cal = get_caldav_calendar(dav_user, slug)
        if not cal:
            raise HTTPException(status_code=404, detail="Calendar collection not found on server")
        uid = f"{uuid.uuid4()}@canary"
        ical = ICal()
        ve = ICalEvent()
        ve.add("uid", uid)
        ve.add("summary", title)
        if description:
            ve.add("description", description)
        if all_day:
            sd = start if isinstance(start, date) else start.date()
            ed = end if isinstance(end, date) else end.date()
            if ed <= sd:
                ed = sd + timedelta(days=1)
            ve.add("dtstart", sd)
            ve.add("dtend", ed)
        else:
            s = start
            e = end
            if isinstance(s, date) and not isinstance(s, datetime):
                s = datetime.combine(s, datetime.min.time(), tzinfo=timezone.utc)
            if isinstance(e, date) and not isinstance(e, datetime):
                e = datetime.combine(e, datetime.min.time(), tzinfo=timezone.utc)
            if s.tzinfo is None:
                s = s.replace(tzinfo=timezone.utc)
            if e.tzinfo is None:
                e = e.replace(tzinfo=timezone.utc)
            ve.add("dtstart", s)
            ve.add("dtend", e)
        ical.add_component(ve)
        raw = ical.to_ical()
        payload = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        ev = cal.add_event(payload)
        ev.load()
        return parse_caldav_event(ev, calendar_display_name, calendar_id=str(calendar_id))
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def _pop_dt_components(vevent: ICalEvent) -> None:
    for key in list(vevent.keys()):
        if key.lower() in ("dtstart", "dtend"):
            del vevent[key]


def update_event_on_principal(
    owner: User,
    href: str,
    *,
    title: str | None = None,
    start: datetime | date | None = None,
    end: datetime | date | None = None,
    all_day: bool | None = None,
    description: str | None = None,
    calendar_display_name: str | None = None,
    calendar_id: str | None = None,
) -> dict[str, Any]:
    ev = load_event_on_principal(owner, href)
    try:
        ev.load()
        ical = ICal.from_ical(ev.data)
        vevent = None
        for c in ical.walk("VEVENT"):
            vevent = c
            break
        if vevent is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid event data")

        cur_dt = vevent.decoded("DTSTART")
        cur_all = not isinstance(cur_dt, datetime)

        if title is not None:
            vevent["summary"] = title
        if description is not None:
            if description == "":
                if "description" in vevent:
                    del vevent["description"]
            else:
                vevent["description"] = description

        use_all = cur_all if all_day is None else all_day
        if start is not None or end is not None or all_day is not None:
            ds = vevent.decoded("DTSTART")
            de = vevent.decoded("DTEND") if vevent.get("dtend") else None
            ns = start if start is not None else ds
            ne = end if end is not None else (de if de is not None else ds)
            _pop_dt_components(vevent)
            if use_all:
                sd = ns if isinstance(ns, date) else ns.date()
                ed = ne if isinstance(ne, date) else ne.date()
                if ed <= sd:
                    ed = sd + timedelta(days=1)
                vevent.add("dtstart", sd)
                vevent.add("dtend", ed)
            else:
                s = ns
                e = ne
                if isinstance(s, date) and not isinstance(s, datetime):
                    s = datetime.combine(s, datetime.min.time(), tzinfo=timezone.utc)
                if isinstance(e, date) and not isinstance(e, datetime):
                    e = datetime.combine(e, datetime.min.time(), tzinfo=timezone.utc)
                if isinstance(s, datetime) and s.tzinfo is None:
                    s = s.replace(tzinfo=timezone.utc)
                if isinstance(e, datetime) and e.tzinfo is None:
                    e = e.replace(tzinfo=timezone.utc)
                vevent.add("dtstart", s)
                vevent.add("dtend", e)

        raw_out = ical.to_ical()
        ev.data = raw_out.decode("utf-8") if isinstance(raw_out, bytes) else raw_out
        ev.save()
        ev.load()
        cname = calendar_display_name
        if cname is None:
            try:
                p = ev.parent
                if p is not None:
                    cname = p.name
            except Exception:
                pass
        return parse_caldav_event(ev, cname, calendar_id=calendar_id)
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e


def event_uid_from_href(owner: User, href: str) -> str:
    ev = load_event_on_principal(owner, href)
    ev.load()
    ical = ICal.from_ical(ev.data)
    for c in ical.walk("VEVENT"):
        uid_raw = c.get("uid")
        return str(uid_raw) if uid_raw else str(ev.url)
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid event data")


def delete_event_on_principal(owner: User, href: str) -> None:
    ev = load_event_on_principal(owner, href)
    try:
        ev.delete()
    except HTTPException:
        raise
    except Exception as e:
        raise _caldav_http_exc(e) from e
