"""Shared checkout for WebDAV desktop edit and ONLYOFFICE browser editor."""

from __future__ import annotations

import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import File as DbFile, FileCategory, FileEditSession, User


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def webdav_session_hours() -> int:
    try:
        return max(1, min(72, int(os.getenv("WEBDAV_SESSION_HOURS", "8"))))
    except ValueError:
        return 8


def acquire_file_edit_session(
    db: Session,
    *,
    case_id: uuid.UUID | None,
    file_id: uuid.UUID,
    user: User,
) -> tuple[FileEditSession, DbFile]:
    """
    Return a WebDAV-capable edit session for this user and file.

    If the same user already has exactly one active session for this file, it is returned as-is (avoids
    invalidating a ONLYOFFICE JWT when the client double-calls acquire). Otherwise any prior sessions for
    this user on the file are released and a new session is created.

    Raises 409 if another user holds an active session.
    """
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if row.category == FileCategory.system:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot edit folder markers via WebDAV",
        )

    now = _utcnow()
    active = (
        db.execute(
            select(FileEditSession).where(
                FileEditSession.file_id == file_id,
                FileEditSession.released_at.is_(None),
                FileEditSession.expires_at > now,
            )
        )
        .scalars()
        .all()
    )
    others = [s for s in active if s.user_id != user.id]
    if others:
        other = db.get(User, others[0].user_id)
        locked_name = (other.display_name if other else None) or "Another user"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": f"This file is already being edited by {locked_name}.",
                "locked_by": locked_name,
            },
        )

    mine = [s for s in active if s.user_id == user.id]
    # Re-use the existing WebDAV session when the same user hits acquire again immediately (e.g. React
    # StrictMode / duplicate onlyoffice-config). Releasing the prior session here invalidates document.url
    # in a JWT that ONLYOFFICE has not fetched yet → blank editor and no GET /webdav in backend logs.
    if len(mine) == 1:
        sess = mine[0]
        db.refresh(sess)
        return sess, row

    for s in mine:
        s.released_at = now
        db.add(s)

    hours = webdav_session_hours()
    expires = now + timedelta(hours=hours)
    token = secrets.token_urlsafe(48)
    sess = FileEditSession(
        id=uuid.uuid4(),
        token=token,
        file_id=file_id,
        case_id=case_id,
        user_id=user.id,
        created_at=now,
        expires_at=expires,
        released_at=None,
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return sess, row
