"""Microsoft Graph: ensure Outlook master category list includes the Canary name (app-only).

Used so the Outlook add-in can apply ``item.categories`` without each user creating the
category manually in Outlook first.

**Pros (Canary API + Graph helper)** — server calls Graph to seed each mailbox’s master list;
the add-in still tags the open message via Office.js after a successful file.

- One admin-consented app registration; same env vars as draft mail (``CANARY_MS_GRAPH_*``).
- Idempotent: skips if the category name already exists (case-insensitive).
- No need to store “category applied” in Canary — Outlook keeps that on the message.
- Optional to reduce failures when ``masterCategories.addAsync`` is flaky in the client.

**Cons**

- Requires **Application** permission **MailboxSettings.ReadWrite** (in addition to whatever
  you use for Mail) plus **admin consent** — broad access to mailbox settings per user.
- Canary only provisions for ``mailbox`` when it **matches the signed-in user’s email**
  (prevents arbitrary mailbox targeting).
- If a user’s **Canary login email ≠ their M365 mailbox** (shared mailbox, aliases), this
  path may not apply until those are aligned or the API is extended.
- Extra latency and dependency on Microsoft Graph availability at provision time.

See also: https://learn.microsoft.com/graph/api/outlookuserpost-mastercategories
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.parse import quote

import httpx

from app.graph_mail import app_access_token, graph_mail_configured, outlook_category_names

log = logging.getLogger(__name__)


def _primary_category_display_name() -> str:
    names = outlook_category_names()
    return (names[0] if names else "Canary").strip() or "Canary"


def _graph_user_master_categories_url(mailbox: str) -> str:
    m = mailbox.strip()
    return f"https://graph.microsoft.com/v1.0/users/{quote(m)}/outlook/masterCategories"


def ensure_master_category_for_mailbox(mailbox: str) -> dict[str, Any]:
    """
    Ensure the configured Outlook master category (``CANARY_OUTLOOK_CATEGORY_NAME``) exists
    for ``mailbox`` (UPN or SMTP). Returns a small status dict for the API layer.

    Raises ``RuntimeError`` on Graph misconfiguration or hard failures.
    """
    if not graph_mail_configured():
        raise RuntimeError("Microsoft Graph is not configured (set CANARY_MS_GRAPH_*).")

    display = _primary_category_display_name()
    token = app_access_token()
    base = _graph_user_master_categories_url(mailbox)
    headers = {"Authorization": f"Bearer {token}"}

    existing: list[dict[str, Any]] = []
    try:
        with httpx.Client(timeout=40.0) as client:
            next_url: str | None = base
            while next_url:
                res = client.get(next_url, headers=headers)
                if res.status_code == 404:
                    raise RuntimeError(
                        "Graph returned 404 for this mailbox — check the user exists in Entra ID "
                        "and the app has MailboxSettings.ReadWrite (application).",
                    )
                if res.status_code >= 400:
                    txt = (res.text or "").strip()
                    raise RuntimeError(f"Graph list masterCategories failed ({res.status_code}): {txt[:900]}")
                data = res.json()
                batch = data.get("value")
                if isinstance(batch, list):
                    existing.extend([x for x in batch if isinstance(x, dict)])
                next_link = data.get("@odata.nextLink")
                next_url = next_link if isinstance(next_link, str) and next_link.strip() else None
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft Graph: {e}") from e

    for row in existing:
        dn = row.get("displayName")
        if isinstance(dn, str) and dn.strip().lower() == display.lower():
            return {"status": "already_present", "display_name": display}

    body = {
        "displayName": display,
        # Align with common Outlook presets (see MailboxEnums.CategoryColor).
        "color": "preset4",
    }
    post_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=40.0) as client:
            res = client.post(base, headers=post_headers, json=body)
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft Graph: {e}") from e

    if res.status_code in (200, 201):
        return {"status": "created", "display_name": display}

    if res.status_code == 409:
        return {"status": "already_present", "display_name": display}

    txt = (res.text or "").strip()
    try:
        err = res.json()
        detail = err.get("error", {})
        code = detail.get("code") if isinstance(detail, dict) else None
        if code == "NameAlreadyExists" or res.status_code == 409:
            return {"status": "already_present", "display_name": display}
    except json.JSONDecodeError:
        pass

    raise RuntimeError(f"Graph create masterCategory failed ({res.status_code}): {txt[:1200]}")


def _graph_message_base_url(mailbox: str, message_id: str) -> str:
    """Single path segment for ``message_id`` (must be Graph REST id; encode ``/``, ``+``, etc.)."""
    mbox = mailbox.strip()
    mid = (message_id or "").strip()
    return f"https://graph.microsoft.com/v1.0/users/{quote(mbox)}/messages/{quote(mid, safe='')}"


def _lookup_graph_message_id_by_internet_message_id(mailbox: str, internet_message_id: str, token: str) -> str | None:
    """Resolve Graph ``id`` when GET by item id fails (OData ``$filter`` on ``internetMessageId``)."""
    imid = (internet_message_id or "").strip()
    if not imid:
        return None
    esc = imid.replace("'", "''")
    filt = f"internetMessageId eq '{esc}'"
    url = f"https://graph.microsoft.com/v1.0/users/{quote(mailbox.strip())}/messages"
    headers = {"Authorization": f"Bearer {token}"}
    params: dict[str, str] = {"$filter": filt, "$select": "id", "$top": "1"}
    try:
        with httpx.Client(timeout=45.0) as client:
            res = client.get(url, headers=headers, params=params)
    except httpx.RequestError:
        return None
    if res.status_code >= 400:
        return None
    try:
        data = res.json()
    except json.JSONDecodeError:
        return None
    vals = data.get("value") if isinstance(data, dict) else None
    if not isinstance(vals, list) or not vals:
        return None
    gid = vals[0].get("id") if isinstance(vals[0], dict) else None
    if isinstance(gid, str) and gid.strip():
        return gid.strip()
    return None


def _merge_categories_once(mailbox: str, message_id: str, display: str, token: str) -> dict[str, Any]:
    base = _graph_message_base_url(mailbox, message_id)
    headers = {"Authorization": f"Bearer {token}"}

    try:
        with httpx.Client(timeout=45.0) as client:
            res = client.get(f"{base}?$select=categories", headers=headers)
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft Graph: {e}") from e

    if res.status_code == 404:
        raise RuntimeError(
            "Graph could not find this message by id — try converting itemId with convertToRestId in the add-in, "
            "or rely on internet_message_id fallback.",
        )
    if res.status_code >= 400:
        txt = (res.text or "").strip()
        raise RuntimeError(f"Graph GET message failed ({res.status_code}): {txt[:900]}")

    try:
        data = res.json()
    except json.JSONDecodeError:
        raise RuntimeError("Graph returned non-JSON for GET message.") from None

    current = data.get("categories") if isinstance(data, dict) else None
    if not isinstance(current, list):
        current = []
    strs = [str(x) for x in current if isinstance(x, str) and str(x).strip()]
    if any(s.strip().lower() == display.lower() for s in strs):
        return {"status": "already_tagged", "display_name": display}

    merged = strs + [display]
    patch_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        with httpx.Client(timeout=45.0) as client:
            pres = client.patch(base, headers=patch_headers, json={"categories": merged})
    except httpx.RequestError as e:
        raise RuntimeError(f"Could not reach Microsoft Graph: {e}") from e

    if pres.status_code in (200, 204):
        return {"status": "tagged", "display_name": display}

    txt = (pres.text or "").strip()
    raise RuntimeError(f"Graph PATCH message categories failed ({pres.status_code}): {txt[:1200]}")


def merge_canary_category_on_message(
    mailbox: str,
    message_id: str,
    internet_message_id: str | None = None,
) -> dict[str, Any]:
    """
    GET message ``categories``, merge in the configured Canary name, PATCH back.

    Pass a **Graph REST** message id (use Office.js ``convertToRestId(item.itemId, v2.0)``). Raw EWS-style
    ``itemId`` values often contain ``/`` and break OData URLs (``RequestBroker--ParseUri``).

    Optional ``internet_message_id`` enables a second attempt via ``$filter=internetMessageId eq …``.
    """
    if not graph_mail_configured():
        raise RuntimeError("Microsoft Graph is not configured (set CANARY_MS_GRAPH_*).")

    mbox = mailbox.strip()
    mid_raw = (message_id or "").strip()
    if not mbox or not mid_raw:
        raise RuntimeError("mailbox and message_id are required.")

    display = _primary_category_display_name()
    token = app_access_token()
    imid_opt = (internet_message_id or "").strip() or None

    try:
        return _merge_categories_once(mbox, mid_raw, display, token)
    except RuntimeError as first_err:
        err_txt = str(first_err)
        retry = imid_opt and (
            "ParseUri" in err_txt
            or "RequestBroker" in err_txt
            or "Graph GET message failed (400)" in err_txt
            or "Graph GET message failed (404)" in err_txt
        )
        if not retry:
            raise first_err from None
        resolved = _lookup_graph_message_id_by_internet_message_id(mbox, imid_opt, token)
        if not resolved or resolved == mid_raw:
            raise first_err from None
        return _merge_categories_once(mbox, resolved, display, token)
