"""
Minimal WebDAV subset for ONLYOFFICE Desktop (and similar) to open/save case files
without using the browser editor. Auth is an unguessable token in the path (use HTTPS in production).
"""

from __future__ import annotations

import html
import logging
import mimetypes
import os
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import quote, unquote
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.file_storage import FILES_ROOT, StoredFilePaths, ensure_files_root
from app.models import File as DbFile, FileCategory, FileEditSession, User
from app.routers.files import convert_case_upload_msg_to_eml_if_applicable, refresh_root_eml_mail_metadata
from app.audit import log_event
from app.canary_public_url import get_canary_public_base

router = APIRouter(prefix="/webdav", tags=["webdav"])
log = logging.getLogger(__name__)

DAV_NS = "DAV:"
LOCK_TOKEN_PREFIX = "opaquelocktoken:canary-"

# Office-style clients often expect lock discovery hints and etags in PROPFIND.
_SUPPORTED_LOCK_XML = """
      <d:supportedlock>
        <d:lockentry>
          <d:lockscope><d:exclusive/></d:lockscope>
          <d:locktype><d:write/></d:locktype>
        </d:lockentry>
      </d:supportedlock>"""


def _etag_for_file(frow: DbFile) -> str:
    return f'"{frow.version}-{frow.size_bytes}-{frow.id.hex[:12]}"'


def _http_range_interval(range_header: str | None, total_len: int) -> tuple[int, int] | None | str:
    """Parse a single ``Range: bytes=…`` value.

    Returns:
        ``None`` — send full body (200).
        ``(start, end)`` inclusive — partial content (206).
        ``"416"`` — unsatisfiable range.
    """
    if not range_header:
        return None
    rh = range_header.strip()
    if not rh.lower().startswith("bytes="):
        return None
    spec = rh[6:].strip().split(",", 1)[0].strip()
    if "-" not in spec:
        return None
    left, _, right = spec.partition("-")
    try:
        if left == "":
            if right == "":
                return None
            suffix_len = int(right)
            if suffix_len <= 0 or total_len == 0:
                return "416"
            start = max(0, total_len - suffix_len)
            end = total_len - 1
        else:
            start = int(left)
            end = int(right) if right != "" else total_len - 1
    except ValueError:
        return None

    if total_len == 0:
        return "416"
    if start >= total_len:
        return "416"
    end = min(end, total_len - 1)
    if start > end:
        return "416"
    return (start, end)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_session(db: Session, token: str) -> tuple[FileEditSession, DbFile] | None:
    row = db.execute(select(FileEditSession).where(FileEditSession.token == token)).scalar_one_or_none()
    if row is None:
        return None
    if row.released_at is not None or row.expires_at <= _now():
        return None
    f = db.get(DbFile, row.file_id)
    if f is None:
        return None
    return row, f


def _expected_filename(file_row: DbFile) -> str:
    return Path(file_row.original_filename).name


def _session_path_matches_filename(path_decoded: str, file_row: DbFile) -> bool:
    """Path segment must name this file; allow case-insensitive match (e.g. .DOC vs .doc)."""
    expected = _expected_filename(file_row)
    if path_decoded == expected:
        return True
    return path_decoded.lower() == expected.lower()


# ONLYOFFICE Desktop (and some WebDAV clients) infer format from Content-Type; uploads often store
# application/octet-stream or wrong types. Map extensions we support to canonical MIME types.
_WEBDAV_CANONICAL_MIME_BY_SUFFIX: dict[str, str] = {
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".dot": "application/msword",
    ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".rtf": "application/rtf",
    ".txt": "text/plain; charset=utf-8",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pps": "application/vnd.ms-powerpoint",
    ".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".pdf": "application/pdf",
}


def _effective_webdav_media_type(frow: DbFile) -> str:
    """Content-Type for GET/HEAD so desktop editors (e.g. ONLYOFFICE) accept the file."""
    name = _expected_filename(frow)
    ext = Path(name).suffix.lower()
    stored = (frow.mime_type or "").strip()
    base = stored.split(";", 1)[0].strip().lower()

    generic = base in ("application/octet-stream", "binary/octet-stream", "application/x-download", "")
    # DOCX/XLSX/PPTX are ZIP; browsers sometimes label Office uploads this way.
    suspicious = base in ("text/plain", "application/zip", "application/x-zip-compressed")

    guessed, _ = mimetypes.guess_type(name)

    if ext in _WEBDAV_CANONICAL_MIME_BY_SUFFIX and (generic or suspicious):
        chosen = _WEBDAV_CANONICAL_MIME_BY_SUFFIX[ext]
        if chosen != stored:
            log.debug(
                "webdav using canonical Content-Type %s for %s (stored=%s)",
                chosen,
                name,
                stored or "-",
            )
        return chosen

    if generic and guessed and guessed != "application/octet-stream":
        return guessed

    if generic and ext in _WEBDAV_CANONICAL_MIME_BY_SUFFIX:
        return _WEBDAV_CANONICAL_MIME_BY_SUFFIX[ext]

    return stored or guessed or "application/octet-stream"


