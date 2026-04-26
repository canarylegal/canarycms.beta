import asyncio
import logging
import mimetypes
import os
import re
import secrets
import uuid
from datetime import datetime, timezone
from email import message_from_bytes
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path
from urllib.parse import quote

import shutil
import httpx
from fastapi import APIRouter, Depends, File as FastAPIFile, HTTPException, Query, Request, Response, UploadFile, status, Form
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.compose_merge import merge_compose_docx_bytes
from app.docx_util import extract_plain_text_from_docx_bytes, write_blank_docx
from app.graph_mail import create_outlook_draft, graph_mail_configured
from app.file_storage import FILES_ROOT, StoredFilePaths, case_file_paths, ensure_files_root, sanitize_folder_path
from app.models import Case as CaseRow
from app.models import CaseContact, Contact as GlobalContactRow
from app.models import File as DbFile, FileCategory, FileEditSession, Precedent, PrecedentKind, User
from app.audit import log_event
from app.canary_public_url import canary_public_url, onlyoffice_browser_public_base
from app.onlyoffice_ssrf_url import default_internal_base_for_ds, normalize_onlyoffice_ssrf_base
from app.desktop_edit_session import acquire_file_edit_session
from app.graph_outbound_service import link_outlook_graph_metadata_for_eml_file, repair_outlook_web_link_on_file
from app.security import create_eml_open_token, decode_eml_open_token
from app.schemas import (
    CaseFileMoveUpdate,
    CaseFileRenameUpdate,
    CaseFolderCreate,
    CaseFolderDeleteUpdate,
    CaseFolderMoveUpdate,
    CaseFolderRenameUpdate,
    CaseEmailDraftM365In,
    CaseEmailDraftM365Out,
    CommentFileUpdate,
    ComposeOfficeDocumentIn,
    FileDesktopCheckoutOut,
    FileEditSessionStatusOut,
    FilePinUpdate,
    OnlyofficeEditorConfigOut,
    OutlookOpenHintsOut,
)
import jwt as pyjwt


router = APIRouter(prefix="/cases/{case_id}/files", tags=["files"])
log = logging.getLogger(__name__)

# document.permissions: keep booleans only — nested commentGroups/reviewGroups shapes have caused
# "token not correctly formed" / blank editor on some Document Server versions.
def _redact_webdav_url_for_log(url: str) -> str:
    """Avoid leaking session tokens in logs."""
    return re.sub(r"(/webdav/sessions/)[^/]+(/[^/]+)$", r"\1<token>\2", url)


_ONLYOFFICE_DOC_PERMISSIONS: dict[str, bool] = {
    "comment": True,
    "copy": True,
    "download": True,
    "edit": True,
    "fillForms": True,
    "modifyContentControl": True,
    "modifyFilter": True,
    # Hide DS File → Print (Firefox treats /printfile/… PDF as download handler). Canary Print uses
    # downloadAs('pdf') + /onlyoffice/print-ui instead; keep download: True for that pipeline.
    "print": False,
    "review": True,
}


def _canary_public_url() -> str:
    return canary_public_url()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _onlyoffice_types_for_file(original_filename: str) -> tuple[str, str] | None:
    """Return (documentType, fileType) for ONLYOFFICE, or None if unsupported."""
    ext = Path(original_filename).suffix.lower().lstrip(".")
    if ext in {"doc", "docx", "dot", "dotx", "odt", "rtf", "txt"}:
        return ("word", ext)
    if ext in {"xls", "xlsx", "xlsm", "xlsb", "ods"}:
        return ("cell", ext)
    if ext in {"ppt", "pptx", "pps", "ppsx", "odp"}:
        return ("slide", ext)
    return None


def _normalized_file_suffix(name: str) -> str:
    return Path(name).suffix.lower()


# Old binary formats that share an extension with their newer OOXML equivalents.
# If the file starts with the ZIP magic (PK\x03\x04), the actual format is the OOXML variant.
_OOXML_UPGRADE: dict[str, str] = {"doc": "docx", "dot": "dotx", "xls": "xlsx", "ppt": "pptx", "pps": "ppsx"}
_ZIP_MAGIC = b"PK\x03\x04"


def _unfold_rfc822_header_block(header_b: bytes) -> list[str]:
    """Folded header lines (leading FWS) join to the previous field."""
    text = header_b.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    out: list[str] = []
    for line in lines:
        if line.startswith((" ", "\t")) and out:
            out[-1] = (out[-1].rstrip() + " " + line.strip()).strip()
        else:
            out.append(line.rstrip())
    return out


def _decode_header_value(raw: str) -> str:
    try:
        return str(make_header(decode_header(raw)))
    except Exception:
        return raw


def _eml_parse_message_id_from_header(abs_path: Path) -> str | None:
    """Read Message-ID / Message-Id from the first chunk of a .eml / message/rfc822 file."""
    try:
        with abs_path.open("rb") as fh:
            raw = fh.read(131072)
        if not raw.strip():
            return None
        while raw.startswith(b"From ") and b"\n" in raw:
            raw = raw.split(b"\n", 1)[1]
        if b"\r\n\r\n" in raw:
            header = raw.split(b"\r\n\r\n", 1)[0]
        elif b"\n\n" in raw:
            header = raw.split(b"\n\n", 1)[0]
        else:
            header = raw
        if not header.strip():
            return None
        for line in _unfold_rfc822_header_block(header):
            m = re.match(r"(?i)^message-id\s*:\s*(.*)$", line)
            if not m:
                continue
            val = (m.group(1) or "").strip()
            return val if val else None
        msg = message_from_bytes(header + b"\n\n")
        mid = msg.get("Message-ID") or msg.get("Message-Id")
        if mid:
            s = str(mid).strip()
            return s if s else None
        return None
    except Exception:
        return None


def _eml_parse_from_header(abs_path: Path) -> tuple[str | None, str | None]:
    """Read From: from the first chunk of a .eml / message/rfc822 file (uploaded parent only)."""
    try:
        with abs_path.open("rb") as fh:
            raw = fh.read(131072)
        if not raw.strip():
            return None, None
        # Strip leading "From " mbox separator lines (unlikely but defensive).
        while raw.startswith(b"From ") and b"\n" in raw:
            raw = raw.split(b"\n", 1)[1]
        if b"\r\n\r\n" in raw:
            header = raw.split(b"\r\n\r\n", 1)[0]
        elif b"\n\n" in raw:
            header = raw.split(b"\n\n", 1)[0]
        else:
            header = raw
        if not header.strip():
            return None, None

        for line in _unfold_rfc822_header_block(header):
            m = re.match(r"(?i)^from\s*:\s*(.*)$", line)
            if not m:
                continue
            raw_val = (m.group(1) or "").strip()
            if not raw_val:
                continue
            decoded = _decode_header_value(raw_val)
            name, addr = parseaddr(decoded)
            n = name.strip() if name else ""
            a = addr.strip() if addr else ""
            if n or a:
                return (n or None, a or None)

        msg = message_from_bytes(header + b"\n\n")
        from_val = msg.get("From")
        if from_val:
            decoded = _decode_header_value(str(from_val))
            name, addr = parseaddr(decoded)
            n = name.strip() if name else ""
            a = addr.strip() if addr else ""
            if n or a:
                return (n or None, a or None)
        return None, None
    except Exception:
        return None, None


