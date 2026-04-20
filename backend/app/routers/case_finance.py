"""Case finance endpoints."""
from __future__ import annotations

import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.docx_util import write_completion_statement_docx
from app.file_storage import FILES_ROOT, case_file_paths, ensure_files_root
from app.finance_service import (
    create_finance_category,
    create_finance_item,
    delete_finance_category,
    delete_finance_item,
    get_finance,
    update_finance_category,
    update_finance_item,
)
from app.models import Case, File as DbFile, FileCategory, User
from app.schemas import (
    FinanceCategoryCreate,
    FinanceCategoryOut,
    FinanceCategoryUpdate,
    FinanceItemCreate,
    FinanceItemOut,
    FinanceItemUpdate,
    FinanceOut,
)

router = APIRouter(prefix="/cases", tags=["finance"])


@router.get("/{case_id}/finance", response_model=FinanceOut)
def read_finance(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FinanceOut:
    require_case_access(case_id, user, db)
    result = get_finance(case_id, db)
    db.commit()  # commit any auto-initialisation
    return result


@router.post("/{case_id}/finance/categories", response_model=FinanceCategoryOut, status_code=status.HTTP_201_CREATED)
def add_finance_category(
    case_id: uuid.UUID,
    payload: FinanceCategoryCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FinanceCategoryOut:
    require_case_access(case_id, user, db)
    result = create_finance_category(case_id, payload, db)
    db.commit()
    return result


@router.patch("/{case_id}/finance/categories/{cat_id}", response_model=FinanceCategoryOut)
def edit_finance_category(
    case_id: uuid.UUID,
    cat_id: uuid.UUID,
    payload: FinanceCategoryUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FinanceCategoryOut:
    require_case_access(case_id, user, db)
    result = update_finance_category(case_id, cat_id, payload, db)
    db.commit()
    return result


@router.delete("/{case_id}/finance/categories/{cat_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_finance_category(
    case_id: uuid.UUID,
    cat_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    delete_finance_category(case_id, cat_id, db)
    db.commit()


@router.post("/{case_id}/finance/items", response_model=FinanceItemOut, status_code=status.HTTP_201_CREATED)
def add_finance_item(
    case_id: uuid.UUID,
    payload: FinanceItemCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FinanceItemOut:
    require_case_access(case_id, user, db)
    result = create_finance_item(case_id, payload, db)
    db.commit()
    return result


@router.patch("/{case_id}/finance/items/{item_id}", response_model=FinanceItemOut)
def edit_finance_item(
    case_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: FinanceItemUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FinanceItemOut:
    require_case_access(case_id, user, db)
    result = update_finance_item(case_id, item_id, payload, db)
    db.commit()
    return result


@router.delete("/{case_id}/finance/items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_finance_item(
    case_id: uuid.UUID,
    item_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    delete_finance_item(case_id, item_id, db)
    db.commit()


@router.post("/{case_id}/finance/completion-statement", status_code=status.HTTP_201_CREATED)
def generate_completion_statement(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Generate a completion statement .docx from the case finance data and save it as a case file."""
    require_case_access(case_id, user, db)

    case = db.get(Case, case_id)
    if case is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Case not found")

    finance = get_finance(case_id, db)
    db.commit()  # commit any auto-initialisation

    ensure_files_root()

    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    orig = f"Completion Statement — {today_str}.docx"

    file_id = uuid.uuid4()
    fd, tmp_name = tempfile.mkstemp(suffix=".docx")
    tmp = Path(tmp_name)
    try:
        os.close(fd)
        write_completion_statement_docx(
            tmp,
            case_number=case.case_number,
            client_name=case.client_name,
            finance=finance,
        )
        src_bytes = tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)

    paths = case_file_paths(case_id=case_id, file_id=file_id, original_filename=orig)
    paths.abs_path.write_bytes(src_bytes)
    now = datetime.now(timezone.utc)
    row = DbFile(
        id=file_id,
        case_id=case_id,
        owner_id=user.id,
        category=FileCategory.case_document,
        storage_path=paths.rel_path,
        folder_path=paths.folder_path,
        parent_file_id=None,
        source_imap_mbox=None,
        source_imap_uid=None,
        is_pinned=False,
        original_filename=orig,
        mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size_bytes=len(src_bytes),
        version=1,
        checksum=None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": str(row.id)}
