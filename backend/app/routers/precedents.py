"""Precedent library: list for all users; upload/manage for admins."""

from __future__ import annotations

import mimetypes
import os
import secrets
import shutil
import asyncio
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File as FastAPIFile, Form, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.audit import log_event
from app.db import get_db
from app.deps import get_current_user, require_admin
from app.file_storage import FILES_ROOT, ensure_files_root, precedent_file_paths

from app.models import (
    File as DbFile,
    FileCategory,
    FileEditSession,
    MatterHeadType,
    MatterSubType,
    Precedent,
    PrecedentCategory,
    PrecedentKind,
    User,
)
from app.schemas import OnlyofficeEditorConfigOut, PrecedentOut, PrecedentUpdate

router = APIRouter(prefix="/precedents", tags=["precedents"])

# Form/API token: use this for "Global" in matter head, sub-type, or category dropdowns.
GLOBAL_SCOPE = "__GLOBAL__"


def _scope_summary(
    p: Precedent,
    *,
    category_name: str | None,
    head_name: str | None,
    sub_name: str | None,
) -> str:
    if p.matter_head_type_id is None and p.matter_sub_type_id is None and p.category_id is None:
        return "Global — all cases"
    if p.matter_sub_type_id is None and p.category_id is None:
        return f"All sub-types — {head_name or '—'}"
    if p.category_id is None:
        return f"All categories — {sub_name or '—'}"
    return category_name or "—"


def _precedent_out(db: Session, p: Precedent, f: DbFile) -> PrecedentOut:
    cat_name: str | None = None
    head_name: str | None = None
    sub_name: str | None = None
    if p.category_id:
        c = db.get(PrecedentCategory, p.category_id)
        cat_name = c.name if c else None
    if p.matter_head_type_id:
        h = db.get(MatterHeadType, p.matter_head_type_id)
        head_name = h.name if h else None
    if p.matter_sub_type_id:
        s = db.get(MatterSubType, p.matter_sub_type_id)
        sub_name = s.name if s else None
    summary = _scope_summary(p, category_name=cat_name, head_name=head_name, sub_name=sub_name)
    return PrecedentOut(
        id=p.id,
        name=p.name,
        reference=p.reference,
        kind=p.kind,
        original_filename=f.original_filename,
        mime_type=f.mime_type,
        category_id=p.category_id,
        matter_head_type_id=p.matter_head_type_id,
        matter_sub_type_id=p.matter_sub_type_id,
        category_name=cat_name,
        matter_head_type_name=head_name,
        matter_sub_type_name=sub_name,
        scope_summary=summary,
        created_at=p.created_at,
    )


def _validate_scope_uuids(
    db: Session,
    mh: uuid.UUID | None,
    ms: uuid.UUID | None,
    cid: uuid.UUID | None,
) -> None:
    if mh is None and ms is None and cid is None:
        return
    if mh is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Matter head type is required unless the precedent is global for all cases",
        )
    if db.get(MatterHeadType, mh) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter head type not found")
    if ms is None and cid is None:
        return
    if ms is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Matter sub-type is required when a precedent category is set",
        )
    sub = db.get(MatterSubType, ms)
    if not sub or sub.head_type_id != mh:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Matter sub-type does not belong to the selected matter head type",
        )
    if cid is None:
        return
    cat = db.get(PrecedentCategory, cid)
    if not cat or cat.matter_sub_type_id != ms:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Precedent category does not belong to the selected matter sub-type",
        )


