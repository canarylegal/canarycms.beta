"""API used by the Outlook add-in task pane (cross-case helpers)."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import get_current_user, require_case_access
from app.graph_mail import graph_mail_configured
from app.graph_outlook_categories import ensure_master_category_for_mailbox, merge_canary_category_on_message
from app.models import Case as CaseRow
from app.models import File as DbFile
from app.models import User
from app.schemas import (
    OutlookPluginEnsureMasterCategoryIn,
    OutlookPluginEnsureMasterCategoryOut,
    OutlookPluginGraphTagCategoryIn,
    OutlookPluginGraphTagCategoryOut,
    OutlookPluginLinkedCaseOut,
    OutlookPluginLinkedCaseResolveIn,
    OutlookPluginLinkedCaseResolveOut,
)

router = APIRouter(prefix="/outlook-plugin", tags=["outlook-plugin"])
log = logging.getLogger(__name__)


def _internet_message_id_variants(raw: str | None) -> list[str]:
    t = (raw or "").strip()
    if not t:
        return []
    out: set[str] = {t}
    if t.startswith("<") and t.endswith(">"):
        inner = t[1:-1].strip()
        if inner:
            out.add(inner)
    elif "@" in t:
        out.add(f"<{t}>")
    return list(out)


@router.post("/linked-case", response_model=OutlookPluginLinkedCaseResolveOut)
def resolve_linked_case_for_outlook_message(
    payload: OutlookPluginLinkedCaseResolveIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OutlookPluginLinkedCaseResolveOut:
    """Return the matter a message is already filed to, if any, by Outlook item id and/or RFC5322 Message-ID."""
    oid = (payload.outlook_item_id or "").strip() or None
    variants = _internet_message_id_variants(payload.internet_message_id)
    if not oid and not variants:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide outlook_item_id and/or internet_message_id.",
        )

    top_ors = []
    if oid:
        top_ors.append(or_(DbFile.source_outlook_item_id == oid, DbFile.outlook_graph_message_id == oid))
    if variants:
        top_ors.append(DbFile.source_internet_message_id.in_(variants))
    if not top_ors:
        return OutlookPluginLinkedCaseResolveOut(linked_case=None)

    stmt = (
        select(DbFile, CaseRow)
        .join(CaseRow, DbFile.case_id == CaseRow.id)
        .where(or_(*top_ors))
        .where(DbFile.oo_compose_pending.is_(False))
        .order_by(DbFile.created_at.desc())
        .limit(40)
    )
    rows = db.execute(stmt).all()
    for _frow, case in rows:
        try:
            require_case_access(case.id, user, db)
        except HTTPException:
            continue
        return OutlookPluginLinkedCaseResolveOut(
            linked_case=OutlookPluginLinkedCaseOut(
                id=case.id,
                case_number=case.case_number,
                client_name=case.client_name,
                matter_description=case.title,
            )
        )
    return OutlookPluginLinkedCaseResolveOut(linked_case=None)


@router.post("/ensure-master-category", response_model=OutlookPluginEnsureMasterCategoryOut)
def outlook_plugin_ensure_master_category(
    payload: OutlookPluginEnsureMasterCategoryIn,
    user: User = Depends(get_current_user),
) -> OutlookPluginEnsureMasterCategoryOut:
    """
    Idempotently create the configured Outlook **master** category (``CANARY_OUTLOOK_CATEGORY_NAME``)
    in the user’s Exchange mailbox via Microsoft Graph (application permissions).

    The add-in still applies the category to the message with Office.js; this only seeds the
    mailbox master list so ``categories.addAsync`` succeeds without manual Outlook setup.

    Requires Entra app permission **MailboxSettings.ReadWrite** (application) + admin consent,
    plus existing ``CANARY_MS_GRAPH_*`` variables.
    """
    mailbox = (payload.mailbox or "").strip()
    if not mailbox:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="mailbox is required.")

    if (user.email or "").strip().lower() != mailbox.lower():
        return OutlookPluginEnsureMasterCategoryOut(
            ok=False,
            status="skipped_mailbox_mismatch",
            detail="Mailbox must match your Canary sign-in email for Graph provisioning.",
        )

    if not graph_mail_configured():
        return OutlookPluginEnsureMasterCategoryOut(
            ok=False,
            status="skipped_graph_not_configured",
            detail="Server Graph credentials are not configured.",
        )

    try:
        result = ensure_master_category_for_mailbox(mailbox)
        st = str(result.get("status") or "")
        if st in ("created", "already_present"):
            return OutlookPluginEnsureMasterCategoryOut(ok=True, status=st, detail=None)
        return OutlookPluginEnsureMasterCategoryOut(ok=False, status=st or "unknown", detail=None)
    except RuntimeError as e:
        log.warning("ensure_master_category_for_mailbox failed: %s", e)
        return OutlookPluginEnsureMasterCategoryOut(
            ok=False,
            status="graph_error",
            detail=str(e)[:800],
        )


@router.post("/graph-tag-category", response_model=OutlookPluginGraphTagCategoryOut)
def outlook_plugin_graph_tag_category(
    payload: OutlookPluginGraphTagCategoryIn,
    user: User = Depends(get_current_user),
) -> OutlookPluginGraphTagCategoryOut:
    """
    Apply the configured category name to **this message** via Graph ``PATCH …/messages/{id}``
    (fallback when Office.js ``categories.addAsync`` fails).

    Entra app needs **Mail.ReadWrite** (application) + admin consent, plus ``CANARY_MS_GRAPH_*``.
    """
    mailbox = (payload.mailbox or "").strip()
    rest_item_id = (payload.rest_item_id or "").strip()
    if not mailbox or not rest_item_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="mailbox and rest_item_id are required.",
        )
    if (user.email or "").strip().lower() != mailbox.lower():
        return OutlookPluginGraphTagCategoryOut(
            ok=False,
            status="skipped_mailbox_mismatch",
            detail="Mailbox must match your Canary sign-in email.",
        )
    if not graph_mail_configured():
        return OutlookPluginGraphTagCategoryOut(
            ok=False,
            status="skipped_graph_not_configured",
            detail="Server Graph credentials are not configured.",
        )
    try:
        result = merge_canary_category_on_message(
            mailbox,
            rest_item_id,
            (payload.internet_message_id or "").strip() or None,
        )
        st = str(result.get("status") or "")
        if st in ("tagged", "already_tagged"):
            return OutlookPluginGraphTagCategoryOut(ok=True, status=st, detail=None)
        return OutlookPluginGraphTagCategoryOut(ok=False, status=st or "unknown", detail=None)
    except RuntimeError as e:
        log.warning("merge_canary_category_on_message failed: %s", e)
        return OutlookPluginGraphTagCategoryOut(
            ok=False,
            status="graph_error",
            detail=str(e)[:800],
        )
