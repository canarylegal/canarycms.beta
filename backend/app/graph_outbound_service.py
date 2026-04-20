"""Optional Microsoft Graph enrichment for filed mail (OWA ``webLink``, etc.).

The public experimental stack may call Graph here to backfill ``outlook_web_link``.
This deployment keeps no-op stubs so uploads and ``outlook-open-hints`` stay stable;
extend with ``httpx`` + app credentials when ``CANARY_MS_GRAPH_*`` env vars are set.
"""

from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import File as DbFile

log = logging.getLogger(__name__)


def link_outlook_graph_metadata_for_eml_file(db: Session, row: DbFile, abs_path: Path) -> None:
    """Hook after a parent ``.eml`` is written. Graph metadata may be filled later."""
    _ = (db, row, abs_path)


def repair_outlook_web_link_on_file(db: Session, row: DbFile) -> None:
    """Best-effort backfill of ``outlook_web_link`` from Graph when server is configured."""
    _ = db
    if row.outlook_web_link and str(row.outlook_web_link).strip():
        return
    # Future: if CANARY_MS_GRAPH_* are set, GET message by id and set row.outlook_web_link.