def _parse_precedent_scope_form(
    db: Session,
    *,
    matter_head_type_id: str,
    matter_sub_type_id: str,
    category_id: str,
) -> tuple[uuid.UUID | None, uuid.UUID | None, uuid.UUID | None]:
    g = GLOBAL_SCOPE
    h = (matter_head_type_id or "").strip()
    s = (matter_sub_type_id or "").strip()
    c = (category_id or "").strip()
    if not h or h == g:
        if (s and s != g) or (c and c != g):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="When matter head is Global, matter sub-type and precedent category must be Global",
            )
        return None, None, None
    try:
        head_u = uuid.UUID(h)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid matter head type id")
    if db.get(MatterHeadType, head_u) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Matter head type not found")
    if not s or s == g:
        if c and c != g:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="When matter sub-type is Global, precedent category must be Global",
            )
        return head_u, None, None
    try:
        sub_u = uuid.UUID(s)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid matter sub-type id")
    sub = db.get(MatterSubType, sub_u)
    if not sub or sub.head_type_id != head_u:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Matter sub-type does not belong to the selected matter head type",
        )
    if not c or c == g:
        return head_u, sub_u, None
    try:
        cat_u = uuid.UUID(c)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid precedent category id")
    cat = db.get(PrecedentCategory, cat_u)
    if not cat or cat.matter_sub_type_id != sub_u:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Precedent category does not belong to the selected matter sub-type",
        )
    return head_u, sub_u, cat_u


