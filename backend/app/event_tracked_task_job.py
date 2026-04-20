"""Background thread: refresh case-task priority/due for tracked case events (hourly)."""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)

INTERVAL_SECONDS = 3600

_poller_thread: threading.Thread | None = None


def _run_once() -> None:
    from app.db import SessionLocal
    from app.event_tracked_tasks import refresh_tracked_event_tasks

    db = SessionLocal()
    try:
        refresh_tracked_event_tasks(db)
    except Exception:
        log.exception("event_tracked_task_job: run failed")
        db.rollback()
    finally:
        db.close()


def _thread_main() -> None:
    log.warning("event_tracked_task_job: thread started")
    time.sleep(45)
    while True:
        try:
            _run_once()
        except Exception:
            log.exception("event_tracked_task_job: unexpected error")
        time.sleep(INTERVAL_SECONDS)


def start_event_tracked_task_job() -> None:
    global _poller_thread
    if _poller_thread is not None and _poller_thread.is_alive():
        return
    _poller_thread = threading.Thread(
        target=_thread_main,
        name="event-tracked-task-job",
        daemon=True,
    )
    _poller_thread.start()
    log.warning("event_tracked_task_job: background thread started")
