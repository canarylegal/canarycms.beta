import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models  # noqa: F401
from app.canary_public_url import get_canary_public_base
from app.event_tracked_task_job import start_event_tracked_task_job
from app.webdav_cors_middleware import WebdavPublicCORSMiddleware
from app.routers import (
    admin_audit,
    admin_billing,
    admin_finance,
    admin_matter_contact_types,
    admin_permission_categories,
    admin_standard_tasks,
    admin_sub_menu_events,
    admin_users,
    auth,
    case_access,
    case_contacts,
    case_events,
    case_finance,
    case_invoices,
    case_ledger,
    case_notes,
    case_property,
    case_tasks,
    cases,
    task_menu,
    contacts,
    files,
    matter_contact_types,
    matter_types,
    me_calendar_events,
    me_calendars,
    onlyoffice,
    outlook_plugin,
    precedents,
    users,
    webdav,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import logging

    from app.db import SessionLocal
    from app.matter_type_bootstrap import apply_matter_type_seed_if_empty
    from app.precedent_bootstrap import apply_precedent_seed_if_empty

    _log = logging.getLogger("uvicorn.error")
    db = SessionLocal()
    try:
        apply_matter_type_seed_if_empty(db)
    except Exception as e:
        db.rollback()
        _log.warning("Matter type seed skipped: %s", e)
    try:
        apply_precedent_seed_if_empty(db)
    except Exception as e:
        db.rollback()
        _log.warning("Precedent seed skipped: %s", e)
    finally:
        db.close()

    start_event_tracked_task_job()
    yield


def _extra_cors_origins() -> list[str]:
    raw = os.getenv("CANARY_CORS_ORIGINS", "").strip()
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


def _cors_allow_origins() -> list[str]:
    base = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        # Default docker-compose production frontend (nginx on host :8080).
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ]
    pub = get_canary_public_base()
    extras = _extra_cors_origins()
    merged: list[str] = []
    seen: set[str] = set()
    for o in base + ([pub] if pub else []) + extras:
        if o not in seen:
            seen.add(o)
            merged.append(o)
    return merged


# LAN / Tailscale HTTP origins (private IPv4). Public HTTPS domains use CANARY_PUBLIC_URL /
# CANARY_CORS_ORIGINS and/or CANARY_CORS_ORIGIN_REGEX.
_LAN_HTTP_ORIGIN_REGEX = (
    r"^http://(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
    r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|"
    r"100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(:\d+)?$"
)


def _cors_allow_origin_regex() -> str:
    extra = os.getenv("CANARY_CORS_ORIGIN_REGEX", "").strip()
    if extra:
        return f"(?:{_LAN_HTTP_ORIGIN_REGEX})|(?:{extra})"
    return _LAN_HTTP_ORIGIN_REGEX


def _install_proxy_headers_middleware(application: FastAPI) -> None:
    """Trust X-Forwarded-* from Docker/internal proxies (see CANARY_PROXY_TRUSTED_HOSTS)."""
    raw = os.getenv("CANARY_BEHIND_REVERSE_PROXY", "").strip().lower()
    if raw not in ("1", "true", "yes"):
        return
    from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

    hosts_raw = os.getenv("CANARY_PROXY_TRUSTED_HOSTS", "").strip()
    trusted: list[str] | str
    if not hosts_raw or hosts_raw == "*":
        trusted = "*"
    else:
        trusted = hosts_raw
    application.add_middleware(ProxyHeadersMiddleware, trusted_hosts=trusted)


app = FastAPI(title="Case Management Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_origin_regex=_cors_allow_origin_regex(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# After CORS: append WebDAV-specific headers (token auth; no cookies). Helps ONLYOFFICE Desktop
# embedded views that enforce CORS on PROPFIND/GET.
app.add_middleware(WebdavPublicCORSMiddleware)
_install_proxy_headers_middleware(app)

app.include_router(auth.router)
app.include_router(admin_users.router)
app.include_router(admin_matter_contact_types.router)
app.include_router(admin_permission_categories.router)
app.include_router(admin_audit.router)
app.include_router(matter_contact_types.router)
app.include_router(matter_types.router)
app.include_router(cases.router)
app.include_router(case_property.router)
app.include_router(precedents.router)
app.include_router(contacts.router)
app.include_router(case_access.router)
app.include_router(case_contacts.router)
app.include_router(case_notes.router)
app.include_router(case_tasks.router)
app.include_router(task_menu.router)
app.include_router(case_ledger.router)
app.include_router(case_invoices.router)
app.include_router(case_finance.router)
app.include_router(case_events.router)
app.include_router(admin_finance.router)
app.include_router(admin_billing.router)
app.include_router(admin_standard_tasks.router)
app.include_router(admin_sub_menu_events.router)
app.include_router(files.router)
app.include_router(outlook_plugin.router)
app.include_router(onlyoffice.router)
app.include_router(webdav.router)
app.include_router(users.router)
app.include_router(me_calendar_events.router)
app.include_router(me_calendars.router)

@app.get("/health")
def health():
    return {"status": "ok"}
