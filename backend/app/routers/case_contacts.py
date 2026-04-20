import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.case_client_sync import sync_case_client_name
from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.matter_contact_validation import (
    ensure_lawyer_contact_is_organisation,
    normalize_and_validate_lawyer_client_ids,
)
from app.models import Case, CaseContact, Contact, User
from app.schemas import CaseContactCreateFromGlobal, CaseContactOut, CaseContactUpdate


router = APIRouter(prefix="/cases/{case_id}/contacts", tags=["case-contacts"])


def _require_case(db: Session, case_id: uuid.UUID) -> Case:
    case = db.get(Case, case_id)
    if not case:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")
    return case


@router.get("", response_model=list[CaseContactOut])
def list_case_contacts(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CaseContactOut]:
    require_case_access(case_id, user, db)
    items = (
        db.execute(select(CaseContact).where(CaseContact.case_id == case_id).order_by(CaseContact.created_at.desc()))
        .scalars()
        .all()
    )
    return [CaseContactOut.model_validate(x, from_attributes=True) for x in items]


@router.post("", response_model=CaseContactOut, status_code=status.HTTP_201_CREATED)
def add_contact_snapshot_from_global(
    case_id: uuid.UUID,
    payload: CaseContactCreateFromGlobal,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseContactOut:
    require_case_access(case_id, user, db)

    contact = db.get(Contact, payload.contact_id)
    if not contact:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Global contact not found")

    ensure_lawyer_contact_is_organisation(payload.matter_contact_type.strip(), contact.type)

    cc = CaseContact(
        case_id=case_id,
        contact_id=contact.id,
        is_linked_to_master=True,
        type=contact.type,
        name=contact.name,
        email=contact.email,
        phone=contact.phone,
        title=contact.title,
        first_name=contact.first_name,
        middle_name=contact.middle_name,
        last_name=contact.last_name,
        company_name=contact.company_name,
        trading_name=contact.trading_name,
        address_line1=contact.address_line1,
        address_line2=contact.address_line2,
        city=contact.city,
        county=contact.county,
        postcode=contact.postcode,
        country=contact.country,
        matter_contact_type=payload.matter_contact_type.strip(),
        matter_contact_reference=(payload.matter_contact_reference or "").strip() or None,
        lawyer_client_ids=normalize_and_validate_lawyer_client_ids(
            db,
            case_id,
            payload.matter_contact_type.strip(),
            payload.lawyer_client_ids,
        ),
    )
    db.add(cc)
    db.commit()
    db.refresh(cc)
    sync_case_client_name(db, case_id)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.contact.snapshot.create",
        entity_type="case_contact",
        entity_id=str(cc.id),
        meta={"case_id": str(case_id), "contact_id": str(contact.id)},
    )
    return CaseContactOut.model_validate(cc, from_attributes=True)


@router.patch("/{case_contact_id}", response_model=CaseContactOut)
def update_case_contact(
    case_id: uuid.UUID,
    case_contact_id: uuid.UUID,
    payload: CaseContactUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseContactOut:
    require_case_access(case_id, user, db)

    cc = db.get(CaseContact, case_contact_id)
    if not cc or cc.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case contact not found")

    data = payload.model_dump(exclude_unset=True)
    push_to_global = bool(data.pop("push_to_global", False))
    lawyer_ids_in_payload = "lawyer_client_ids" in data
    lawyer_ids_value = data.pop("lawyer_client_ids", None) if lawyer_ids_in_payload else None

    next_matter_type = (cc.matter_contact_type or "").strip()
    if "matter_contact_type" in data and data["matter_contact_type"] is not None:
        next_matter_type = data["matter_contact_type"].strip()

    for key, value in data.items():
        setattr(cc, key, value)

    cc.lawyer_client_ids = normalize_and_validate_lawyer_client_ids(
        db,
        case_id,
        next_matter_type,
        lawyer_ids_value if lawyer_ids_in_payload else None,
        existing=cc if not lawyer_ids_in_payload else None,
    )
    ensure_lawyer_contact_is_organisation(next_matter_type, cc.type)
    cc.updated_at = datetime.utcnow()

    if push_to_global and cc.contact_id:
        contact = db.get(Contact, cc.contact_id)
        if contact:
            # Apply snapshot fields to the global contact card.
            contact.type = cc.type
            contact.name = cc.name
            contact.email = cc.email
            contact.phone = cc.phone
            contact.title = cc.title
            contact.first_name = cc.first_name
            contact.middle_name = cc.middle_name
            contact.last_name = cc.last_name
            contact.company_name = cc.company_name
            contact.trading_name = cc.trading_name
            contact.address_line1 = cc.address_line1
            contact.address_line2 = cc.address_line2
            contact.city = cc.city
            contact.county = cc.county
            contact.postcode = cc.postcode
            contact.country = cc.country
            contact.updated_at = datetime.utcnow()
            db.add(contact)

    db.add(cc)
    db.commit()
    db.refresh(cc)
    sync_case_client_name(db, case_id)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.contact.snapshot.update",
        entity_type="case_contact",
        entity_id=str(cc.id),
        meta={"case_id": str(case_id), "push_to_global": push_to_global},
    )
    return CaseContactOut.model_validate(cc, from_attributes=True)


@router.delete("/{case_contact_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_case_contact(
    case_id: uuid.UUID,
    case_contact_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    cc = db.get(CaseContact, case_contact_id)
    if not cc or cc.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case contact not found")
    db.delete(cc)
    db.commit()
    sync_case_client_name(db, case_id)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.contact.snapshot.delete",
        entity_type="case_contact",
        entity_id=str(case_contact_id),
        meta={"case_id": str(case_id)},
    )