def _collection_href(token: str) -> str:
    return f"/webdav/sessions/{token}/"


def _absolute_webdav_href(request: Request, path: str) -> str:
    """Build absolute URL for multistatus hrefs (LibreOffice/GIO often reject relative hrefs when listing).

    Prefer CANARY_PUBLIC_URL so hrefs match the same origin users paste from checkout-edit. If we echo
    internal hosts (docker service name, 127.0.0.1) while the client opened a public URL, desktop apps
    (e.g. ONLYOFFICE) may follow those hrefs and hang on \"Opening...\".
    """
    if not path.startswith("/"):
        path = f"/{path}"
    public = get_canary_public_base()
    if public:
        return f"{public}{path}"
    xf_host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    xf_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip()
    if xf_host:
        scheme = xf_proto or request.url.scheme or "http"
        return f"{scheme}://{xf_host}{path}"
    base = str(request.base_url).rstrip("/")
    return f"{base}{path}"


def _propstat_response(
    href: str,
    *,
    is_collection: bool,
    content_length: int | None,
    last_modified: datetime | None,
    displayname: str | None = None,
    content_type: str | None = None,
    etag: str | None = None,
    include_supportedlock: bool = False,
) -> str:
    if is_collection:
        res_type_block = "<d:resourcetype><d:collection/></d:resourcetype>"
    else:
        res_type_block = "<d:resourcetype/>"
    lm = ""
    if last_modified is not None:
        lm_dt = last_modified.replace(tzinfo=timezone.utc) if last_modified.tzinfo is None else last_modified.astimezone(timezone.utc)
        lm = f"<d:getlastmodified>{format_datetime(lm_dt, usegmt=True)}</d:getlastmodified>"
    cl = ""
    if content_length is not None:
        cl = f"<d:getcontentlength>{content_length}</d:getcontentlength>"
    dn = ""
    if displayname is not None:
        dn = f"<d:displayname>{html.escape(displayname, quote=True)}</d:displayname>"
    ct = ""
    if content_type is not None:
        ct = f"<d:getcontenttype>{html.escape(content_type, quote=True)}</d:getcontenttype>"
    et = ""
    if etag is not None:
        et = f"<d:getetag>{html.escape(etag, quote=True)}</d:getetag>"
    sl = _SUPPORTED_LOCK_XML if include_supportedlock else ""
    href_esc = html.escape(href, quote=True)
    return f"""<d:response>
  <d:href>{href_esc}</d:href>
  <d:propstat>
    <d:prop>
      {res_type_block}
      {dn}
      {lm}
      {cl}
      {ct}
      {et}
      {sl}
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>"""


def _multistatus(xml_inner: str) -> str:
    return f"""<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="{DAV_NS}">
{xml_inner}
</d:multistatus>"""


def _xml_response(body: str, status_code: int = 207) -> Response:
    return Response(
        content=body,
        status_code=status_code,
        media_type='application/xml; charset="utf-8"',
    )


@router.api_route("/sessions/{token}", methods=["OPTIONS"], response_model=None)
def webdav_session_options(token: str) -> Response:
    return Response(
        status_code=200,
        headers={
            "Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT",
            "DAV": "1, 2",
            "MS-Author-Via": "DAV",
        },
    )


@router.api_route("/sessions/{token}/", methods=["OPTIONS"], response_model=None)
def webdav_session_options_slash(token: str) -> Response:
    return webdav_session_options(token)


@router.api_route("/sessions/{token}", methods=["GET"], response_model=None)
@router.api_route("/sessions/{token}/", methods=["GET"], response_model=None)
def webdav_collection_get_not_allowed(token: str) -> Response:
    """LibreOffice/GVfs sometimes probe collections with GET; 404 breaks folder UI — use explicit 405."""
    return Response(
        status_code=405,
        headers={"Allow": "OPTIONS, PROPFIND"},
    )


@router.api_route("/sessions/{token}/{filename}", methods=["OPTIONS"], response_model=None)
def webdav_file_options(token: str, filename: str) -> Response:
    return Response(
        status_code=200,
        headers={
            "Allow": "OPTIONS, PROPFIND, GET, HEAD, PUT, LOCK, UNLOCK",
            "DAV": "1, 2",
            "MS-Author-Via": "DAV",
        },
    )


