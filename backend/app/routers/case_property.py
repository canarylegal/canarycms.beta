"""Per-case Property menu details (addresses + title numbers)."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import CasePropertyDetails, User
from app.schemas import CasePropertyDetailsOut, CasePropertyPayload

router = APIRouter(prefix="/cases/{case_id}/property-details", tags=["case-property"])


def _normalize_payload(data: dict) -> CasePropertyPayload:
    raw = CasePropertyPayload.model_validate(data)
    lines = list(raw.free_lines) if raw.free_lines else []
    while len(lines) < 6:
        lines.append("")
    lines = lines[:6]
    tns = [x.strip() for x in raw.title_numbers if x and x.strip()]
    return CasePropertyPayload(
        is_non_postal=raw.is_non_postal,
        uk=raw.uk,
        free_lines=lines,
        title_numbers=tns,
        tenure=raw.tenure,
    )


def _has_details(p: CasePropertyPayload) -> bool:
    if p.tenure is not None:
        return True
    if p.title_numbers:
        return True
    if p.is_non_postal:
        return any((ln or "").strip() for ln in p.free_lines)
    u = p.uk
    return any(
        [
            (u.line1 or "").strip(),
            (u.line2 or "").strip(),
            (u.town or "").strip(),
            (u.county or "").strip(),
            (u.postcode or "").strip(),
            (u.country or "").strip(),
        ]
    )


@router.get("", response_model=CasePropertyDetailsOut)
def get_property_details(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CasePropertyDetailsOut:
    require_case_access(case_id, user, db)
    row = db.get(CasePropertyDetails, case_id)
    if not row:
        empty = CasePropertyPayload()
        return CasePropertyDetailsOut(has_details=False, payload=empty, updated_at=None)
    payload = _normalize_payload(row.payload if isinstance(row.payload, dict) else {})
    return CasePropertyDetailsOut(
        has_details=_has_details(payload),
        payload=payload,
        updated_at=row.updated_at,
    )


@router.put("", response_model=CasePropertyDetailsOut)
def put_property_details(
    case_id: uuid.UUID,
    payload_in: CasePropertyPayload,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CasePropertyDetailsOut:
    require_case_access(case_id, user, db)
    payload = _normalize_payload(payload_in.model_dump())
    row = db.get(CasePropertyDetails, case_id)
    now = datetime.utcnow()
    if row is None:
        row = CasePropertyDetails(case_id=case_id, payload=payload.model_dump(), updated_at=now)
        db.add(row)
    else:
        row.payload = payload.model_dump()
        row.updated_at = now
        db.add(row)
    db.commit()
    db.refresh(row)
    return CasePropertyDetailsOut(
        has_details=_has_details(payload),
        payload=payload,
        updated_at=row.updated_at,
    )
