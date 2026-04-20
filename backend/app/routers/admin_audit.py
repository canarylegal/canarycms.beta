import json
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_admin
from app.models import AuditEvent, User


router = APIRouter(prefix="/admin/audit-events", tags=["admin-audit"])


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    # Accept ISO 8601 (e.g. 2026-03-18T12:00:00Z or with offset)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@router.get("")
def list_audit_events(
    action: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    since: str | None = Query(default=None, description="ISO 8601 datetime"),
    until: str | None = Query(default=None, description="ISO 8601 datetime"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    since_dt = _parse_dt(since)
    until_dt = _parse_dt(until)

    clauses = []
    if action:
        clauses.append(AuditEvent.action == action)
    if actor_user_id:
        clauses.append(AuditEvent.actor_user_id == actor_user_id)
    if entity_type:
        clauses.append(AuditEvent.entity_type == entity_type)
    if entity_id:
        clauses.append(AuditEvent.entity_id == entity_id)
    if since_dt:
        clauses.append(AuditEvent.created_at >= since_dt)
    if until_dt:
        clauses.append(AuditEvent.created_at <= until_dt)

    stmt = select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit).offset(offset)
    if clauses:
        stmt = stmt.where(and_(*clauses))

    events = db.execute(stmt).scalars().all()

    def meta_obj(e: AuditEvent):
        if not e.meta_json:
            return None
        try:
            return json.loads(e.meta_json)
        except Exception:
            return {"_raw": e.meta_json}

    return [
        {
            "id": str(e.id),
            "actor_user_id": str(e.actor_user_id) if e.actor_user_id else None,
            "action": e.action,
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "ip": e.ip,
            "user_agent": e.user_agent,
            "meta": meta_obj(e),
            "created_at": e.created_at,
        }
        for e in events
    ]

