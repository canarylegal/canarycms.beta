"""Single origin for links embedded in API responses and WebDAV multistatus hrefs."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from starlette.requests import Request

log = logging.getLogger(__name__)


def _normalize_raw(raw: str) -> str:
    s = raw.strip().rstrip("/")
    if "," in s:
        parts = [p.strip().rstrip("/") for p in s.split(",") if p.strip()]
        chosen = parts[-1] if parts else s
        log.warning(
            "CANARY_PUBLIC_URL must be one origin (no comma-separated list). "
            "Using last segment %r — fix your environment.",
            chosen,
        )
        return chosen
    return s


def get_canary_public_base() -> str | None:
    """Public API origin (scheme + host + optional port), or None if unset.

    When None, WebDAV hrefs may fall back to the request Host / X-Forwarded-* headers.
    """
    raw = os.getenv("CANARY_PUBLIC_URL")
    if raw is None or not raw.strip():
        return None
    return _normalize_raw(raw)


def canary_public_url() -> str:
    """Like get_canary_public_base() but never None (for checkout-edit URLs)."""
    return get_canary_public_base() or "http://127.0.0.1:8000"


def onlyoffice_browser_public_base(request: "Request") -> str:
    """Origin the user's browser actually uses (scheme + host + port).

    ONLYOFFICE may fetch ``document.url`` from the client for print preview and similar paths.
    That URL must be reachable from the browser — not ``localhost:8000`` when the app is opened
    as ``http://192.168.x.x:5173`` behind Vite, unless ``CANARY_PUBLIC_URL`` is set accordingly.

    When a reverse proxy (Vite dev server, nginx) forwards ``X-Forwarded-Host``, prefer that over
    the static env default so client-side fetches match the page origin (including ``/webdav`` on 5173).
    """
    xf_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    xf_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if xf_host:
        scheme = xf_proto or (request.url.scheme or "http")
        return f"{scheme}://{xf_host}".rstrip("/")
    return canary_public_url().rstrip("/")