@router.api_route("/sessions/{token}", methods=["PROPFIND"], response_model=None)
@router.api_route("/sessions/{token}/", methods=["PROPFIND"], response_model=None)
def webdav_propfind_collection(request: Request, token: str, db: Session = Depends(get_db)) -> Response:
    log.info(
        "webdav PROPFIND collection %s depth=%s origin=%s ua=%s",
        request.url.path,
        request.headers.get("depth", "-"),
        (request.headers.get("origin") or "-")[:80],
        (request.headers.get("user-agent") or "-")[:100],
    )
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    _sess, frow = loaded
    depth = request.headers.get("Depth", "1").strip()
    fname = _expected_filename(frow)
    chref_rel = _collection_href(token)
    chref_abs = _absolute_webdav_href(request, chref_rel)
    # Child href must match how clients will GET (encoded filename in path)
    fenc = quote(fname, safe="")
    child_rel = f"/webdav/sessions/{token}/{fenc}"
    child_abs = _absolute_webdav_href(request, child_rel)

    abs_path = (FILES_ROOT / frow.storage_path).resolve()
    clen = abs_path.stat().st_size if abs_path.exists() else 0
    inner = _propstat_response(
        chref_abs,
        is_collection=True,
        content_length=None,
        last_modified=None,
        displayname="",
        include_supportedlock=True,
    )
    # Depth 0: collection only. Depth 1 / infinity / unset: include the file resource.
    if depth not in ("0",):
        media = _effective_webdav_media_type(frow)
        inner += _propstat_response(
            child_abs,
            is_collection=False,
            content_length=clen,
            last_modified=frow.updated_at or frow.created_at,
            displayname=fname,
            content_type=media,
            etag=_etag_for_file(frow),
            include_supportedlock=True,
        )
    return _xml_response(_multistatus(inner))


@router.api_route("/sessions/{token}/{filename}", methods=["PROPFIND"], response_model=None)
def webdav_propfind_file(
    request: Request,
    token: str,
    filename: str,
    db: Session = Depends(get_db),
) -> Response:
    log.info(
        "webdav PROPFIND file %s depth=%s origin=%s ua=%s",
        request.url.path,
        request.headers.get("depth", "-"),
        (request.headers.get("origin") or "-")[:80],
        (request.headers.get("user-agent") or "-")[:100],
    )
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    _sess, frow = loaded
    decoded = unquote(filename)
    if not _session_path_matches_filename(decoded, frow):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    abs_path = (FILES_ROOT / frow.storage_path).resolve()
    clen = abs_path.stat().st_size if abs_path.exists() else 0
    href_rel = f"/webdav/sessions/{token}/{quote(_expected_filename(frow), safe='')}"
    href_abs = _absolute_webdav_href(request, href_rel)
    media = _effective_webdav_media_type(frow)
    inner = _propstat_response(
        href_abs,
        is_collection=False,
        content_length=clen,
        last_modified=frow.updated_at or frow.created_at,
        displayname=_expected_filename(frow),
        content_type=media,
        etag=_etag_for_file(frow),
        include_supportedlock=True,
    )
    return _xml_response(_multistatus(inner))


@router.api_route("/sessions/{token}/{filename}", methods=["GET", "HEAD"], response_model=None)
def webdav_get_file(
    request: Request,
    token: str,
    filename: str,
    db: Session = Depends(get_db),
) -> Response:
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    _sess, frow = loaded
    decoded = unquote(filename)
    if not _session_path_matches_filename(decoded, frow):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    ensure_files_root()
    abs_path = (FILES_ROOT / frow.storage_path).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)) or not abs_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    data = abs_path.read_bytes()
    total_len = len(data)
    media_type = _effective_webdav_media_type(frow)
    last_mod = frow.updated_at or frow.created_at
    if last_mod is not None:
        # Python 3.12 format_datetime(usegmt=True) requires tzinfo == datetime.timezone.utc exactly.
        # psycopg3 returns ZoneInfo('Etc/UTC') which has utcoffset()==0 but fails that check.
        last_mod = last_mod.replace(tzinfo=timezone.utc) if last_mod.tzinfo is None else last_mod.astimezone(timezone.utc)
    last_mod_hdr = format_datetime(last_mod, usegmt=True) if last_mod else None
    etag = _etag_for_file(frow)

    range_hdr = request.headers.get("range")
    interval = _http_range_interval(range_hdr, total_len)
    # If-Range mismatch → ignore Range and send full representation (RFC 7233).
    if_range = (request.headers.get("if-range") or "").strip()
    if if_range and interval is not None:
        ir = if_range[2:].strip() if if_range.upper().startswith("W/") else if_range
        et = etag[2:].strip() if etag.upper().startswith("W/") else etag
        if ir.strip('"') != et.strip('"'):
            interval = None

    base_headers: dict[str, str] = {
        "Accept-Ranges": "bytes",
        "ETag": etag,
        "MS-Author-Via": "DAV",
    }
    if last_mod_hdr:
        base_headers["Last-Modified"] = last_mod_hdr

    if interval == "416":
        base_headers["Content-Range"] = f"bytes */{total_len}"
        log.info(
            "webdav %s file_id=%s 416 range=%r total=%s",
            request.method,
            frow.id,
            range_hdr,
            total_len,
        )
        return Response(status_code=416, media_type=media_type, headers=base_headers)

    if interval is None:
        body = data
        status_code = 200
    else:
        start, end = interval
        body = data[start : end + 1]
        status_code = 206
        base_headers["Content-Range"] = f"bytes {start}-{end}/{total_len}"

    base_headers["Content-Length"] = str(len(body))

    ua = (request.headers.get("user-agent") or "")[:120]
    log.info(
        "webdav %s file_id=%s status=%s bytes=%s/%s range=%r ua=%s",
        request.method,
        frow.id,
        status_code,
        len(body),
        total_len,
        range_hdr,
        ua or "-",
    )

    if request.method == "HEAD":
        return Response(status_code=status_code, media_type=media_type, headers=base_headers)

    return Response(content=body, status_code=status_code, media_type=media_type, headers=base_headers)


