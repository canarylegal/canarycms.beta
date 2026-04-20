#!/usr/bin/env python3
"""Destructive: remove all cases, case files on disk, all contacts, and all users except admins.

Requires env I_CONFIRM_CANARY_WIPE=yes

Run inside backend container:
  I_CONFIRM_CANARY_WIPE=yes python scripts/wipe_except_admin.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("FILES_ROOT", "/data/files")

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.file_storage import FILES_ROOT
from app.models import (
    AuditEvent,
    CalendarEventCategory,
    Case,
    CaseAccessRule,
    CaseContact,
    CaseDocsView,
    CaseEvent,
    CaseInvoice,
    CaseInvoiceLine,
    CaseNote,
    CasePropertyDetails,
    CaseTask,
    Contact,
    File as DbFile,
    FileCategory,
    FileEditSession,
    FinanceCategory,
    FinanceItem,
    LedgerAccount,
    LedgerEntry,
    User,
    UserCalendar,
    UserCalendarCategory,
    UserCalendarShare,
    UserCalendarSubscription,
    UserRole,
)


def _unlink_case_files(db: Session) -> None:
    rows = db.execute(select(DbFile.storage_path).where(DbFile.category != FileCategory.precedent)).scalars().all()
    for rel in rows:
        p = (FILES_ROOT / rel).resolve()
        if str(p).startswith(str(FILES_ROOT)) and p.is_file():
            try:
                p.unlink()
            except OSError:
                pass
        parent = p.parent
        try:
            if parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
        except OSError:
            pass


def main() -> None:
    if os.getenv("I_CONFIRM_CANARY_WIPE", "").strip().lower() not in ("1", "true", "yes"):
        print("Set I_CONFIRM_CANARY_WIPE=yes to run.", file=sys.stderr)
        sys.exit(1)

    db: Session = SessionLocal()
    try:
        admins = db.execute(select(User.id).where(User.role == UserRole.admin)).scalars().all()
        if not admins:
            print("No admin user found — abort.", file=sys.stderr)
            sys.exit(1)
        admin_id = admins[0]

        _unlink_case_files(db)

        # Case-scoped and billing (order: children first)
        db.execute(delete(CaseInvoiceLine))
        db.execute(delete(CaseInvoice))
        db.execute(delete(LedgerEntry))
        db.execute(delete(LedgerAccount))
        db.execute(delete(FinanceItem))
        db.execute(delete(FinanceCategory))
        db.execute(delete(CaseTask))
        db.execute(delete(CaseEvent))
        db.execute(delete(CaseNote))
        db.execute(delete(CaseAccessRule))
        db.execute(delete(CasePropertyDetails))
        db.execute(delete(CaseDocsView))
        db.execute(delete(FileEditSession))

        db.execute(
            delete(DbFile).where(DbFile.parent_file_id.isnot(None), DbFile.category != FileCategory.precedent)
        )
        db.execute(delete(DbFile).where(DbFile.category != FileCategory.precedent))

        db.execute(delete(CaseContact))
        db.execute(delete(Case))

        db.execute(delete(AuditEvent))

        db.execute(delete(Contact))

        # Reset case reference counter
        from app.models import CaseReferenceCounter

        ctc = db.get(CaseReferenceCounter, 1)
        if ctc:
            ctc.next_value = 1

        others = select(User.id).where(User.role != UserRole.admin)

        cal_owned = select(UserCalendar.id).where(UserCalendar.owner_user_id.in_(others))
        db.execute(delete(CalendarEventCategory).where(CalendarEventCategory.calendar_id.in_(cal_owned)))
        db.execute(delete(UserCalendarShare).where(UserCalendarShare.calendar_id.in_(cal_owned)))
        db.execute(delete(UserCalendarSubscription).where(UserCalendarSubscription.calendar_id.in_(cal_owned)))
        db.execute(delete(UserCalendarCategory).where(UserCalendarCategory.calendar_id.in_(cal_owned)))
        db.execute(delete(UserCalendar).where(UserCalendar.owner_user_id.in_(others)))
        db.execute(delete(UserCalendarShare).where(UserCalendarShare.grantee_user_id.in_(others)))
        db.execute(delete(UserCalendarSubscription).where(UserCalendarSubscription.subscriber_user_id.in_(others)))

        db.execute(update(DbFile).where(DbFile.category == FileCategory.precedent).values(owner_id=admin_id))

        db.execute(delete(User).where(User.role != UserRole.admin))

        db.commit()
        print("Wipe complete: admins kept, cases/contacts/non-admin users removed. Precedents kept.")
    except Exception as e:
        db.rollback()
        print(e, file=sys.stderr)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