def _imap_mbox_implies_outbound(mbox: str | None) -> bool | None:
    """Return True/False when the IMAP folder name reliably indicates sent vs inbox; else None."""
    if not mbox or not str(mbox).strip():
        return None
    s = str(mbox).replace("\\", "/").lower()
    if "draft" in s:
        return None
    if "unsent" in s:
        return False
    if "outbox" in s or "sent" in s:
        return True
    return False


def _infer_source_mail_is_outbound(
    mbox: str | None,
    from_email: str | None,
    uploader_email: str | None,
) -> bool | None:
    by_mbox = _imap_mbox_implies_outbound(mbox)
    if by_mbox is not None:
        return by_mbox
    fe = (from_email or "").strip().lower()
    ue = (uploader_email or "").strip().lower()
    if fe and ue and fe == ue:
        return True
    return None


def convert_case_upload_msg_to_eml_if_applicable(
    *,
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    folder_path: str,
    original_filename: str,
    paths: StoredFilePaths,
) -> tuple[str, StoredFilePaths, int]:
    """If ``original_filename`` ends with ``.msg``, replace file on disk with RFC822 ``.eml`` content."""
    if not original_filename.lower().endswith(".msg"):
        return original_filename, paths, paths.abs_path.stat().st_size

    from app.outlook_msg import outlook_msg_path_to_eml_bytes

    try:
        eml_bytes = outlook_msg_path_to_eml_bytes(paths.abs_path)
    except Exception as exc:
        log.exception("MSG→EML conversion failed during upload")
        paths.abs_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not convert Outlook .msg to e-mail (.eml). The file may be corrupt or not an Outlook message.",
        ) from exc
    paths.abs_path.unlink(missing_ok=True)
    eml_name = f"{Path(original_filename).stem}.eml"
    new_paths = case_file_paths(
        case_id=case_id,
        file_id=file_id,
        original_filename=eml_name,
        folder_path=folder_path,
    )
    new_paths.abs_path.write_bytes(eml_bytes)
    return eml_name, new_paths, len(eml_bytes)


def _row_is_eml_like(row: DbFile) -> bool:
    name = (row.original_filename or "").lower()
    mime = (row.mime_type or "").lower()
    return bool(
        name.endswith(".eml")
        or "message/rfc822" in mime
        or "rfc822" in mime
    )


def refresh_root_eml_mail_metadata(frow: DbFile, abs_path: Path, *, uploader_email: str | None) -> None:
    """Re-parse From: etc. for a root (non-attachment) ``.eml`` after the file on disk changed."""
    if frow.parent_file_id is not None:
        return
    low = (frow.original_filename or "").lower()
    if not low.endswith(".eml"):
        return
    fn, fe = _eml_parse_from_header(abs_path)
    frow.source_mail_from_name = fn
    frow.source_mail_from_email = fe
    frow.source_mail_is_outbound = _infer_source_mail_is_outbound(frow.source_imap_mbox, fe, uploader_email)
    frow.source_internet_message_id = _eml_parse_message_id_from_header(abs_path)


def _correct_file_type(file_type: str, abs_path: Path) -> str:
    """Return the real fileType by sniffing magic bytes when the extension claims an old binary format.

    Files uploaded with a .DOC/.XLS/.PPT extension are sometimes actually OOXML/ZIP files (e.g. Word
    2007+ saved-as .doc). ONLYOFFICE reports 'download failed' if told to parse ZIP bytes as OLE2.
    """
    new_type = _OOXML_UPGRADE.get(file_type)
    if new_type is None:
        return file_type
    try:
        with abs_path.open("rb") as fh:
            magic = fh.read(4)
        if magic == _ZIP_MAGIC:
            log.info("_correct_file_type: %s is ZIP/OOXML — using fileType %r instead of %r", abs_path.name, new_type, file_type)
            return new_type
    except OSError:
        pass
    return file_type


