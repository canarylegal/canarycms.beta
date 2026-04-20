"""Seed matter head types, sub types, and sub menus on fresh deployments.

Reads ``matter_types_seed/seed.json`` (relative to /app). Skips entirely if
the matter_head_type table already has rows.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import MatterHeadType, MatterSubType, MatterSubTypeMenu

log = logging.getLogger(__name__)

SEED_PATH = Path(__file__).parent.parent / "matter_types_seed" / "seed.json"


def apply_matter_type_seed_if_empty(db: Session) -> bool:
    """Return True if seed was applied."""

    existing = db.execute(select(MatterHeadType).limit(1)).first()
    if existing is not None:
        log.info("Matter types already present — skipping seed.")
        return False

    if not SEED_PATH.is_file():
        log.info("No matter type seed at %s — skipping.", SEED_PATH)
        return False

    raw = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    if raw.get("version") != 1:
        log.warning("Unsupported matter type seed version: %s", raw.get("version"))
        return False

    matter_types = raw.get("matter_types") or []
    if not matter_types:
        log.info("Matter type seed is empty — skipping.")
        return False

    try:
        now = datetime.now(timezone.utc)
        for ht in matter_types:
            head_name = (ht.get("name") or "").strip()
            if not head_name:
                continue
            head_id = uuid.uuid4()
            db.add(MatterHeadType(id=head_id, name=head_name, created_at=now, updated_at=now))
            db.flush()

            for st in ht.get("sub_types") or []:
                sub_name = (st.get("name") or "").strip()
                if not sub_name:
                    continue
                sub_id = uuid.uuid4()
                db.add(MatterSubType(
                    id=sub_id,
                    head_type_id=head_id,
                    name=sub_name,
                    prefix=st.get("prefix"),
                    created_at=now,
                    updated_at=now,
                ))
                db.flush()

                for menu_name in st.get("menus") or []:
                    menu_name = menu_name.strip()
                    if not menu_name:
                        continue
                    db.add(MatterSubTypeMenu(
                        id=uuid.uuid4(),
                        sub_type_id=sub_id,
                        name=menu_name,
                        created_at=now,
                        updated_at=now,
                    ))

        db.commit()
    except Exception:
        db.rollback()
        raise

    log.info("Matter type seed applied from %s.", SEED_PATH)
    return True
