from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditEvent


def log_event(
    db: Session,
    *,
    actor_user_id,
    action: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    meta_json = None
    if meta is not None:
        # Never store secrets; keep it short and structured.
        meta_json = json.dumps(meta, ensure_ascii=False, separators=(",", ":"), default=str)[:8000]

    ev = AuditEvent(
        actor_user_id=actor_user_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        ip=ip,
        user_agent=(user_agent[:300] if user_agent else None),
        meta_json=meta_json,
        created_at=datetime.utcnow(),
    )
    db.add(ev)
    db.commit()