@router.post("", status_code=status.HTTP_201_CREATED)
def upload_case_file(
    case_id: uuid.UUID,
    upload: UploadFile = FastAPIFile(...),
    folder: str = Form(default=""),
    parent_file_id: uuid.UUID | None = Form(default=None),
    source_imap_mbox: str | None = Form(default=None),
    source_imap_uid: str | None = Form(default=None),
    outlook_item_id: str | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    ensure_files_root()

    file_id = uuid.uuid4()
    original = upload.filename or "upload.bin"
    paths = case_file_paths(case_id=case_id, file_id=file_id, original_filename=original, folder_path=folder)

    size = 0
    with paths.abs_path.open("wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            f.write(chunk)

    original, paths, size = convert_case_upload_msg_to_eml_if_applicable(
        case_id=case_id,
        file_id=file_id,
        folder_path=folder,
        original_filename=original,
        paths=paths,
    )

    mime = upload.content_type or (mimetypes.guess_type(original)[0] or "application/octet-stream")
    mime_base = mime.split(";", 1)[0].strip().lower()
    guessed = mimetypes.guess_type(original)[0]
    # Browsers often send application/octet-stream for Office files; prefer extension-based type.
    if mime_base == "application/octet-stream" and guessed:
        mime = guessed
    mime_base = mime.split(";", 1)[0].strip().lower()
    if original.lower().endswith(".eml"):
        mime = "message/rfc822"
        mime_base = "message/rfc822"

    parent: DbFile | None = None
    if parent_file_id is not None:
        parent = db.get(DbFile, parent_file_id)
        if not parent or parent.case_id != case_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="parent_file_id is invalid")

    outlook_rest_id = (outlook_item_id or "").strip() or None
    if parent_file_id is not None:
        outlook_rest_id = None

    internet_mid: str | None = None
    if parent_file_id is None:
        low = original.lower()
        if mime_base == "message/rfc822" or low.endswith(".eml"):
            internet_mid = _eml_parse_message_id_from_header(paths.abs_path)

    smbox = (source_imap_mbox or "").strip() or None
    suid = (source_imap_uid or "").strip() or None
    if parent_file_id is not None and (smbox is not None or suid is not None):
        # Only the parent email row should carry IMAP pointers.
        smbox = None
        suid = None

    from_name: str | None = None
    from_email_addr: str | None = None
    mail_outbound: bool | None = None
    if parent_file_id is None:
        low = original.lower()
        if mime_base == "message/rfc822" or low.endswith(".eml"):
            from_name, from_email_addr = _eml_parse_from_header(paths.abs_path)
            mail_outbound = _infer_source_mail_is_outbound(smbox, from_email_addr, user.email)

    row = DbFile(
        id=file_id,
        case_id=case_id,
        owner_id=user.id,
        category=FileCategory.case_document,
        storage_path=paths.rel_path,
        folder_path=paths.folder_path,
        parent_file_id=parent_file_id,
        source_imap_mbox=smbox,
        source_imap_uid=suid,
        source_mail_from_name=from_name,
        source_mail_from_email=from_email_addr,
        source_mail_is_outbound=mail_outbound,
        source_internet_message_id=internet_mid,
        source_outlook_item_id=outlook_rest_id,
        outlook_graph_message_id=outlook_rest_id,
        outlook_web_link=None,
        is_pinned=False,
        original_filename=original,
        mime_type=mime,
        size_bytes=size,
        version=1,
        checksum=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.upload",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "filename": row.original_filename, "size_bytes": row.size_bytes},
    )

    if parent_file_id is None and (mime_base == "message/rfc822" or original.lower().endswith(".eml")):
        try:
            link_outlook_graph_metadata_for_eml_file(db, row, paths.abs_path)
        except Exception:
            log.warning(
                "upload_case_file: could not link Outlook Graph metadata for %s",
                original,
                exc_info=True,
            )

    return {
        "id": str(row.id),
        "case_id": str(row.case_id),
        "original_filename": row.original_filename,
        "mime_type": row.mime_type,
        "size_bytes": row.size_bytes,
    }


@router.post("/compose-office", status_code=status.HTTP_201_CREATED)
def compose_office_document(
    case_id: uuid.UUID,
    body: ComposeOfficeDocumentIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a new .docx in the case from a blank document or a precedent template."""
    require_case_access(case_id, user, db)
    ensure_files_root()
    orig = body.original_filename.strip()
    if not orig.lower().endswith(".docx"):
        orig = f"{Path(orig).stem or 'Document'}.docx"

    src_bytes, mime = merge_compose_docx_bytes(db, case_id, body, require_precedent_kind=None)

    file_id = uuid.uuid4()
    folder = sanitize_folder_path(body.folder or "")
    paths = case_file_paths(case_id=case_id, file_id=file_id, original_filename=orig, folder_path=folder)
    paths.abs_path.write_bytes(src_bytes)
    size = len(src_bytes)
    now = datetime.utcnow()
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
        mime_type=mime,
        size_bytes=size,
        version=1,
        checksum=None,
        oo_compose_pending=True,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.compose_office",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "precedent_id": str(body.precedent_id) if body.precedent_id else None},
    )
    return {
        "id": str(row.id),
        "case_id": str(row.case_id),
        "original_filename": row.original_filename,
        "mime_type": row.mime_type,
        "size_bytes": row.size_bytes,
    }


def _resolve_recipient_email_m365(
    db: Session,
    case_id: uuid.UUID,
    body: ComposeOfficeDocumentIn,
) -> str:
    if body.precedent_merge_all_clients:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Choose a single matter or global contact with an e-mail (not "All clients") for Microsoft 365 e-mail.',
        )
    if body.case_contact_id:
        cc = db.get(CaseContact, body.case_contact_id)
        if not cc or cc.case_id != case_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter contact not found")
        em = (cc.email or "").strip()
        if not em:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selected matter contact has no e-mail address.",
            )
        return em
    if body.global_contact_id:
        g = db.get(GlobalContactRow, body.global_contact_id)
        if not g:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contact not found")
        em = (g.email or "").strip() if g.email else ""
        if not em:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selected contact has no e-mail address.",
            )
        return em
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Select a matter contact or global contact with an e-mail address.",
    )


@router.post("/email-drafts/m365", status_code=status.HTTP_201_CREATED, response_model=CaseEmailDraftM365Out)
def create_case_email_draft_m365(
    case_id: uuid.UUID,
    body: CaseEmailDraftM365In,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CaseEmailDraftM365Out:
    """Create an Outlook draft in the signed-in user's mailbox via Microsoft Graph (application permissions)."""
    try:
        return _create_case_email_draft_m365_body(case_id, body, user, db)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("M365 email draft failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"{type(e).__name__}: {e}",
        ) from e


def _create_case_email_draft_m365_body(
    case_id: uuid.UUID,
    body: CaseEmailDraftM365In,
    user: User,
    db: Session,
) -> CaseEmailDraftM365Out:
    require_case_access(case_id, user, db)
    if not graph_mail_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Microsoft 365 e-mail drafts are not configured. Set CANARY_MS_GRAPH_TENANT_ID, "
                "CANARY_MS_GRAPH_CLIENT_ID, and CANARY_MS_GRAPH_CLIENT_SECRET on the server, "
                "and grant Mail.ReadWrite (application) admin consent."
            ),
        )
    mailbox = (user.email or "").strip()
    if not mailbox:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Your Canary account must have an e-mail address that matches the Microsoft 365 mailbox to use.",
        )

    merge_in = ComposeOfficeDocumentIn(
        original_filename="Email draft.docx",
        folder=body.folder or "",
        precedent_id=body.precedent_id,
        case_contact_id=body.case_contact_id,
        global_contact_id=body.global_contact_id,
        precedent_merge_all_clients=body.precedent_merge_all_clients,
    )
    kind_filter = PrecedentKind.email if body.precedent_id is not None else None
    src_bytes, _mime = merge_compose_docx_bytes(db, case_id, merge_in, require_precedent_kind=kind_filter)
    body_text = extract_plain_text_from_docx_bytes(src_bytes)
    if not body_text.strip():
        body_text = " "

    to_addr = _resolve_recipient_email_m365(db, case_id, merge_in)

    prec_name = ""
    if body.precedent_id:
        pr = db.get(Precedent, body.precedent_id)
        if pr:
            prec_name = (pr.name or "").strip()
    case_row = db.get(CaseRow, case_id)
    subject_bits: list[str] = []
    if case_row and (case_row.case_number or "").strip():
        subject_bits.append(case_row.case_number.strip())
    if prec_name:
        subject_bits.append(prec_name)
    subject = " — ".join(subject_bits) if subject_bits else "E-mail"

    attachments: list[tuple[str, str, bytes]] = []
    if len(body.attachment_file_ids) > 25:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="At most 25 attachments.")
    ensure_files_root()
    for fid in body.attachment_file_ids:
        frow = db.get(DbFile, fid)
        if not frow or frow.case_id != case_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Attachment file not found: {fid}")
        if frow.category == FileCategory.system:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot attach system items.")
        abs_p = (FILES_ROOT / frow.storage_path).resolve()
        if not str(abs_p).startswith(str(FILES_ROOT)) or not abs_p.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attachment file missing on disk")
        raw = abs_p.read_bytes()
        if len(raw) > 100 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Attachment too large: {frow.original_filename}",
            )
        fn = Path(frow.original_filename).name or "attachment"
        mt = frow.mime_type or mimetypes.guess_type(fn)[0] or "application/octet-stream"
        attachments.append((fn, mt, raw))

    try:
        primary, draft_id, compose_extra, _imid = create_outlook_draft(
            mailbox,
            to_addr=to_addr,
            subject=subject,
            body_text=body_text,
            attachments=attachments,
        )
    except RuntimeError as e:
        log.warning("Graph draft failed: %s", e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e)) from e
    except Exception as e:
        log.exception("M365 draft failed with unexpected error")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Unexpected error while creating the Outlook draft: {e}",
        ) from e

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.email_draft_m365",
        entity_type="graph_message",
        entity_id=draft_id,
        meta={
            "case_id": str(case_id),
            "graph_message_id": draft_id,
            "precedent_id": str(body.precedent_id) if body.precedent_id else None,
            "attachment_count": len(body.attachment_file_ids),
        },
    )
    return CaseEmailDraftM365Out(
        open_url=primary,
        graph_message_id=draft_id,
        draft_compose_web_link=compose_extra,
    )


