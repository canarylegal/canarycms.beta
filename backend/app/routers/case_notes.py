import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.models import CaseNote, User
from app.schemas import CaseNoteCreate, CaseNoteOut, CaseNoteUpdate


router = APIRouter(prefix="/cases/{case_id}/notes", tags=["case-notes"])


@router.post("", response_model=CaseNoteOut, status_code=status.HTTP_201_CREATED)
def create_note(
    case_id: uuid.UUID,
    payload: CaseNoteCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseNoteOut:
    require_case_access(case_id, user, db)
    note = CaseNote(case_id=case_id, author_user_id=user.id, body=payload.body)
    db.add(note)
    db.commit()
    db.refresh(note)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.note.create",
        entity_type="case_note",
        entity_id=str(note.id),
        meta={"case_id": str(case_id)},
    )
    return CaseNoteOut.model_validate(note, from_attributes=True)


@router.get("", response_model=list[CaseNoteOut])
def list_notes(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CaseNoteOut]:
    require_case_access(case_id, user, db)
    notes = (
        db.execute(select(CaseNote).where(CaseNote.case_id == case_id).order_by(CaseNote.created_at.desc()))
        .scalars()
        .all()
    )
    return [CaseNoteOut.model_validate(n, from_attributes=True) for n in notes]


@router.patch("/{note_id}", response_model=CaseNoteOut)
def update_note(
    case_id: uuid.UUID,
    note_id: uuid.UUID,
    payload: CaseNoteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseNoteOut:
    require_case_access(case_id, user, db)
    note = db.get(CaseNote, note_id)
    if not note or note.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")

    if user.role.value != "admin" and note.author_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only author or admin can edit")

    note.body = payload.body
    note.updated_at = datetime.utcnow()
    db.add(note)
    db.commit()
    db.refresh(note)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.note.update",
        entity_type="case_note",
        entity_id=str(note.id),
        meta={"case_id": str(case_id)},
    )
    return CaseNoteOut.model_validate(note, from_attributes=True)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(
    case_id: uuid.UUID,
    note_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    note = db.get(CaseNote, note_id)
    if not note or note.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")

    if user.role.value != "admin" and note.author_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only author or admin can delete")

    db.delete(note)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.note.delete",
        entity_type="case_note",
        entity_id=str(note.id),
        meta={"case_id": str(case_id)},
    )
    return None

