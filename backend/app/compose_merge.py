"""Shared DOCX merge for Letter / Document / M365 e-mail compose flows."""

from __future__ import annotations

import logging
import os
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.docx_util import build_merge_fields, merge_precedent_codes, write_blank_docx
from app.file_storage import FILES_ROOT
from app.matter_contact_constants import CLIENT_SLUG, LAWYERS_SLUG, normalize_matter_contact_type_slug
from app.models import Case as CaseModel
from app.models import CaseContact, Contact as GlobalContact, File as DbFile, Precedent, PrecedentKind, User
from app.schemas import ComposeOfficeDocumentIn

log = logging.getLogger(__name__)


def merge_compose_docx_bytes(
    db: Session,
    case_id: uuid.UUID,
    body: ComposeOfficeDocumentIn,
    *,
    require_precedent_kind: PrecedentKind | None = None,
) -> tuple[bytes, str]:
    """Return merged DOCX bytes and MIME type (always OOXML wordprocessing)."""
    if body.precedent_id is not None:
        prec = db.get(Precedent, body.precedent_id)
        if prec is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
        if require_precedent_kind is not None and prec.kind != require_precedent_kind:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"This action requires a {require_precedent_kind.value} precedent.",
            )
        pfile = db.get(DbFile, prec.file_id)
        if pfile is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file missing")
        prec_abs = (FILES_ROOT / pfile.storage_path).resolve()
        if not str(prec_abs).startswith(str(FILES_ROOT)) or not prec_abs.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file missing on disk")
        src_bytes = prec_abs.read_bytes()
        mime = pfile.mime_type or "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

        case_row = db.get(CaseModel, case_id)
        contact = None
        if body.case_contact_id:
            contact = db.get(CaseContact, body.case_contact_id)
        elif body.global_contact_id:
            contact = db.get(GlobalContact, body.global_contact_id)

        client_ccs: list[CaseContact] = []
        cc_rows: list[CaseContact] = []
        if case_row:
            cc_rows = (
                db.execute(
                    select(CaseContact)
                    .where(CaseContact.case_id == case_id)
                    .order_by(CaseContact.created_at.asc())
                )
                .scalars()
                .all()
            )
            client_ccs = [
                c for c in cc_rows if normalize_matter_contact_type_slug(c.matter_contact_type) == CLIENT_SLUG
            ]
        oc = client_ccs[:4]

        lawyer_rows = [
            c for c in cc_rows if normalize_matter_contact_type_slug(c.matter_contact_type) == LAWYERS_SLUG
        ]
        lawyer_rows = sorted(lawyer_rows, key=lambda c: c.created_at)[:4]
        lawyer_slot_list: list[tuple[CaseContact, list[CaseContact]] | None] = []
        for lr in lawyer_rows:
            raw_ids = lr.lawyer_client_ids or []
            loaded: list[CaseContact] = []
            for sid in raw_ids[:4]:
                try:
                    uid = uuid.UUID(str(sid))
                except (ValueError, TypeError):
                    continue
                row_cc = db.get(CaseContact, uid)
                if (
                    row_cc
                    and row_cc.case_id == case_id
                    and normalize_matter_contact_type_slug(row_cc.matter_contact_type) == CLIENT_SLUG
                ):
                    loaded.append(row_cc)
            lawyer_slot_list.append((lr, loaded))
        while len(lawyer_slot_list) < 4:
            lawyer_slot_list.append(None)

        fee_earner_name = ""
        fee_earner_job_title = ""
        if case_row and case_row.fee_earner_user_id:
            fe_user = db.get(User, case_row.fee_earner_user_id)
            if fe_user:
                fee_earner_name = fe_user.display_name or fe_user.email or ""
                fee_earner_job_title = (fe_user.job_title or "").strip()

        merge_all = body.precedent_merge_all_clients
        selected_slot: int | None = None
        if not merge_all and contact is not None and body.case_contact_id is not None:
            cc_row = contact
            if isinstance(cc_row, CaseContact) and normalize_matter_contact_type_slug(cc_row.matter_contact_type) == CLIENT_SLUG:
                idx0 = next((i for i, c in enumerate(client_ccs) if c.id == cc_row.id), None)
                if idx0 is not None and idx0 < 4:
                    selected_slot = idx0 + 1

        should_merge = merge_all or body.case_contact_id is not None or body.global_contact_id is not None
        if should_merge:
            fields = build_merge_fields(
                case_row,
                fee_earner_name=fee_earner_name,
                fee_earner_job_title=fee_earner_job_title,
                merge_all_clients=merge_all,
                ordered_client_contacts=oc,
                selected_contact=None if merge_all else contact,
                selected_client_slot=None if merge_all else selected_slot,
                lawyer_slots=lawyer_slot_list,
                compose_selected_contact=contact,
            )
            try:
                src_bytes = merge_precedent_codes(
                    src_bytes,
                    fields,
                    ordered_clients=oc,
                    merge_all_clients=merge_all,
                )
            except Exception as merge_err:
                log.warning("merge_precedent_codes failed: %s", merge_err)
        return src_bytes, mime

    fd, tmp_name = tempfile.mkstemp(suffix=".docx")
    tmp = Path(tmp_name)
    try:
        os.close(fd)
        write_blank_docx(tmp)
        src_bytes = tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    return src_bytes, mime