@router.api_route("/sessions/{token}/{filename}", methods=["PUT"], response_model=None)
async def webdav_put_file(
    request: Request,
    token: str,
    filename: str,
    db: Session = Depends(get_db),
) -> Response:
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    sess, frow = loaded
    decoded = unquote(filename)
    if not _session_path_matches_filename(decoded, frow):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if frow.category == FileCategory.system:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")

    ensure_files_root()
    abs_path = (FILES_ROOT / frow.storage_path).resolve()
    if not str(abs_path).startswith(str(FILES_ROOT)):
        raise HTTPException(status_code=500, detail="Invalid storage path")

    abs_path.parent.mkdir(parents=True, exist_ok=True)
    with abs_path.open("wb") as out:
        async for chunk in request.stream():
            if chunk:
                out.write(chunk)

    paths_wrap = StoredFilePaths(abs_path=abs_path, rel_path=frow.storage_path, folder_path=frow.folder_path or "")
    prev_name = frow.original_filename
    original_fn, new_paths, new_size = convert_case_upload_msg_to_eml_if_applicable(
        case_id=frow.case_id,
        file_id=frow.id,
        folder_path=frow.folder_path or "",
        original_filename=frow.original_filename,
        paths=paths_wrap,
    )
    frow.storage_path = new_paths.rel_path
    frow.original_filename = original_fn
    frow.size_bytes = new_size
    if prev_name.lower().endswith(".msg") and original_fn.lower().endswith(".eml"):
        frow.mime_type = "message/rfc822"
        uploader = db.get(User, sess.user_id)
        refresh_root_eml_mail_metadata(frow, new_paths.abs_path, uploader_email=uploader.email if uploader else None)

    frow.version = (frow.version or 1) + 1
    frow.updated_at = _now()
    db.add(frow)
    log_event(
        db,
        actor_user_id=sess.user_id,
        action="case.file.webdav_put",
        entity_type="file",
        entity_id=str(frow.id),
        meta={"case_id": str(frow.case_id), "version": frow.version, "size_bytes": new_size},
    )
    return Response(status_code=204)


@router.api_route("/sessions/{token}/{filename}", methods=["LOCK"], response_model=None)
def webdav_lock(token: str, filename: str, request: Request, db: Session = Depends(get_db)) -> Response:
    """Return a trivial lock so picky clients accept the resource as writable."""
    log.info(
        "webdav LOCK %s ua=%s",
        request.url.path,
        (request.headers.get("user-agent") or "-")[:100],
    )
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    _sess, frow = loaded
    decoded = unquote(filename)
    if not _session_path_matches_filename(decoded, frow):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    opaque = f"{LOCK_TOKEN_PREFIX}{token[:16]}"
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="{DAV_NS}">
  <d:lockdiscovery>
    <d:activelock>
      <d:locktype><d:write/></d:locktype>
      <d:lockscope><d:exclusive/></d:lockscope>
      <d:depth>infinity</d:depth>
      <d:timeout>Infinite</d:timeout>
      <d:owner><d:href>http://canary/webdav</d:href></d:owner>
      <d:locktoken><d:href>{html.escape(opaque, quote=True)}</d:href></d:locktoken>
    </d:activelock>
  </d:lockdiscovery>
</d:prop>"""
    return Response(
        content=body,
        status_code=200,
        media_type='application/xml; charset="utf-8"',
        headers={"Lock-Token": f"<{opaque}>"},
    )


@router.api_route("/sessions/{token}/{filename}", methods=["UNLOCK"], response_model=None)
def webdav_unlock(token: str, filename: str, db: Session = Depends(get_db)) -> Response:
    loaded = _load_session(db, token)
    if not loaded:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    _sess, frow = loaded
    decoded = unquote(filename)
    if not _session_path_matches_filename(decoded, frow):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return Response(status_code=204)
