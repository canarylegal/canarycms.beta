"""Keep Case.client_name in sync with matter contacts whose matter_contact_type is *client*."""

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.matter_contact_constants import CLIENT_SLUG, normalize_matter_contact_type_slug
from app.models import Case, CaseContact


def sync_case_client_name(db: Session, case_id: uuid.UUID) -> None:
    case = db.get(Case, case_id)
    if not case:
        return
    rows = (
        db.execute(select(CaseContact).where(CaseContact.case_id == case_id).order_by(CaseContact.created_at.asc()))
        .scalars()
        .all()
    )
    names: list[str] = []
    for cc in rows:
        if normalize_matter_contact_type_slug(cc.matter_contact_type) == CLIENT_SLUG:
            n = (cc.name or "").strip()
            if n:
                names.append(n)
    case.client_name = ", ".join(names) if names else None
    case.updated_at = datetime.utcnow()
    db.add(case)
