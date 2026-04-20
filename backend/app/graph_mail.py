"""Microsoft Graph: create Outlook drafts (application permissions + admin consent)."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from urllib.parse import quote, parse_qs, parse_qsl, urlparse, urlencode

import httpx

log = logging.getLogger(__name__)


def graph_mail_configured() -> bool:
    return bool(
        (os.getenv("CANARY_MS_GRAPH_TENANT_ID") or "").strip()
        and (os.getenv("CANARY_MS_GRAPH_CLIENT_ID") or "").strip()
        and (os.getenv("CANARY_MS_GRAPH_CLIENT_SECRET") or "").strip()
    )


def _token_endpoint() -> str:
    tenant = (os.getenv("CANARY_MS_GRAPH_TENANT_ID") or "").strip()
    if not tenant:
        raise RuntimeError("CANARY_MS_GRAPH_TENANT_ID is not set.")
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"


def app_access_token() -> str:
    client_id = (os.getenv("CANARY_MS_GRAPH_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("CANARY_MS_GRAPH_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise RuntimeError("CANARY_MS_GRAPH_CLIENT_ID / CANARY_MS_GRAPH_CLIENT_SECRET are not set.")
    token_url = _token_endpoint()
    payload = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
        "scope": "https://graph.microsoft.com/.default",
    }
    try:
        with httpx.Client(timeout=25.0) as client:
            res = client.post(token_url, data=payload)
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft login to obtain a Graph token: {e}") from e
    if res.status_code >= 400:
        txt = (res.text or "").strip()
        raise RuntimeError(f"Microsoft Graph token request failed ({res.status_code}): {txt[:700]}")
    try:
        token_body = res.json()
    except json.JSONDecodeError:
        raise RuntimeError(
            f"Microsoft Graph token response was not JSON ({res.status_code}): {(res.text or '')[:500]}",
        ) from None
    tok = token_body.get("access_token")
    if not isinstance(tok, str) or not tok.strip():
        raise RuntimeError("Microsoft Graph token response did not include access_token.")
    return tok


def _owa_mail_base_for_compose_deeplinks() -> str:
    raw = (os.getenv("CANARY_OUTLOOK_WEB_MAIL_BASE") or "https://outlook.office.com/mail").strip().rstrip("/")
    try:
        host = (urlparse(raw if "://" in raw else f"https://{raw}").hostname or "").lower()
    except Exception:
        host = ""
    if host == "outlook.office365.com":
        return "https://outlook.office.com/mail"
    return raw


def _normalize_outlook_office365_web_link_to_office_com(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return u
    return re.sub(
        r"^https?://outlook\.office365\.com(?=/|$)",
        "https://outlook.office.com",
        u,
        count=1,
        flags=re.IGNORECASE,
    )


def _item_web_link_from_create_body(body: dict) -> str | None:
    wl = body.get("webLink")
    if not isinstance(wl, str) or not wl.strip().startswith(("http://", "https://")):
        return None
    return _normalize_outlook_office365_web_link_to_office_com(wl.strip())


def _owa_compose_path_token(body: dict) -> str:
    draft_id = body.get("id")
    if not isinstance(draft_id, str) or not draft_id.strip():
        raise RuntimeError("Microsoft Graph created the draft but did not return an id.")
    web_link = body.get("webLink")
    if isinstance(web_link, str) and web_link.strip():
        try:
            q = urlparse(web_link.strip()).query
            if q:
                pairs = parse_qs(q, keep_blank_values=False)
                for key in ("ItemID", "itemid", "ItemId"):
                    vals = pairs.get(key)
                    if vals and isinstance(vals[0], str) and vals[0].strip():
                        return vals[0].strip()
        except Exception:
            pass
    return draft_id.strip()


def _build_owa_compose_deeplink(owa_base: str, body: dict) -> str:
    owa_base = owa_base.rstrip("/")
    web_link = body.get("webLink")
    if isinstance(web_link, str) and web_link.strip():
        try:
            pq = urlparse(web_link.strip())
            if pq.query:
                pairs: list[tuple[str, str]] = []
                for k, v in parse_qsl(pq.query, keep_blank_values=False):
                    if k.lower() == "viewmodel":
                        continue
                    pairs.append((k, v))
                if any(k.lower() == "itemid" for k, _ in pairs):
                    pairs = [(k, v) for k, v in pairs if k.lower() != "popoutv2"]
                    pairs.append(("popoutv2", "1"))
                    return f"{owa_base}/deeplink/compose?{urlencode(pairs, doseq=True)}"
        except Exception:
            pass
    token = _owa_compose_path_token(body)
    return f"{owa_base}/deeplink/compose/{quote(token, safe='')}?popoutv2=1"


def outlook_category_names() -> list[str]:
    raw = (os.getenv("CANARY_OUTLOOK_CATEGORY_NAME") or "Canary").strip()
    return [raw] if raw else []


def create_outlook_draft(
    mailbox_user: str,
    *,
    to_addr: str,
    subject: str,
    body_text: str,
    attachments: list[tuple[str, str, bytes]],
) -> tuple[str, str | None, str | None, str | None]:
    """
    Create a draft via Graph. Returns
    (primary_browser_url, graph_message_id, compose_deeplink_or_none, internet_message_id_or_none).
    """
    token = app_access_token()
    mailbox = mailbox_user.strip()
    if not mailbox:
        raise RuntimeError("Mailbox user principal name is required.")

    att_json: list[dict] = []
    for fname, mime, content in attachments:
        b64 = base64.b64encode(content).decode("ascii")
        att_json.append(
            {
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": fname,
                "contentType": mime or "application/octet-stream",
                "contentBytes": b64,
            }
        )

    cats = outlook_category_names()
    msg: dict = {
        "subject": (subject or "").strip() or "Draft",
        "isDraft": True,
        "body": {
            "contentType": "Text",
            "content": (body_text or "").strip(),
        },
    }
    if cats:
        msg["categories"] = cats
    to_clean = (to_addr or "").strip()
    if to_clean:
        msg["toRecipients"] = [{"emailAddress": {"address": to_clean}}]
    if att_json:
        msg["attachments"] = att_json

    url = f"https://graph.microsoft.com/v1.0/users/{quote(mailbox)}/messages"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=90.0) as client:
            res = client.post(url, headers=headers, json=msg)
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft Graph to create the draft: {e}") from e
    if res.status_code >= 400:
        txt = (res.text or "").strip()
        raise RuntimeError(f"Microsoft Graph draft create failed ({res.status_code}): {txt[:1200]}")
    try:
        body = res.json()
    except json.JSONDecodeError:
        raise RuntimeError(
            f"Microsoft Graph returned a non-JSON body after creating the draft ({res.status_code}): "
            f"{(res.text or '')[:800]}",
        ) from None
    draft_id = body.get("id")
    if not isinstance(draft_id, str) or not draft_id.strip():
        raise RuntimeError("Microsoft Graph created the draft but did not return an id.")

    owa_base = _owa_mail_base_for_compose_deeplinks()
    compose = _build_owa_compose_deeplink(owa_base, body)
    item_link = _item_web_link_from_create_body(body)
    primary = item_link or compose
    compose_extra = compose if item_link else None
    imid_raw = body.get("internetMessageId")
    internet_message_id = imid_raw.strip() if isinstance(imid_raw, str) and imid_raw.strip() else None
    return primary, draft_id.strip(), compose_extra, internet_message_id
