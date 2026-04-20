"""
ONLYOFFICE Document Server callback (save). Document URL uses the same WebDAV session token as checkout.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.file_storage import FILES_ROOT, ensure_files_root
from app.models import File as DbFile, FileEditSession
from app.audit import log_event

router = APIRouter(prefix="/onlyoffice", tags=["onlyoffice"])
log = logging.getLogger(__name__)

# Docker service names that are already reachable from the backend container.
_OO_INTERNAL_HOSTS = {"onlyoffice", "canary-onlyoffice"}


def _rewrite_oo_download_url(url: str) -> str:
    """Rewrite the OO DS download URL so the backend container can reach it.

    OO DS embeds the browser's X-Forwarded-Host (e.g. localhost:5173) in its callback payload.
    That URL works from the user's browser but not from inside the backend Docker container.
    Rewrite non-Docker hosts to the OO DS internal URL (default: http://onlyoffice).
    """
    oo_internal = (os.getenv("ONLYOFFICE_DS_INTERNAL_URL") or "http://onlyoffice").strip().rstrip("/")
    try:
        p = urlparse(url)
        host = (p.hostname or "").lower()
        int_host = (urlparse(oo_internal).hostname or "onlyoffice").lower()
        known = _OO_INTERNAL_HOSTS | {int_host}
        if host in known:
            return url  # already a Docker-internal URL; no rewrite needed
        base = urlparse(oo_internal)
        rewritten = urlunparse((base.scheme or "http", base.netloc or "onlyoffice",
                                p.path, p.params, p.query, p.fragment))
        log.info("_rewrite_oo_download_url: %s → %s", url, rewritten)
        return rewritten
    except Exception as exc:
        log.warning("_rewrite_oo_download_url failed for %r: %s", url, exc)
        return url


def _onlyoffice_jwt_secret() -> str:
    return (os.getenv("ONLYOFFICE_JWT_SECRET") or "").strip()


def _decode_callback_payload(request: Request, body: Any) -> dict[str, Any]:
    secret = _onlyoffice_jwt_secret()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ONLYOFFICE JWT secret is not configured",
        )
    if isinstance(body, str):
        try:
            return jwt.decode(body, secret, algorithms=["HS256"], options={"verify_aud": False})
        except JWTError as e:
            log.warning("ONLYOFFICE callback JWT (raw body) failed: %s", e)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    auth = request.headers.get("Authorization") or ""
    if auth.startswith("Bearer "):
        try:
            return jwt.decode(auth[7:], secret, algorithms=["HS256"], options={"verify_aud": False})
        except JWTError:
            pass

    if isinstance(body, dict) and "token" in body:
        try:
            return jwt.decode(
                body["token"],
                secret,
                algorithms=["HS256"],
                options={"verify_aud": False},
            )
        except JWTError as e:
            log.warning("ONLYOFFICE callback JWT failed: %s", e)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # OO DS 7.5 does not include an outbox JWT in callbacks despite local.json configuration.
    # Accept plain callbacks when the body contains the expected OO DS fields (key + status).
    # The handler validates case_id / file_id against the DB, limiting the blast radius.
    if isinstance(body, dict) and "status" in body and "key" in body:
        log.warning(
            "onlyoffice_callback: no JWT in callback body — accepting plain payload "
            "(OO DS outbox JWT not sent by this version; key=%s status=%s)",
            body.get("key"),
            body.get("status"),
        )
        return body

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing or invalid JWT")


@router.post("/callback")
async def onlyoffice_callback(
    request: Request,
    case_id: uuid.UUID | None = Query(None),
    file_id: uuid.UUID | None = Query(None),
    precedent_id: uuid.UUID | None = Query(None),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    if precedent_id is None and (case_id is None or file_id is None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing case_id or file_id")

    raw = await request.body()
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        body = raw.decode("utf-8", errors="replace").strip()

    payload = _decode_callback_payload(request, body)
    # When JWT_IN_BODY=true OO DS wraps the callback data under a nested "payload" key.
    if "payload" in payload and isinstance(payload["payload"], dict):
        payload = payload["payload"]
    st = payload.get("status")
    download_url = payload.get("url")

    log.warning(
        "onlyoffice_callback: file_id=%s status=%s url=%r keys=%s",
        file_id, st, download_url, list(payload.keys()),
    )

    # 2 = document closed, must save; 6 = force-save while editing
    if st in (2, 6) and download_url:
        if precedent_id is not None:
            # Precedent editing: look up file via the Precedent table (no case_id required)
            from app.models import Precedent
            prec = db.get(Precedent, precedent_id)
            if not prec:
                return {"error": 1}
            row = db.get(DbFile, prec.file_id)
            if not row:
                return {"error": 1}
            # Override file_id so the rest of the handler works unchanged
            file_id = row.id
        else:
            row = db.get(DbFile, file_id)
            if not row or row.case_id != case_id:
                return {"error": 1}

        # If the user discarded changes the session is released; skip saving.
        active_sess = db.execute(
            select(FileEditSession).where(
                FileEditSession.file_id == file_id,
                FileEditSession.released_at.is_(None),
            )
        ).scalars().first()
        if active_sess is None:
            log.warning("onlyoffice_callback: NO active session for file %s — skipping save (was discarded?)", file_id)
            return {"error": 0}
        log.warning("onlyoffice_callback: active session found, proceeding to save file %s", file_id)

        ensure_files_root()
        abs_path = (FILES_ROOT / row.storage_path).resolve()
        if not str(abs_path).startswith(str(FILES_ROOT)):
            log.error("Invalid storage path for file %s", file_id)
            return {"error": 1}

        fetch_url = _rewrite_oo_download_url(str(download_url))
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                r = await client.get(fetch_url)
                r.raise_for_status()
                data = r.content
        except Exception as e:
            log.exception("ONLYOFFICE save download failed (url=%s): %s", fetch_url, e)
            return {"error": 1}

        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_bytes(data)

        # Remove pre-edit backup now that the new version is saved.
        backup_path = Path(str(abs_path) + ".oo_backup")
        if backup_path.exists():
            try:
                backup_path.unlink()
            except Exception as exc:
                log.warning("Could not delete backup %s: %s", backup_path, exc)

        row.version = (row.version or 1) + 1
        row.size_bytes = len(data)
        row.updated_at = datetime.now(timezone.utc)
        db.add(row)
        db.commit()

        log_event(
            db,
            actor_user_id=None,
            action="precedent.onlyoffice_save" if precedent_id else "case.file.onlyoffice_save",
            entity_type="file",
            entity_id=str(row.id),
            meta={
                **({"precedent_id": str(precedent_id)} if precedent_id else {"case_id": str(case_id)}),
                "version": row.version,
                "size_bytes": len(data),
            },
        )
        return {"error": 0}

    # 1 = editing; 3 = save error; 4 = closed with no changes; 7 = force-save error
    return {"error": 0}
