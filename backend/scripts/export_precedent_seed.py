#!/usr/bin/env python3
"""Export current DB precedents + files into backend/precedents_seed/ for Docker bundling.

Run from repo with DATABASE_URL set (e.g. docker compose exec backend python scripts/export_precedent_seed.py).

Produces manifest.json + bundle/… files. Commit precedents_seed/ to git so the next image build includes them.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# Allow running as script
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault("FILES_ROOT", "/data/files")

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.file_storage import FILES_ROOT
from app.models import File as DbFile
from app.models import MatterHeadType, MatterSubType, Precedent, PrecedentCategory


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    out_dir = _ROOT / "precedents_seed"
    bundle_dir = out_dir / "bundle"
    out_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    db: Session = SessionLocal()
    try:
        cats = db.execute(select(PrecedentCategory).order_by(PrecedentCategory.created_at)).scalars().all()
        prec_rows = db.execute(select(Precedent).order_by(Precedent.created_at)).scalars().all()

        categories_out: list[dict] = []
        seen_cat: set[object] = set()
        for c in cats:
            sub = db.get(MatterSubType, c.matter_sub_type_id)
            head = db.get(MatterHeadType, sub.head_type_id) if sub else None
            if not sub or not head:
                continue
            key = c.id
            if key in seen_cat:
                continue
            seen_cat.add(key)
            categories_out.append(
                {
                    "name": c.name,
                    "sort_order": c.sort_order,
                    "matter_sub_type_name": sub.name,
                    "matter_head_type_name": head.name,
                }
            )

        precedents_out: list[dict] = []
        for i, p in enumerate(prec_rows):
            f = db.get(DbFile, p.file_id)
            cat = db.get(PrecedentCategory, p.category_id)
            if not f or not cat:
                continue
            sub = db.get(MatterSubType, cat.matter_sub_type_id)
            head = db.get(MatterHeadType, sub.head_type_id) if sub else None
            if not sub or not head:
                continue

            src = (FILES_ROOT / f.storage_path).resolve()
            if not src.is_file():
                print(f"skip missing file on disk: {src}", file=sys.stderr)
                continue

            ext = Path(f.original_filename).suffix or ".bin"
            fname = f"p{i}{ext}"
            rel_copy = f"bundle/{fname}"
            shutil.copy2(src, bundle_dir / fname)

            precedents_out.append(
                {
                    "name": p.name,
                    "reference": p.reference,
                    "kind": p.kind.value,
                    "category_name": cat.name,
                    "matter_sub_type_name": sub.name,
                    "matter_head_type_name": head.name,
                    "original_filename": f.original_filename,
                    "mime_type": f.mime_type,
                    "size_bytes": f.size_bytes,
                    "bundle_file": rel_copy,
                }
            )

        manifest = {
            "version": 1,
            "exported_at": _utc_now_iso(),
            "categories": categories_out,
            "precedents": precedents_out,
        }
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"Wrote {out_dir / 'manifest.json'} ({len(precedents_out)} precedents).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
