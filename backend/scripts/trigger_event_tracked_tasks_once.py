#!/usr/bin/env python3
"""Run the tracked–case-event task refresh once (priority / due by UK working days).

Examples:
  docker compose exec backend python scripts/trigger_event_tracked_tasks_once.py
  cd backend && DATABASE_URL=... python scripts/trigger_event_tracked_tasks_once.py
"""

from __future__ import annotations

import os
import sys

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.chdir(_ROOT)

from app.event_tracked_tasks import refresh_tracked_event_tasks  # noqa: E402
from app.db import SessionLocal  # noqa: E402


def main() -> None:
    db = SessionLocal()
    try:
        refresh_tracked_event_tasks(db)
    finally:
        db.close()
    print("trigger_event_tracked_tasks_once: finished.", file=sys.stderr)


if __name__ == "__main__":
    main()
