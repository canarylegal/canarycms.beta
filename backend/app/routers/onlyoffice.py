"""
ONLYOFFICE Document Server callback (save). Document URL uses the same WebDAV session token as checkout.

Canary print staging: ``downloadAs('pdf')`` and native print both yield DS URLs under ``/cache/files/…``
or ``/printfile/…``. The backend fetches those only on the internal DS base (SSRF-safe); the SPA
``/oo-print`` route loads PDF.js and ``window.print()`` using staged bytes from ``/onlyoffice/print-staged-pdf``
so Firefox does not hand off ``application/pdf`` to the global PDF handler.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user
from app.file_storage import FILES_ROOT, ensure_files_root
from app.models import File as DbFile, FileEditSession, User
from app.audit import log_event

router = APIRouter(prefix="/onlyoffice", tags=["onlyoffice"])
log = logging.getLogger(__name__)

# Docker service names that are already reachable from the backend container.
_OO_INTERNAL_HOSTS = {"onlyoffice", "canary-onlyoffice"}


def _strip_ds_reverse_proxy_prefix(path: str) -> str:
    """Strip the public site path prefix where DS is mounted (e.g. /office-ds).

    Callback URLs often look like ``https://app/office-ds/cache/...``. The Document Server
    container serves ``/cache/...`` at its HTTP root, not ``/office-ds/cache/...``, so the
    backend must fetch ``http://onlyoffice/cache/...`` — not ``http://onlyoffice/office-ds/...``
    (which returns 404).

    Override with env ``ONLYOFFICE_DS_PATH_PREFIX_STRIP`` (default ``/office-ds``). Set the
    variable to an empty string to disable stripping.
    """
    env_val = os.getenv("ONLYOFFICE_DS_PATH_PREFIX_STRIP")
    if env_val is not None and env_val.strip() == "":
        return path
    raw = (env_val if env_val is not None else "/office-ds").strip()
    if not raw or raw == "/":
        return path
    prefix = raw.rstrip("/")
    p = path if path.startswith("/") else f"/{path}"
    if p == prefix:
        return "/"
    if p.startswith(prefix + "/"):
        return p[len(prefix) :] or "/"
    return p


def _rewrite_oo_download_url(url: str) -> str:
    """Rewrite the OO DS download URL so the backend container can reach it.

    OO DS embeds the browser's X-Forwarded-Host (e.g. localhost:5173) in its callback payload.
    That URL works from the user's browser but not from inside the backend Docker container.
    Rewrite non-Docker hosts to the OO DS internal URL (default: http://onlyoffice).

    Also strips the reverse-proxy path prefix (``/office-ds``) so internal fetches hit DS paths
    the container actually serves.
    """
    oo_internal = (os.getenv("ONLYOFFICE_DS_INTERNAL_URL") or "http://onlyoffice").strip().rstrip("/")
    try:
        p = urlparse(url)
        host = (p.hostname or "").lower()
        int_host = (urlparse(oo_internal).hostname or "onlyoffice").lower()
        known = _OO_INTERNAL_HOSTS | {int_host}
        path_norm = _strip_ds_reverse_proxy_prefix(p.path or "/")

        if host in known:
            out = urlunparse((p.scheme, p.netloc, path_norm, p.params, p.query, p.fragment))
            if out != url:
                log.info("_rewrite_oo_download_url (internal host): %s → %s", url, out)
            return out

        base = urlparse(oo_internal)
        rewritten = urlunparse(
            (
                base.scheme or "http",
                base.netloc or "onlyoffice",
                path_norm,
                p.params,
                p.query,
                p.fragment,
            )
        )
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


_PRINT_STAGING_TTL_SECONDS = int(os.getenv("ONLYOFFICE_PRINT_STAGE_TTL_SECONDS", "900"))
_PRINT_STAGING_MAX_BYTES = int(os.getenv("ONLYOFFICE_PRINT_STAGE_MAX_BYTES", str(50 * 1024 * 1024)))
_PRINT_JWT_ALG = "HS256"
_PRINT_JWT_PURPOSE = "oo_print_staged"
_PRINT_STORE_LOCK = threading.Lock()
_PRINT_STORE: dict[str, tuple[bytes, float]] = {}


def _print_stage_secret_raw() -> str:
    return (os.getenv("ONLYOFFICE_JWT_SECRET") or "").strip()


def _gc_print_store_unlocked(now: float) -> None:
    dead = [k for k, (_, exp) in _PRINT_STORE.items() if exp <= now]
    for k in dead:
        _PRINT_STORE.pop(k, None)


def _normalized_ds_path_for_print_allowlist(url: str) -> str:
    try:
        p = urlparse(url)
        return _strip_ds_reverse_proxy_prefix(p.path or "/")
    except Exception:
        return ""


def _is_allowed_onlyoffice_ds_fetch_path(path: str) -> bool:
    if not path.startswith("/"):
        path = "/" + path
    parts: list[str] = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            else:
                return False
        else:
            parts.append(seg)
    norm = "/" + "/".join(parts)
    return norm.startswith("/printfile/") or norm.startswith("/cache/files/")


def _internal_fetch_url_from_browser(browser_url: str) -> str:
    u = browser_url.strip()
    if not u or not re.match(r"^https?://", u, re.I):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="browser_url must be an http(s) URL",
        )
    rewritten = _rewrite_oo_download_url(u)
    norm_path = _normalized_ds_path_for_print_allowlist(rewritten)
    if not _is_allowed_onlyoffice_ds_fetch_path(norm_path):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="URL must target ONLYOFFICE /printfile/… or /cache/files/…",
        )
    try:
        fu = urlparse(rewritten)
        if fu.scheme not in ("http", "https"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid URL scheme")
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("print-stage: bad URL %r: %s", rewritten, exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid URL") from exc
    return rewritten


def _encode_print_staging_jwt(*, sid: str) -> str:
    secret = _print_stage_secret_raw()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ONLYOFFICE JWT secret is not configured",
        )
    now = int(time.time())
    ttl = min(_PRINT_STAGING_TTL_SECONDS, 3600)
    return jwt.encode(
        {
            "purpose": _PRINT_JWT_PURPOSE,
            "sid": sid,
            "iat": now,
            "exp": now + ttl,
        },
        secret,
        algorithm=_PRINT_JWT_ALG,
    )


def _decode_print_staging_jwt(token: str) -> str:
    secret = _print_stage_secret_raw()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ONLYOFFICE JWT secret is not configured",
        )
    try:
        payload = jwt.decode(token, secret, algorithms=[_PRINT_JWT_ALG])
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired print token",
        ) from e
    if payload.get("purpose") != _PRINT_JWT_PURPOSE:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid print token")
    sid = payload.get("sid")
    if not isinstance(sid, str) or not sid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid print token")
    return sid


class PrintStageIn(BaseModel):
    browser_url: str = Field(..., min_length=8, max_length=8000)


@router.post("/print-stage")
async def onlyoffice_print_stage(
    body: PrintStageIn,
    _user: User = Depends(get_current_user),
) -> dict[str, str]:
    fetch_url = _internal_fetch_url_from_browser(body.browser_url)
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.get(fetch_url)
            r.raise_for_status()
            data = r.content
    except HTTPException:
        raise
    except Exception as e:
        log.exception("print-stage: fetch failed url=%s", fetch_url)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not fetch PDF from Document Server",
        ) from e

    if len(data) > _PRINT_STAGING_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="PDF exceeds staging size limit",
        )
    if not data.startswith(b"%PDF"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Response is not a PDF")

    sid = uuid.uuid4().hex
    exp = time.time() + _PRINT_STAGING_TTL_SECONDS
    with _PRINT_STORE_LOCK:
        _gc_print_store_unlocked(time.time())
        _PRINT_STORE[sid] = (data, exp)

    t = _encode_print_staging_jwt(sid=sid)
    return {"sid": sid, "t": t}


@router.get("/print-staged-pdf")
async def onlyoffice_print_staged_pdf(
    sid: str = Query(..., min_length=8, max_length=128),
    t: str = Query(..., min_length=10, max_length=4096),
) -> Response:
    jwt_sid = _decode_print_staging_jwt(t)
    if jwt_sid != sid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="sid mismatch")
    with _PRINT_STORE_LOCK:
        entry = _PRINT_STORE.get(sid)
        if not entry:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Print session expired or not found")
        data, exp = entry
        if exp <= time.time():
            _PRINT_STORE.pop(sid, None)
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Print session expired")
    return Response(content=data, media_type="application/pdf")


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