@router.get("", response_model=list[dict])
def list_case_files(
    case_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    rows = (
        db.execute(
            select(DbFile, User.display_name, User.email)
            .join(User, DbFile.owner_id == User.id)
            .where(DbFile.case_id == case_id, DbFile.oo_compose_pending.is_(False))
            .order_by(DbFile.created_at.desc())
        ).all()
    )
    return [
        {
            "id": str(f.id),
            "original_filename": f.original_filename,
            "mime_type": f.mime_type,
            "size_bytes": f.size_bytes,
            "created_at": f.created_at,
            "updated_at": f.updated_at,
            "folder_path": f.folder_path,
            "is_pinned": f.is_pinned,
            "category": f.category,
            "parent_file_id": str(f.parent_file_id) if f.parent_file_id else None,
            "source_imap_mbox": f.source_imap_mbox,
            "source_imap_uid": f.source_imap_uid,
            "source_mail_from_name": f.source_mail_from_name,
            "source_mail_from_email": f.source_mail_from_email,
            "source_mail_is_outbound": f.source_mail_is_outbound,
            "source_internet_message_id": f.source_internet_message_id,
            "source_outlook_item_id": f.source_outlook_item_id,
            "outlook_graph_message_id": f.outlook_graph_message_id,
            "outlook_web_link": f.outlook_web_link,
            "owner_display_name": owner_display_name,
            "owner_email": owner_email,
        }
        for (f, owner_display_name, owner_email) in rows
    ]


@router.post("/folders", status_code=status.HTTP_201_CREATED)
def create_case_folder(
    case_id: uuid.UUID,
    payload: CaseFolderCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    ensure_files_root()

    # Store an empty "folder marker" as a system file so empty folders exist in the UI.
    folder_name = payload.folder_path.split("/")[-1].strip() or "Folder"
    file_id = uuid.uuid4()
    try:
        paths = case_file_paths(
            case_id=case_id,
            file_id=file_id,
            original_filename=folder_name,
            folder_path=payload.folder_path,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    # Create 0-byte marker file on disk.
    with paths.abs_path.open("wb") as f:
        f.write(b"")

    row = DbFile(
        id=file_id,
        case_id=case_id,
        owner_id=user.id,
        category=FileCategory.system,
        storage_path=paths.rel_path,
        folder_path=paths.folder_path,
        is_pinned=False,
        original_filename=folder_name,
        mime_type="application/x-directory",
        size_bytes=0,
        version=1,
        checksum=None,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    log_event(
        db,
        actor_user_id=user.id,
        action="case.folder.create",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "folder_path": row.folder_path, "folder_name": row.original_filename},
    )

    return {"folder_path": row.folder_path}


@router.post("/folders/rename", status_code=status.HTTP_200_OK)
def rename_case_folder(
    case_id: uuid.UUID,
    payload: CaseFolderRenameUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    old_path = sanitize_folder_path(payload.old_folder_path)
    new_path = sanitize_folder_path(payload.new_folder_path)
    if not old_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot rename Root")

    require_case_access(case_id, user, db)
    ensure_files_root()
    from app.file_storage import FILES_ROOT

    old_prefix = old_path
    old_like = f"{old_prefix}/%"

    rows = db.execute(
        select(DbFile).where((DbFile.case_id == case_id) & ((DbFile.folder_path == old_prefix) | (DbFile.folder_path.like(old_like))))
    ).scalars().all()

    new_last = new_path.split("/")[-1].strip() if new_path else ""
    if not new_last:
        new_last = "Folder"

    # Move physical files and update DB fields.
    for row in rows:
        old_fp = row.folder_path or ""
        relative = ""
        if old_fp == old_prefix:
            relative = ""
        elif old_fp.startswith(f"{old_prefix}/"):
            relative = old_fp[len(old_prefix) + 1 :]
        else:
            continue

        updated_fp = new_path + (f"/{relative}" if relative else "")

        updated_original = row.original_filename
        if row.category == FileCategory.system and row.folder_path == old_prefix:
            updated_original = new_last

        new_paths = case_file_paths(
            case_id=case_id,
            file_id=row.id,
            original_filename=updated_original,
            folder_path=updated_fp,
        )

        old_abs = (FILES_ROOT / row.storage_path).resolve()
        new_abs = new_paths.abs_path
        if old_abs.exists() and str(old_abs) != str(new_abs):
            # Ensure destination directory exists (already created by case_file_paths).
            shutil.move(str(old_abs), str(new_abs))

        row.storage_path = new_paths.rel_path
        row.folder_path = updated_fp
        if updated_original != row.original_filename:
            row.original_filename = updated_original
        row.updated_at = datetime.utcnow()
        db.add(row)

    db.commit()

    log_event(
        db,
        actor_user_id=user.id,
        action="case.folder.rename",
        entity_type="case",
        entity_id=str(case_id),
        meta={"old_folder_path": old_path, "new_folder_path": new_path},
    )

    return {"old_folder_path": old_path, "new_folder_path": new_path}


@router.post("/folders/delete", status_code=status.HTTP_200_OK)
def delete_case_folder(
    case_id: uuid.UUID,
    payload: CaseFolderDeleteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    folder_path = sanitize_folder_path(payload.folder_path)
    if not folder_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete Root")

    require_case_access(case_id, user, db)
    ensure_files_root()
    from app.file_storage import FILES_ROOT

    prefix = folder_path
    like = f"{prefix}/%"

    rows = db.execute(
        select(DbFile).where((DbFile.case_id == case_id) & ((DbFile.folder_path == prefix) | (DbFile.folder_path.like(like))))
    ).scalars().all()

    # Delete physical files first (best effort).
    for row in rows:
        abs_path = (FILES_ROOT / row.storage_path).resolve()
        try:
            if abs_path.exists():
                abs_path.unlink()
        except Exception:
            # Avoid hard failing on filesystem inconsistencies.
            pass

    for row in rows:
        db.delete(row)
    db.commit()

    log_event(
        db,
        actor_user_id=user.id,
        action="case.folder.delete",
        entity_type="case",
        entity_id=str(case_id),
        meta={"folder_path": folder_path, "deleted_count": len(rows)},
    )

    return {"folder_path": folder_path, "deleted_count": len(rows)}


@router.post("/folders/move", status_code=status.HTTP_200_OK)
def move_case_folder(
    case_id: uuid.UUID,
    payload: CaseFolderMoveUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Move keeps the folder leaf name; only the parent path changes.
    old_path = sanitize_folder_path(payload.old_folder_path)
    if not old_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot move Root")
    parts = [p for p in old_path.split("/") if p]
    leaf = parts[-1]
    new_parent = sanitize_folder_path(payload.new_parent_path)

    new_path = f"{new_parent}/{leaf}" if new_parent else leaf
    return rename_case_folder(
        case_id=case_id,
        payload=CaseFolderRenameUpdate(old_folder_path=old_path, new_folder_path=new_path),
        user=user,
        db=db,
    )


@router.patch("/{file_id}/pin", status_code=status.HTTP_200_OK)
def set_file_pin(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: FilePinUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    row.is_pinned = payload.is_pinned
    db.add(row)
    db.commit()
    db.refresh(row)

    log_event(
        db,
        actor_user_id=user.id,
        action="file.pin",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "is_pinned": payload.is_pinned, "filename": row.original_filename},
    )

    return {"id": str(row.id), "is_pinned": row.is_pinned}


@router.patch("/{file_id}/rename", status_code=status.HTTP_200_OK)
def rename_case_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: CaseFileRenameUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if row.category == FileCategory.system:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot rename folder markers here")

    new_name = Path(payload.original_filename).name
    if not new_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid filename")
    old_ext = _normalized_file_suffix(row.original_filename or "")
    new_ext = _normalized_file_suffix(new_name)
    if old_ext != new_ext:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Renaming cannot change the file extension.",
        )

    ensure_files_root()
    from app.file_storage import FILES_ROOT

    folder = row.folder_path or ""
    new_paths = case_file_paths(
        case_id=case_id,
        file_id=row.id,
        original_filename=new_name,
        folder_path=folder,
    )
    old_abs = (FILES_ROOT / row.storage_path).resolve()
    new_abs = new_paths.abs_path
    if old_abs.exists() and str(old_abs) != str(new_abs):
        shutil.move(str(old_abs), str(new_abs))

    row.storage_path = new_paths.rel_path
    row.folder_path = new_paths.folder_path
    row.original_filename = new_name
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.rename",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "filename": row.original_filename},
    )
    return {"id": str(row.id), "original_filename": row.original_filename}


@router.patch("/{file_id}/comment", status_code=status.HTTP_200_OK)
def update_comment_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: CommentFileUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Update the text content of a comment (.txt) file and auto-rename it from the first line."""
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    ensure_files_root()

    # Derive new filename from first line (≤80 chars)
    first_line = (payload.text.strip().split("\n")[0].strip() or "Comment")[:80]
    if len(first_line) == 80:
        first_line = first_line[:77] + "…"
    new_name = first_line + ".txt"

    folder = row.folder_path or ""
    new_paths = case_file_paths(
        case_id=case_id,
        file_id=row.id,
        original_filename=new_name,
        folder_path=folder,
    )
    old_abs = (FILES_ROOT / row.storage_path).resolve()

    # Write new content
    encoded = payload.text.encode("utf-8")
    new_paths.abs_path.parent.mkdir(parents=True, exist_ok=True)
    new_paths.abs_path.write_bytes(encoded)

    # Remove old file if path changed
    if old_abs.exists() and str(old_abs) != str(new_paths.abs_path):
        try:
            old_abs.unlink()
        except OSError:
            pass

    row.storage_path = new_paths.rel_path
    row.folder_path = new_paths.folder_path
    row.original_filename = new_name
    row.size_bytes = len(encoded)
    row.updated_at = datetime.utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.comment.update",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id)},
    )
    return {"id": str(row.id), "original_filename": row.original_filename}


@router.post("/{file_id}/move", status_code=status.HTTP_200_OK)
def move_case_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    payload: CaseFileMoveUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if row.category == FileCategory.system:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot move folder markers here")

    try:
        new_folder = sanitize_folder_path(payload.folder_path)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    ensure_files_root()
    from app.file_storage import FILES_ROOT

    # Move parent + its children (attachments) together so indentation/grouping stays consistent.
    rows_to_move = [row]
    children = (
        db.execute(select(DbFile).where(DbFile.case_id == case_id, DbFile.parent_file_id == file_id)).scalars().all()
    )
    rows_to_move.extend(children)

    for r in rows_to_move:
        new_paths = case_file_paths(
            case_id=case_id,
            file_id=r.id,
            original_filename=r.original_filename,
            folder_path=new_folder,
        )
        old_abs = (FILES_ROOT / r.storage_path).resolve()
        new_abs = new_paths.abs_path
        if old_abs.exists() and str(old_abs) != str(new_abs):
            shutil.move(str(old_abs), str(new_abs))

        r.storage_path = new_paths.rel_path
        r.folder_path = new_paths.folder_path
        r.updated_at = datetime.utcnow()
        db.add(r)

    db.commit()
    db.refresh(row)

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.move",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "folder_path": row.folder_path},
    )
    return {"id": str(row.id), "folder_path": row.folder_path}


def _erase_case_file_tree(db: Session, case_id: uuid.UUID, file_id: uuid.UUID) -> DbFile | None:
    """Delete a case file (and child rows) from disk and database. Returns the parent row if deleted."""
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        return None
    ensure_files_root()
    rows_to_delete = [row]
    children = (
        db.execute(select(DbFile).where(DbFile.case_id == case_id, DbFile.parent_file_id == file_id)).scalars().all()
    )
    rows_to_delete.extend(children)
    for r in rows_to_delete:
        abs_path = (FILES_ROOT / r.storage_path).resolve()
        backup = Path(str(abs_path) + ".oo_backup")
        try:
            if backup.exists():
                backup.unlink()
        except Exception:
            pass
        try:
            if abs_path.exists():
                abs_path.unlink()
        except Exception:
            pass
    db.delete(row)
    db.commit()
    return row


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_case_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    deleted = _erase_case_file_tree(db, case_id, file_id)
    if deleted is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.delete",
        entity_type="file",
        entity_id=str(file_id),
        meta={"case_id": str(case_id)},
    )
    return None


def _shell_single_quote(s: str) -> str:
    """Wrap for POSIX shells (single-quote, escaping embedded quotes)."""
    return "'" + s.replace("'", "'\"'\"'") + "'"


def _libreoffice_cli_executable(original_filename: str) -> str:
    """Use module binaries (lowriter/localc/limpress), not `libreoffice --writer`.

    Some systems map the generic `libreoffice` command to another suite (e.g. ONLYOFFICE) via
    alternatives or wrappers; lowriter/localc/limpress are LibreOffice-specific on typical Linux installs.
    """
    ext = Path(original_filename).suffix.lower()
    if ext in (".xls", ".xlsx", ".ods", ".csv"):
        return "localc"
    if ext in (".ppt", ".pptx", ".odp"):
        return "limpress"
    return "lowriter"


def _onlyoffice_cli_hint() -> str:
    """ONLYOFFICE DesktopEditors treats CLI arguments as *local file paths* only, not http(s) URLs.

    Running ``desktopeditors 'https://…/webdav/…'`` makes the app look for a file literally named like
    the URL string, which surfaces as "file type is not supported". Many ONLYOFFICE Desktop builds also
    **do not** expose a generic "paste this WebDAV http(s) URL" flow like LibreOffice **Open Remote**;
    vendor docs focus on cloud/DMS integration instead. Use **Edit in browser** (Document Server), LibreOffice,
    or an OS WebDAV mount. We return an empty string so clients do not suggest a broken terminal command.
    """
    return ""


@router.post("/{file_id}/checkout-edit", response_model=FileDesktopCheckoutOut, status_code=status.HTTP_201_CREATED)
def checkout_desktop_edit(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileDesktopCheckoutOut:
    require_case_access(case_id, user, db)
    sess, row = acquire_file_edit_session(db, case_id=case_id, file_id=file_id, user=user)

    base = _canary_public_url()
    fn = Path(row.original_filename).name
    enc = quote(fn, safe="")
    file_url = f"{base}/webdav/sessions/{sess.token}/{enc}"
    folder_url = f"{base}/webdav/sessions/{sess.token}/"
    log.info(
        "checkout_edit file_id=%s case_id=%s webdav_origin=%s (if ONLYOFFICE never hits the server, logs will show "
        "this line but no following /webdav access lines)",
        row.id,
        case_id,
        base,
    )
    lo_exe = _libreoffice_cli_executable(fn)
    libreoffice_cli_hint = f"{lo_exe} {_shell_single_quote(file_url)}"
    onlyoffice_cli_hint = _onlyoffice_cli_hint()
    instructions = (
        "Open the WebDAV file URL in a desktop app that supports arbitrary WebDAV URLs (e.g. LibreOffice "
        "File → Open Remote). ONLYOFFICE Desktop often has no equivalent menu; prefer Canary "
        "\"Edit in browser (ONLYOFFICE)\" or mount the folder URL with davfs2/GVfs and open the file locally. "
        "The ONLYOFFICE terminal command does not accept http(s) URLs. Use Stop desktop editing when finished."
    )

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.checkout_edit",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id), "expires_at": sess.expires_at.isoformat()},
    )

    return FileDesktopCheckoutOut(
        token=sess.token,
        webdav_folder_url=folder_url,
        webdav_file_url=file_url,
        filename=fn,
        expires_at=sess.expires_at,
        instructions=instructions,
        libreoffice_cli_hint=libreoffice_cli_hint,
        onlyoffice_cli_hint=onlyoffice_cli_hint,
    )


@router.get("/{file_id}/onlyoffice-config", response_model=OnlyofficeEditorConfigOut)
def get_onlyoffice_editor_config(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OnlyofficeEditorConfigOut:
    require_case_access(case_id, user, db)
    secret = (os.getenv("ONLYOFFICE_JWT_SECRET") or "").strip()
    ds_public = (os.getenv("ONLYOFFICE_DS_PUBLIC_URL") or "").strip().rstrip("/")
    # DS→Canary: prefer explicit ONLYOFFICE_APP_URL_INTERNAL, else resolved IPv4 for `backend` (see onlyoffice_ssrf_url).
    internal = default_internal_base_for_ds()
    if not secret or not ds_public:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "In-browser editing is not configured. Set ONLYOFFICE_JWT_SECRET, "
                "and ONLYOFFICE_DS_PUBLIC_URL (see docker-compose)."
            ),
        )

    sess, row = acquire_file_edit_session(db, case_id=case_id, file_id=file_id, user=user)

    # Create a backup of the pre-edit content so the user can discard changes.
    ensure_files_root()
    src = (FILES_ROOT / row.storage_path).resolve()
    try:
        backup = Path(str(src) + ".oo_backup")
        if src.exists() and not backup.exists():
            shutil.copy2(src, backup)
    except Exception as exc:
        log.warning("Could not create OnlyOffice backup for file %s: %s", row.id, exc)

    types = _onlyoffice_types_for_file(row.original_filename)
    if not types:
        ext = Path(row.original_filename or "").suffix.lower().lstrip(".")
        mt = (row.mime_type or "").lower()
        if ext == "pdf" or mt == "application/pdf" or mt.endswith("/pdf"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="PDF files open in your browser from the case documents list, not in the in-browser editor.",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This file type is not supported by the in-browser editor.",
        )
    doc_type, file_type = types
    # Correct fileType when the extension claims old binary format but the file is actually OOXML/ZIP.
    # e.g. a .DOC file that is really a DOCX (Word 2007+) — OO DS reports "download failed" otherwise.
    file_type = _correct_file_type(file_type, src)

    def _base(env_name: str) -> str:
        return (os.getenv(env_name) or "").strip().rstrip("/")

    # Document Server downloads document.url from *inside* the onlyoffice container. Must use a Docker-reachable
    # base (usually http://backend:8000). CANARY_PUBLIC_URL / host LAN IPs belong in WebDAV links for browsers only.
    doc_explicit = _base("ONLYOFFICE_DOCUMENT_URL")
    doc_base = (normalize_onlyoffice_ssrf_base(doc_explicit) if doc_explicit else "") or internal
    cb_url = f"{internal}/onlyoffice/callback?case_id={case_id}&file_id={file_id}"

    fn = Path(row.original_filename).name
    enc = quote(fn, safe="")
    # DS downloads document.url server-side (inside Docker); must use the Docker-reachable base.
    doc_url_for_ds = f"{doc_base}/webdav/sessions/{sess.token}/{enc}"
    # Plain (non-JWT) document.url.
    #
    # IMPORTANT: do NOT run SSRF normalization for the browser URL.
    # Normalization rewrites many private-ish IP ranges to `http://backend:8000` so the
    # Document Server container can fetch. That rewrite breaks the browser-side iframe because
    # the browser cannot reach Docker-internal hosts.
    #
    # Prefer the browser's actual origin when proxied (Vite/nginx X-Forwarded-Host) so client-side
    # ONLYOFFICE fetches (e.g. print preview) do not target localhost:8000 while the tab is on :5173.
    _plain_base = onlyoffice_browser_public_base(request)
    doc_url_for_browser = f"{_plain_base}/webdav/sessions/{sess.token}/{enc}"

    if doc_base != internal:
        log.info(
            "onlyoffice_config file_id=%s document_base=%s callback_base=%s (DS must fetch document_url; "
            "watch backend logs for GET /webdav/sessions/...)",
            row.id,
            doc_base,
            internal,
        )
    else:
        log.info(
            "onlyoffice_config file_id=%s document_base=callback_base=%s — expect GET /webdav/sessions/... from DS",
            row.id,
            internal,
        )
    doc_key = f"{file_id}_{row.version or 1}_{secrets.token_hex(6)}"

    # Strict opening JWT: ONLYOFFICE browser signature docs show only ``document`` + ``editorConfig``.
    # Extra top-level signed keys (type, width, height, documentType) break validation on many DS builds
    # → "token not correctly formed", no download, no GET /webdav on Canary.
    #
    # ``lang``: Docs API uses two-letter ``en`` for English; DS ships a single ``en.json`` UI bundle (no UK-only pack).
    # ``region``: ``en-GB`` for UK date/currency defaults in spreadsheets and (DS 8.2+) ruler units unless ``customization.unit`` overrides.
    # Default *document proofing* language comes from the .docx (see ``docx_util._set_default_proofing_language_en_gb``), not from JWT.
    #
    # JWT document.url = Docker-internal URL (DS validates JWT and uses this to fetch the file).
    # Plain document.url = public URL (browser JS uses this; cannot reach Docker-internal hosts).
    # DS extracts document.url from the JWT, so the mismatch is intentional and harmless.
    jwt_payload: dict = {
        "document": {
            "title": fn,
            "url": doc_url_for_ds,
            "fileType": file_type,
            "key": doc_key,
            "permissions": dict(_ONLYOFFICE_DOC_PERMISSIONS),
        },
        "editorConfig": {
            "mode": "edit",
            "lang": "en",
            "region": "en-GB",
            "callbackUrl": cb_url,
            "user": {
                "id": str(user.id),
                "name": user.display_name or user.email,
                "group": "Canary",
            },
            "customization": {
                "forcesave": True,
                "unit": "cm",
                # Helps some Document Server builds with print/conversion edge cases when integrated behind a path proxy.
                "compatibleFeatures": True,
            },
        },
    }
    # PyJWT matches what ONLYOFFICE Document Server (Node jsonwebtoken) expects better than python-jose.
    token = pyjwt.encode(jwt_payload, secret, algorithm="HS256")
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    # Plain document dict for the browser: swap in the public URL so the browser can reach it.
    browser_document = dict(jwt_payload["document"])
    browser_document["url"] = doc_url_for_browser

    log.warning(
        "onlyoffice_jwt_built file_id=%s ds_doc_url=%s browser_doc_url=%s callback=%s",
        row.id,
        _redact_webdav_url_for_log(doc_url_for_ds),
        _redact_webdav_url_for_log(doc_url_for_browser),
        cb_url,
    )
    # Visible in browser DevTools → Network → onlyoffice-config → Response headers (token redacted).
    response.headers["X-Canary-Onlyoffice-Webdav-Url"] = _redact_webdav_url_for_log(doc_url_for_browser)

    response.headers["Cache-Control"] = "no-store"

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.onlyoffice_open",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id)},
    )

    return OnlyofficeEditorConfigOut(
        document_server_url=ds_public,
        token=token,
        document_type=doc_type,
        document=browser_document,
        editor_config=jwt_payload["editorConfig"],
    )


@router.post("/{file_id}/oo-force-save", status_code=status.HTTP_204_NO_CONTENT)
async def oo_force_save(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    doc_key: str = Query(..., description="OO DS document key from the editor config"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Tell OO DS to force-save now. DS will call back with status=6 and the backend will write the file."""
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    previous_version = row.version or 1

    secret = (os.getenv("ONLYOFFICE_JWT_SECRET") or "").strip()
    oo_internal = (os.getenv("ONLYOFFICE_DS_INTERNAL_URL") or "http://onlyoffice").strip().rstrip("/")
    cmd_url = f"{oo_internal}/coauthoring/CommandService.ashx"

    cmd_body: dict = {"c": "forcesave", "key": doc_key}
    token_str = pyjwt.encode(cmd_body, secret, algorithm="HS256")
    if isinstance(token_str, bytes):
        token_str = token_str.decode("utf-8")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(cmd_url, json={**cmd_body, "token": token_str})
            resp.raise_for_status()
            body = resp.json()
            if int(body.get("error", 1)) != 0:
                raise RuntimeError(f"CommandService error={body.get('error')}")
        log.info("oo_force_save: issued force-save for file %s doc_key=%s", file_id, doc_key)
    except Exception as exc:
        log.warning("oo_force_save: command service failed for file %s: %s", file_id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Force-save command failed — is the ONLYOFFICE service running?",
        )

    # Wait for ONLYOFFICE callback (status=6) to persist bytes.
    for _ in range(40):
        await asyncio.sleep(0.5)
        db.refresh(row)
        if (row.version or 1) > previous_version:
            return
    raise HTTPException(
        status_code=status.HTTP_504_GATEWAY_TIMEOUT,
        detail="Force-save timed out before the document was written. Keep the editor open and retry Save & Close.",
    )


@router.post("/{file_id}/publish-compose", status_code=status.HTTP_204_NO_CONTENT)
def publish_compose_office_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Show a compose-office document in the case file list (after OnlyOffice Save & Close).

    Idempotent: if the file is not a pending compose, succeeds with no change.
    """
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not row.oo_compose_pending:
        return
    row.oo_compose_pending = False
    row.updated_at = _utcnow()
    db.add(row)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.compose_publish",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id)},
    )


@router.post("/{file_id}/discard-edit", status_code=status.HTTP_204_NO_CONTENT)
def discard_onlyoffice_edit(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Discard in-browser edits: restore pre-edit backup and release the edit session."""
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    now = _utcnow()
    sess = db.execute(
        select(FileEditSession).where(
            FileEditSession.file_id == file_id,
            FileEditSession.user_id == user.id,
            FileEditSession.released_at.is_(None),
        )
    ).scalars().first()
    if sess is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active edit session")

    if row.oo_compose_pending:
        fid = row.id
        _erase_case_file_tree(db, case_id, file_id)
        log_event(
            db,
            actor_user_id=user.id,
            action="case.file.compose_discard",
            entity_type="file",
            entity_id=str(fid),
            meta={"case_id": str(case_id)},
        )
        return

    # Restore backup if available.
    ensure_files_root()
    try:
        abs_path = (FILES_ROOT / row.storage_path).resolve()
        backup = Path(str(abs_path) + ".oo_backup")
        if backup.exists():
            shutil.copy2(backup, abs_path)
            backup.unlink()
            log.info("discard_edit: restored backup for file %s", file_id)
    except Exception as exc:
        log.warning("discard_edit: could not restore backup for file %s: %s", file_id, exc)

    sess.released_at = now
    db.add(sess)
    db.commit()

    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.onlyoffice_discard",
        entity_type="file",
        entity_id=str(row.id),
        meta={"case_id": str(case_id)},
    )


@router.get("/{file_id}/edit-session", response_model=FileEditSessionStatusOut)
def get_desktop_edit_session(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileEditSessionStatusOut:
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    now = _utcnow()
    sess = (
        db.execute(
            select(FileEditSession)
            .where(
                FileEditSession.file_id == file_id,
                FileEditSession.user_id == user.id,
                FileEditSession.released_at.is_(None),
                FileEditSession.expires_at > now,
            )
            .order_by(FileEditSession.created_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )

    if not sess:
        return FileEditSessionStatusOut(active=False)

    base = _canary_public_url()
    fn = Path(row.original_filename).name
    enc = quote(fn, safe="")
    return FileEditSessionStatusOut(
        active=True,
        expires_at=sess.expires_at,
        webdav_file_url=f"{base}/webdav/sessions/{sess.token}/{enc}",
    )


@router.post("/{file_id}/release-edit", status_code=status.HTTP_204_NO_CONTENT)
def release_desktop_edit(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    now = _utcnow()
    sessions = (
        db.execute(
            select(FileEditSession).where(
                FileEditSession.file_id == file_id,
                FileEditSession.user_id == user.id,
                FileEditSession.released_at.is_(None),
                FileEditSession.expires_at > now,
            )
        )
        .scalars()
        .all()
    )
    if not sessions:
        return None
    for s in sessions:
        s.released_at = now
        db.add(s)
    db.commit()
    log_event(
        db,
        actor_user_id=user.id,
        action="case.file.release_edit",
        entity_type="file",
        entity_id=str(file_id),
        meta={"case_id": str(case_id)},
    )
    return None


@router.post("/{file_id}/eml-open-token")
def issue_eml_open_token(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not _row_is_eml_like(row):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only e-mail messages (.eml / RFC822) can be opened with your mail app.",
        )
    tok = create_eml_open_token(user_id=str(user.id), case_id=str(case_id), file_id=str(file_id))
    return {"token": tok}


@router.get("/{file_id}/eml-open")
def download_eml_for_mail_client(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    token: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
):
    """Serve the .eml with ``Content-Disposition: attachment`` so the browser hands off to the OS mail app (no blob: URL)."""
    try:
        payload = decode_eml_open_token(token)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired link")
    try:
        if uuid.UUID(payload.case_id) != case_id or uuid.UUID(payload.file_id) != file_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid link")
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid link")

    user = db.get(User, uuid.UUID(payload.user_id))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid link")
    require_case_access(case_id, user, db)

    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not _row_is_eml_like(row):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    ensure_files_root()
    abs_path = (FILES_ROOT / row.storage_path).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)) or not abs_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File missing on disk")

    fname = Path(row.original_filename).name
    if not fname.lower().endswith(".eml"):
        fname = f"{Path(fname).stem or 'message'}.eml"

    return FileResponse(
        path=str(abs_path),
        media_type="message/rfc822",
        filename=fname,
        content_disposition_type="attachment",
    )


@router.get("/{file_id}/outlook-open-hints", response_model=OutlookOpenHintsOut)
def get_case_file_outlook_open_hints(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OutlookOpenHintsOut:
    """Return stored Graph / OWA pointers; may backfill ``outlook_web_link`` when Graph is configured."""
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    try:
        repair_outlook_web_link_on_file(db, row)
    except Exception:
        log.warning("get_case_file_outlook_open_hints: repair web link failed", exc_info=True)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    gid = row.outlook_graph_message_id or row.source_outlook_item_id
    return OutlookOpenHintsOut(
        outlook_graph_message_id=gid,
        outlook_web_link=row.outlook_web_link,
    )


@router.get("/{file_id}")
def download_case_file(
    case_id: uuid.UUID,
    file_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    require_case_access(case_id, user, db)
    row = db.get(DbFile, file_id)
    if not row or row.case_id != case_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")

    # storage_path is relative to FILES_ROOT
    ensure_files_root()
    from app.file_storage import FILES_ROOT

    abs_path = (FILES_ROOT / row.storage_path).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)) or not abs_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File missing on disk")

    # Inline so a direct GET (or fetch → blob → window.open) does not imply a forced download.
    return FileResponse(
        path=str(abs_path),
        media_type=row.mime_type,
        filename=row.original_filename,
        content_disposition_type="inline",
    )
