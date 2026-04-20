"""Create/update case tasks for calendar-tracked case events; refresh priorities by UK working days."""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Case, CaseEvent, CaseTask, CaseTaskStatus, User
from app.uk_working_days import is_uk_business_day

log = logging.getLogger(__name__)

UK = ZoneInfo("Europe/London")


def uk_business_days_after_today_through_event(*, today: date, event_date: date) -> int:
    """UK business days strictly after ``today`` and on or before ``event_date`` (E&W calendar)."""
    if event_date < today:
        return 0
    n = 0
    d = today + timedelta(days=1)
    while d <= event_date:
        if is_uk_business_day(d):
            n += 1
        d += timedelta(days=1)
    return n


def priority_for_tracked_event(*, uk_today: date, event_date: date) -> str:
    """``high`` if overdue or fewer than 5 UK working days remain (see uk_business_days_after_today_through_event)."""
    if event_date < uk_today:
        return "high"
    remaining = uk_business_days_after_today_through_event(today=uk_today, event_date=event_date)
    if remaining < 5:
        return "high"
    return "normal"


def due_datetime_utc_for_event_date(event_date: date) -> datetime:
    dt_local = datetime.combine(event_date, time(9, 0), tzinfo=UK)
    return dt_local.astimezone(timezone.utc)


def _event_date_as_date(ed: date | datetime) -> date:
    if isinstance(ed, datetime):
        return ed.date()
    return ed


def sync_tracked_case_event_task(
    db: Session,
    *,
    case: Case,
    case_event: CaseEvent,
    actor_user_id: uuid.UUID,
) -> None:
    """Ensure a task exists for a tracked event with date; remove when untracked. Idempotent."""
    track = bool(case_event.track_in_calendar and case_event.event_date is not None)
    linked = (
        db.execute(select(CaseTask).where(CaseTask.case_event_id == case_event.id)).scalars().first()
    )

    if not track:
        if linked is not None:
            db.delete(linked)
        return

    ed = _event_date_as_date(case_event.event_date)  # type: ignore[arg-type]
    assignee = case.fee_earner_user_id or case.created_by
    assignee_user = db.get(User, assignee) if assignee else None
    if not assignee_user or not assignee_user.is_active:
        log.warning(
            "event_tracked_task: no active assignee for case_event_id=%s case_id=%s",
            case_event.id,
            case.id,
        )
        return

    uk_today = datetime.now(UK).date()
    prio = priority_for_tracked_event(uk_today=uk_today, event_date=ed)
    due = due_datetime_utc_for_event_date(ed)
    title = f"Case event: {case_event.name}"[:300]
    desc = f"Tracked matter event ({case.case_number})."

    if linked is not None:
        if linked.status != CaseTaskStatus.open:
            return
        linked.title = title
        linked.description = desc
        linked.due_at = due
        linked.priority = prio
        linked.assigned_to_user_id = assignee
        linked.updated_at = datetime.utcnow()
        db.add(linked)
        return

    task = CaseTask(
        id=uuid.uuid4(),
        case_id=case.id,
        created_by_user_id=actor_user_id,
        title=title,
        description=desc,
        due_at=due,
        assigned_to_user_id=assignee,
        priority=prio,
        is_private=False,
        case_event_id=case_event.id,
        status=CaseTaskStatus.open,
    )
    db.add(task)


def refresh_tracked_event_tasks(db: Session) -> None:
    """Hourly: update priority/due for open tasks linked to tracked events; drop orphans."""
    uk_today = datetime.now(UK).date()
    rows = (
        db.execute(
            select(CaseTask, CaseEvent)
            .join(CaseEvent, CaseTask.case_event_id == CaseEvent.id)
            .where(CaseTask.case_event_id.isnot(None))
        )
        .all()
    )

    for task, ev in rows:
        if not ev.track_in_calendar or ev.event_date is None:
            db.delete(task)
            continue

        if task.status != CaseTaskStatus.open:
            continue

        case = db.get(Case, ev.case_id)
        if not case:
            db.delete(task)
            continue
        assignee = case.fee_earner_user_id or case.created_by

        ed = _event_date_as_date(ev.event_date)
        new_prio = priority_for_tracked_event(uk_today=uk_today, event_date=ed)
        new_due = due_datetime_utc_for_event_date(ed)
        changed = False
        if task.priority != new_prio:
            task.priority = new_prio
            changed = True
        if task.due_at != new_due:
            task.due_at = new_due
            changed = True
        if task.assigned_to_user_id != assignee:
            task.assigned_to_user_id = assignee
            changed = True
        if changed:
            task.updated_at = datetime.utcnow()
            db.add(task)

    db.commit()