@router.get("", response_model=list[PrecedentOut])
def list_precedents(
    kind: PrecedentKind | None = None,
    category_id: uuid.UUID | None = None,
    matter_sub_type_id: uuid.UUID | None = None,
    matter_head_type_id: uuid.UUID | None = None,
    global_precedents_only: bool = False,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PrecedentOut]:
    if global_precedents_only:
        q = select(Precedent).where(
            Precedent.matter_head_type_id.is_(None),
            Precedent.matter_sub_type_id.is_(None),
            Precedent.category_id.is_(None),
        )
    elif matter_sub_type_id is not None:
        if category_id is not None:
            cat = db.get(PrecedentCategory, category_id)
            if cat is None or cat.matter_sub_type_id != matter_sub_type_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="category_id does not belong to this matter sub-type",
                )
        sub = db.get(MatterSubType, matter_sub_type_id)
        if sub is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter sub-type not found")
        head_id = sub.head_type_id
        scope_global = and_(
            Precedent.matter_head_type_id.is_(None),
            Precedent.matter_sub_type_id.is_(None),
            Precedent.category_id.is_(None),
        )
        scope_head = and_(
            Precedent.matter_head_type_id == head_id,
            Precedent.matter_sub_type_id.is_(None),
            Precedent.category_id.is_(None),
        )
        scope_sub = and_(Precedent.matter_sub_type_id == matter_sub_type_id, Precedent.category_id.is_(None))
        scope_cat = and_(
            Precedent.category_id.isnot(None),
            PrecedentCategory.matter_sub_type_id == matter_sub_type_id,
        )
        q = (
            select(Precedent)
            .outerjoin(PrecedentCategory, Precedent.category_id == PrecedentCategory.id)
            .where(or_(scope_global, scope_head, scope_sub, scope_cat))
        )
        if category_id is not None:
            q = q.where(or_(Precedent.category_id.is_(None), Precedent.category_id == category_id))
    elif matter_head_type_id is not None:
        if db.get(MatterHeadType, matter_head_type_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Matter head type not found")
        scope_global = and_(
            Precedent.matter_head_type_id.is_(None),
            Precedent.matter_sub_type_id.is_(None),
            Precedent.category_id.is_(None),
        )
        scope_head = and_(
            Precedent.matter_head_type_id == matter_head_type_id,
            Precedent.matter_sub_type_id.is_(None),
            Precedent.category_id.is_(None),
        )
        q = select(Precedent).where(or_(scope_global, scope_head))
    else:
        q = select(Precedent)

    if kind is not None:
        q = q.where(Precedent.kind == kind)
    q = q.order_by(Precedent.created_at.desc())
    rows = db.execute(q).scalars().all()
    out: list[PrecedentOut] = []
    for p in rows:
        f = db.get(DbFile, p.file_id)
        if not f:
            continue
        out.append(_precedent_out(db, p, f))
    return out


@router.post("", response_model=PrecedentOut, status_code=status.HTTP_201_CREATED)
def upload_precedent(
    upload: UploadFile = FastAPIFile(...),
    name: str = Form(...),
    reference: str = Form(...),
    kind: PrecedentKind = Form(...),
    matter_head_type_id: str = Form(GLOBAL_SCOPE),
    matter_sub_type_id: str = Form(GLOBAL_SCOPE),
    category_id: str = Form(GLOBAL_SCOPE),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PrecedentOut:
    mh, ms, cat_uuid = _parse_precedent_scope_form(
        db,
        matter_head_type_id=matter_head_type_id,
        matter_sub_type_id=matter_sub_type_id,
        category_id=category_id,
    )

    ensure_files_root()
    precedent_id = uuid.uuid4()
    file_id = uuid.uuid4()
    original = upload.filename or "precedent.bin"
    paths = precedent_file_paths(precedent_id=precedent_id, file_id=file_id, original_filename=original)

    size = 0
    with paths.abs_path.open("wb") as fh:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            fh.write(chunk)

    mime = upload.content_type or (mimetypes.guess_type(original)[0] or "application/octet-stream")
    if mime.split(";", 1)[0].strip().lower() == "application/octet-stream":
        g = mimetypes.guess_type(original)[0]
        if g:
            mime = g

    now = datetime.utcnow()
    frow = DbFile(
        id=file_id,
        case_id=None,
        owner_id=admin.id,
        category=FileCategory.precedent,
        storage_path=paths.rel_path,
        folder_path="",
        parent_file_id=None,
        is_pinned=False,
        original_filename=Path(original).name,
        mime_type=mime,
        size_bytes=size,
        version=1,
        checksum=None,
        created_at=now,
        updated_at=now,
    )
    prow = Precedent(
        id=precedent_id,
        name=name.strip(),
        reference=reference.strip(),
        kind=kind,
        file_id=file_id,
        matter_head_type_id=mh,
        matter_sub_type_id=ms,
        category_id=cat_uuid,
        created_at=now,
        updated_at=now,
    )
    db.add(frow)
    db.add(prow)
    db.commit()
    db.refresh(prow)
    log_event(
        db,
        actor_user_id=admin.id,
        action="precedent.create",
        entity_type="precedent",
        entity_id=str(prow.id),
        meta={"kind": kind.value, "name": prow.name},
    )
    return _precedent_out(db, prow, frow)


@router.patch("/{precedent_id}", response_model=PrecedentOut)
def update_precedent(
    precedent_id: uuid.UUID,
    payload: PrecedentUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> PrecedentOut:
    p = db.get(Precedent, precedent_id)
    if not p:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
    f = db.get(DbFile, p.file_id)
    if not f:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file missing")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        p.name = data["name"].strip()
    if "reference" in data:
        p.reference = data["reference"].strip()
    scope_keys = ("matter_head_type_id", "matter_sub_type_id", "category_id")
    if any(k in data for k in scope_keys):
        mh = data.get("matter_head_type_id", p.matter_head_type_id)
        ms = data.get("matter_sub_type_id", p.matter_sub_type_id)
        cid = data.get("category_id", p.category_id)
        _validate_scope_uuids(db, mh, ms, cid)
        p.matter_head_type_id = mh
        p.matter_sub_type_id = ms
        p.category_id = cid
    p.updated_at = datetime.utcnow()
    db.add(p)
    db.commit()
    db.refresh(p)
    return _precedent_out(db, p, f)


@router.get("/{precedent_id}/onlyoffice-config", response_model=OnlyofficeEditorConfigOut)
def get_precedent_onlyoffice_config(
    precedent_id: uuid.UUID,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OnlyofficeEditorConfigOut:
    """Return an OnlyOffice editor config for editing a precedent template (admin or any user)."""
    import jwt as pyjwt  # PyJWT — same alias used in files.py

    from app.desktop_edit_session import acquire_file_edit_session
    from app.canary_public_url import onlyoffice_browser_public_base
    from app.onlyoffice_ssrf_url import default_internal_base_for_ds, normalize_onlyoffice_ssrf_base
    from app.routers.files import _correct_file_type, _onlyoffice_types_for_file, _ONLYOFFICE_DOC_PERMISSIONS

    p = db.get(Precedent, precedent_id)
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
    f = db.get(DbFile, p.file_id)
    if f is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file missing")

    secret = (os.getenv("ONLYOFFICE_JWT_SECRET") or "").strip()
    ds_public = (os.getenv("ONLYOFFICE_DS_PUBLIC_URL") or "").strip().rstrip("/")
    if not secret or not ds_public:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="In-browser editing is not configured.",
        )

    # Reuse the existing file-edit-session infrastructure — pass case_id=None for precedents
    sess, row = acquire_file_edit_session(db, case_id=None, file_id=f.id, user=user)

    ensure_files_root()
    src = (FILES_ROOT / row.storage_path).resolve()
    try:
        backup = Path(str(src) + ".oo_backup")
        if src.exists() and not backup.exists():
            shutil.copy2(src, backup)
    except Exception:
        pass

    types = _onlyoffice_types_for_file(row.original_filename)
    if not types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File type not supported by editor.")
    doc_type, file_type = types
    file_type = _correct_file_type(file_type, src)

    internal = default_internal_base_for_ds()
    doc_explicit = (os.getenv("ONLYOFFICE_DOCUMENT_URL") or "").strip().rstrip("/")
    doc_base = (normalize_onlyoffice_ssrf_base(doc_explicit) if doc_explicit else "") or internal
    cb_url = f"{internal}/onlyoffice/callback?precedent_id={precedent_id}"

    fn = Path(row.original_filename).name
    enc = quote(fn, safe="")
    doc_url_for_ds = f"{doc_base}/webdav/sessions/{sess.token}/{enc}"
    _plain_base = onlyoffice_browser_public_base(request)
    doc_url_for_browser = f"{_plain_base}/webdav/sessions/{sess.token}/{enc}"

    doc_key = f"prec_{precedent_id}_{row.version or 1}_{secrets.token_hex(6)}"
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
            "user": {"id": str(user.id), "name": user.display_name or user.email, "group": "Canary"},
            "customization": {"forcesave": True, "unit": "cm", "compatibleFeatures": True},
        },
    }
    token = pyjwt.encode(jwt_payload, secret, algorithm="HS256")
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    browser_document = dict(jwt_payload["document"])
    browser_document["url"] = doc_url_for_browser

    response.headers["Cache-Control"] = "no-store"
    return OnlyofficeEditorConfigOut(
        document_server_url=ds_public,
        token=token,
        document_type=doc_type,
        document=browser_document,
        editor_config=jwt_payload["editorConfig"],
    )


@router.post("/{precedent_id}/oo-force-save", status_code=status.HTTP_204_NO_CONTENT)
async def oo_force_save_precedent(
    precedent_id: uuid.UUID,
    doc_key: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    p = db.get(Precedent, precedent_id)
    if not p:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
    row = db.get(DbFile, p.file_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent file missing")
    previous_version = row.version or 1

    import jwt as pyjwt
    import httpx

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
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Force-save command failed — is the ONLYOFFICE service running?",
        ) from exc

    for _ in range(40):
        await asyncio.sleep(0.5)
        db.refresh(row)
        if (row.version or 1) > previous_version:
            return
    raise HTTPException(
        status_code=status.HTTP_504_GATEWAY_TIMEOUT,
        detail="Force-save timed out before the template was written. Keep the editor open and retry Save & Close.",
    )


@router.delete("/{precedent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_precedent(
    precedent_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> None:
    p = db.get(Precedent, precedent_id)
    if not p:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Precedent not found")
    f = db.get(DbFile, p.file_id)
    db.delete(p)
    if f:
        abs_path = (FILES_ROOT / f.storage_path).resolve()
        db.delete(f)
    db.commit()
    if f and str(abs_path).startswith(str(FILES_ROOT)) and abs_path.is_file():
        try:
            abs_path.unlink()
        except OSError:
            pass
    log_event(
        db,
        actor_user_id=admin.id,
        action="precedent.delete",
        entity_type="precedent",
        entity_id=str(precedent_id),
        meta={},
    )
