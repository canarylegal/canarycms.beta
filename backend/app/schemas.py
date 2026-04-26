from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models import CaseLockMode, CaseStatus, CaseTaskStatus, ContactType, FileCategory, PrecedentKind, UserRole


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserPublic(BaseModel):
    id: uuid.UUID
    email: EmailStr
    display_name: str
    job_title: str | None = None
    role: UserRole
    is_active: bool
    is_2fa_enabled: bool
    email_launch_preference: Literal["desktop", "outlook_web"] = "desktop"
    email_outlook_web_url: str | None = None


class UserEmailHandlingUpdate(BaseModel):
    """How the top-bar E-mail button opens mail: desktop handler vs Outlook on the web."""

    email_launch_preference: Literal["desktop", "outlook_web"]
    email_outlook_web_url: str | None = Field(default=None, max_length=2000)


class LedgerPermissionsOut(BaseModel):
    can_approve_ledger: bool
    can_approve_invoices: bool = False


class UserCalDAVStatusOut(BaseModel):
    enabled: bool
    caldav_url: str
    caldav_username: str


class UserCalDAVProvisionOut(BaseModel):
    caldav_url: str
    caldav_username: str
    caldav_password: str
    note: str = (
        "Save this password now — it will not be shown again. "
        "Use it as the CalDAV password in your calendar app (not your Canary login)."
    )


class CalendarEventOut(BaseModel):
    id: str
    uid: str
    title: str
    start: str
    end: str
    all_day: bool = False
    description: str | None = None
    calendar_name: str | None = None
    calendar_id: str | None = None
    can_edit: bool = True
    # Canary-only category (not in iCal).
    category_id: uuid.UUID | None = None
    category_name: str | None = None
    category_color: str | None = None


class CalendarEventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    start: datetime | date
    end: datetime | date
    all_day: bool = False
    description: str | None = Field(default=None, max_length=20000)
    calendar_id: uuid.UUID | None = None
    category_id: uuid.UUID | None = None


class CalendarEventPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    start: datetime | date | None = None
    end: datetime | date | None = None
    all_day: bool | None = None
    description: str | None = Field(default=None, max_length=20000)
    category_id: uuid.UUID | None = None


class CalendarCategoryOut(BaseModel):
    id: uuid.UUID
    calendar_id: uuid.UUID
    name: str
    color: str | None = None


class CalendarCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str | None = Field(default=None, max_length=20)


class CalendarCategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = Field(default=None, max_length=20)


class CalendarOwnerMini(BaseModel):
    id: uuid.UUID
    display_name: str
    email: EmailStr


class UserCalendarOut(BaseModel):
    id: uuid.UUID
    name: str
    radicale_slug: str
    is_public: bool
    access: Literal["owner", "read", "write"]
    source: Literal["owned", "share", "subscription"]
    owner: CalendarOwnerMini


class CalendarShareOut(BaseModel):
    grantee_user_id: uuid.UUID
    grantee_display_name: str
    grantee_email: EmailStr
    can_write: bool


class CalendarCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CalendarPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    is_public: bool | None = None


class CalendarShareCreate(BaseModel):
    grantee_user_id: uuid.UUID
    can_write: bool = False


class CalendarSubscribeIn(BaseModel):
    calendar_id: uuid.UUID


class CalendarDirectoryRow(BaseModel):
    id: uuid.UUID
    name: str
    owner: CalendarOwnerMini
    is_public: bool
    shared_directly: bool
    already_in_my_list: bool
    can_subscribe: bool


class BootstrapAdminRequest(BaseModel):
    token: str = Field(min_length=10)
    email: EmailStr
    password: str = Field(min_length=12)
    display_name: str = Field(min_length=1, max_length=200)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    totp_code: str | None = None


class Setup2FAResponse(BaseModel):
    secret: str
    otpauth_uri: str


class Verify2FARequest(BaseModel):
    code: str = Field(min_length=4, max_length=12)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=12)


class UserDisable2FARequest(BaseModel):
    password: str
    totp_code: str = Field(min_length=6, max_length=12)


class Cancel2FASetupRequest(BaseModel):
    password: str


class AdminUserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12)
    display_name: str = Field(min_length=1, max_length=200)
    job_title: str | None = Field(default=None, max_length=300)
    role: UserRole = UserRole.user
    is_active: bool = True
    permission_category_id: uuid.UUID


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    job_title: str | None = Field(default=None, max_length=300)
    role: UserRole | None = None
    is_active: bool | None = None
    permission_category_id: uuid.UUID | None = None


class AdminUserPublic(UserPublic):
    permission_category_id: uuid.UUID | None = None


class UserPermissionCategoryOut(BaseModel):
    id: uuid.UUID
    name: str
    perm_fee_earner: bool
    perm_post_client: bool
    perm_post_office: bool
    perm_approve_payments: bool
    perm_approve_invoices: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserPermissionCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    perm_fee_earner: bool = False
    perm_post_client: bool = False
    perm_post_office: bool = False
    perm_approve_payments: bool = False
    perm_approve_invoices: bool = False


class UserPermissionCategoryPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    perm_fee_earner: bool | None = None
    perm_post_client: bool | None = None
    perm_post_office: bool | None = None
    perm_approve_payments: bool | None = None
    perm_approve_invoices: bool | None = None


class AdminUserSetPassword(BaseModel):
    password: str = Field(min_length=12)


class MatterHeadTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class MatterHeadTypeUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class MatterSubTypeMenuOut(BaseModel):
    id: uuid.UUID
    name: str


class MatterSubTypeMenuCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class MatterSubTypeMenuUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class MatterSubTypeOut(BaseModel):
    id: uuid.UUID
    name: str
    prefix: str | None
    menus: list[MatterSubTypeMenuOut] = []


class MatterHeadTypeOut(BaseModel):
    id: uuid.UUID
    name: str
    sub_types: list[MatterSubTypeOut] = []


class MatterSubTypeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class MatterSubTypeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    prefix: str | None = None


class CaseCreate(BaseModel):
    matter_description: str = Field(min_length=1, max_length=300)
    status: CaseStatus = CaseStatus.open
    practice_area: str | None = Field(default=None, max_length=200)
    matter_sub_type_id: uuid.UUID

    @field_validator("status")
    @classmethod
    def new_matter_status_open_or_quote_only(cls, v: CaseStatus) -> CaseStatus:
        if v not in (CaseStatus.open, CaseStatus.quote):
            raise ValueError("New matters may only be created as Active (open) or Quote.")
        return v


class CaseUpdate(BaseModel):
    matter_description: str | None = Field(default=None, min_length=1, max_length=300)
    fee_earner_user_id: uuid.UUID | None = None
    status: CaseStatus | None = None
    practice_area: str | None = Field(default=None, max_length=200)
    matter_sub_type_id: uuid.UUID | None = None
    matter_head_type_id: uuid.UUID | None = None
    is_locked: bool | None = None
    lock_mode: CaseLockMode | None = None


class MatterMenuItemOut(BaseModel):
    id: uuid.UUID
    name: str


class CaseOut(BaseModel):
    id: uuid.UUID
    case_number: str
    client_name: str | None
    matter_description: str
    fee_earner_user_id: uuid.UUID | None
    status: CaseStatus
    practice_area: str | None
    matter_sub_type_id: uuid.UUID | None
    matter_head_type_id: uuid.UUID | None
    matter_sub_type_name: str | None
    matter_head_type_name: str | None
    matter_menus: list[MatterMenuItemOut] = Field(default_factory=list)
    created_by: uuid.UUID
    is_locked: bool
    lock_mode: CaseLockMode
    created_at: datetime
    updated_at: datetime


class MatterContactTypeOut(BaseModel):
    id: uuid.UUID
    slug: str
    label: str
    sort_order: int
    is_system: bool

    model_config = ConfigDict(from_attributes=True)


class MatterContactTypeAdminCreate(BaseModel):
    slug: str = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=200)
    sort_order: int = 0


class MatterContactTypeAdminUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = None


class CasePropertyUK(BaseModel):
    line1: str | None = Field(default=None, max_length=300)
    line2: str | None = Field(default=None, max_length=300)
    town: str | None = Field(default=None, max_length=200)
    county: str | None = Field(default=None, max_length=200)
    postcode: str | None = Field(default=None, max_length=50)
    country: str | None = Field(default=None, max_length=100)


class CasePropertyPayload(BaseModel):
    """Stored in case_property_details.payload."""

    is_non_postal: bool = False
    uk: CasePropertyUK = Field(default_factory=CasePropertyUK)
    free_lines: list[str] = Field(default_factory=lambda: ["", "", "", "", "", ""])
    title_numbers: list[str] = Field(default_factory=list)
    tenure: Literal["freehold", "leasehold", "commonhold"] | None = None


class CasePropertyDetailsOut(BaseModel):
    has_details: bool
    payload: CasePropertyPayload
    updated_at: datetime | None = None


class PrecedentCategoryOut(BaseModel):
    id: uuid.UUID
    matter_sub_type_id: uuid.UUID
    name: str
    sort_order: int
    created_at: datetime
    updated_at: datetime


class PrecedentCategoryFlatOut(PrecedentCategoryOut):
    """Admin list: categories with sub-type label for grouping in the UI."""

    matter_sub_type_name: str


class PrecedentCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = 0


class PrecedentCategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = None


class PrecedentOut(BaseModel):
    id: uuid.UUID
    name: str
    reference: str
    kind: PrecedentKind
    original_filename: str
    mime_type: str
    category_id: uuid.UUID | None = None
    matter_head_type_id: uuid.UUID | None = None
    matter_sub_type_id: uuid.UUID | None = None
    category_name: str | None = None
    matter_head_type_name: str | None = None
    matter_sub_type_name: str | None = None
    scope_summary: str = ""
    created_at: datetime


class PrecedentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    reference: str | None = Field(default=None, min_length=1, max_length=200)
    category_id: uuid.UUID | None = None
    matter_head_type_id: uuid.UUID | None = None
    matter_sub_type_id: uuid.UUID | None = None


class ComposeOfficeDocumentIn(BaseModel):
    original_filename: str = Field(min_length=1, max_length=512)
    folder: str = ""
    precedent_id: uuid.UUID | None = None
    # Contact for precedent code merge; one of these may be supplied
    case_contact_id: uuid.UUID | None = None   # CaseContact row id
    global_contact_id: uuid.UUID | None = None  # global Contact row id
    # When True, fill [TITLE]…[TRADING_NAME_4] from up to four Client matter contacts (by date added).
    # When False and case_contact_id is a Client, only that client’s slot is filled (see docx_util.build_merge_fields).
    # [CONTACT_*] codes always reflect the contact chosen in compose when one is supplied, including alongside merge-all.
    precedent_merge_all_clients: bool = False


class CaseEmailDraftM365In(BaseModel):
    """Create an Outlook draft via Microsoft Graph (same merge inputs as compose-office, plus case file attachments)."""

    folder: str = ""
    precedent_id: uuid.UUID | None = None
    case_contact_id: uuid.UUID | None = None
    global_contact_id: uuid.UUID | None = None
    precedent_merge_all_clients: bool = False
    attachment_file_ids: list[uuid.UUID] = Field(default_factory=list)


class CaseEmailDraftM365Out(BaseModel):
    open_url: str
    graph_message_id: str | None = None
    draft_compose_web_link: str | None = None


class ContactCreate(BaseModel):
    type: ContactType
    name: str = Field(min_length=1, max_length=300)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    # Person name fields
    title: str | None = Field(default=None, max_length=50)
    first_name: str | None = Field(default=None, max_length=150)
    middle_name: str | None = Field(default=None, max_length=150)
    last_name: str | None = Field(default=None, max_length=150)
    # Organisation fields
    company_name: str | None = Field(default=None, max_length=300)
    trading_name: str | None = Field(default=None, max_length=300)
    # Address
    address_line1: str | None = Field(default=None, max_length=300)
    address_line2: str | None = Field(default=None, max_length=300)
    city: str | None = Field(default=None, max_length=200)
    county: str | None = Field(default=None, max_length=150)
    postcode: str | None = Field(default=None, max_length=50)
    country: str | None = Field(default=None, max_length=100)


class ContactUpdate(ContactCreate):
    type: ContactType | None = None
    name: str | None = Field(default=None, min_length=1, max_length=300)


class ContactOut(BaseModel):
    id: uuid.UUID
    type: ContactType
    name: str
    email: EmailStr | None
    phone: str | None
    title: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    company_name: str | None = None
    trading_name: str | None = None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    county: str | None = None
    postcode: str | None
    country: str | None
    created_at: datetime
    updated_at: datetime


class CaseContactCreateFromGlobal(BaseModel):
    contact_id: uuid.UUID
    matter_contact_type: str = Field(min_length=1, max_length=200)
    matter_contact_reference: str | None = Field(default=None, max_length=500)
    lawyer_client_ids: list[uuid.UUID] | None = None


class CaseContactUpdate(BaseModel):
    type: ContactType | None = None
    name: str | None = Field(default=None, min_length=1, max_length=300)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    title: str | None = Field(default=None, max_length=50)
    first_name: str | None = Field(default=None, max_length=150)
    middle_name: str | None = Field(default=None, max_length=150)
    last_name: str | None = Field(default=None, max_length=150)
    company_name: str | None = Field(default=None, max_length=300)
    trading_name: str | None = Field(default=None, max_length=300)
    address_line1: str | None = Field(default=None, max_length=300)
    address_line2: str | None = Field(default=None, max_length=300)
    city: str | None = Field(default=None, max_length=200)
    county: str | None = Field(default=None, max_length=150)
    postcode: str | None = Field(default=None, max_length=50)
    country: str | None = Field(default=None, max_length=100)
    matter_contact_type: str | None = Field(default=None, min_length=1, max_length=200)
    matter_contact_reference: str | None = Field(default=None, max_length=500)
    lawyer_client_ids: list[uuid.UUID] | None = None
    push_to_global: bool = False


class CaseContactOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    contact_id: uuid.UUID | None
    is_linked_to_master: bool
    type: ContactType
    name: str
    email: EmailStr | None
    phone: str | None
    title: str | None = None
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    company_name: str | None = None
    trading_name: str | None = None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    county: str | None = None
    postcode: str | None
    country: str | None
    matter_contact_type: str | None = None
    matter_contact_reference: str | None = None
    lawyer_client_ids: list[uuid.UUID] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    @field_validator("lawyer_client_ids", mode="before")
    @classmethod
    def _lawyer_ids_from_json(cls, v: object) -> list[uuid.UUID]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        out: list[uuid.UUID] = []
        for x in v:
            out.append(uuid.UUID(str(x)))
        return out


class CaseNoteCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CaseNoteUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CaseNoteOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    author_user_id: uuid.UUID
    body: str
    created_at: datetime
    updated_at: datetime


class MatterSubTypeStandardTaskCreate(BaseModel):
    matter_sub_type_id: uuid.UUID
    title: str = Field(min_length=1, max_length=300)
    sort_order: int = 0


class MatterSubTypeStandardTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    sort_order: int | None = None


class MatterSubTypeStandardTaskOut(BaseModel):
    id: uuid.UUID
    matter_sub_type_id: uuid.UUID | None
    title: str
    sort_order: int
    is_system: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


CaseTaskPriority = Literal["low", "normal", "high"]


class CaseTaskCreate(BaseModel):
    """Custom task: set title. Standard task: set standard_task_id (title from template unless ``title`` overrides)."""

    title: str | None = Field(default=None, max_length=300)
    standard_task_id: uuid.UUID | None = None
    description: str | None = Field(default=None, max_length=20000)
    due_at: datetime | None = None
    assigned_to_user_id: uuid.UUID | None = None
    priority: CaseTaskPriority = "normal"
    is_private: bool = False

    @model_validator(mode="after")
    def title_or_standard(self) -> CaseTaskCreate:
        if self.standard_task_id is None and (self.title is None or not str(self.title).strip()):
            raise ValueError("title is required when standard_task_id is not set")
        return self


class CaseTaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=20000)
    status: CaseTaskStatus | None = None
    due_at: datetime | None = None
    assigned_to_user_id: uuid.UUID | None = None
    priority: CaseTaskPriority | None = None
    is_private: bool | None = None


class CaseTaskOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    created_by_user_id: uuid.UUID
    title: str
    description: str | None
    status: CaseTaskStatus
    due_at: datetime | None
    standard_task_id: uuid.UUID | None = None
    assigned_to_user_id: uuid.UUID | None = None
    assigned_display_name: str | None = None
    priority: CaseTaskPriority = "normal"
    case_event_id: uuid.UUID | None = None
    is_private: bool = False
    created_at: datetime
    updated_at: datetime


class TaskMenuRowOut(BaseModel):
    """Case tasks for the global Tasks menu (one row per task)."""

    id: uuid.UUID
    case_id: uuid.UUID
    case_number: str
    client_name: str | None
    matter_description: str | None
    matter_type_label: str
    task_title: str
    date: datetime
    assigned_display_name: str | None = None
    priority: CaseTaskPriority = "normal"
    status: CaseTaskStatus
    is_private: bool = False


class FilePinUpdate(BaseModel):
    is_pinned: bool


class OutlookOpenHintsOut(BaseModel):
    """Graph / OWA pointers for opening a filed message in Outlook on the web or desktop."""

    outlook_graph_message_id: str | None = None
    outlook_web_link: str | None = None


class OutlookPluginLinkedCaseResolveIn(BaseModel):
    outlook_item_id: str | None = None
    internet_message_id: str | None = None


class OutlookPluginLinkedCaseOut(BaseModel):
    id: uuid.UUID
    case_number: str
    client_name: str | None = None
    matter_description: str


class OutlookPluginLinkedCaseResolveOut(BaseModel):
    linked_case: OutlookPluginLinkedCaseOut | None = None


class OutlookPluginEnsureMasterCategoryIn(BaseModel):
    """Mailbox UPN/SMTP for the signed-in Outlook session (must match Canary user email)."""

    mailbox: str


class OutlookPluginEnsureMasterCategoryOut(BaseModel):
    ok: bool
    status: str
    detail: str | None = None


class OutlookPluginGraphTagCategoryIn(BaseModel):
    """
    ``rest_item_id``: prefer ``mailbox.convertToRestId(item.itemId, v2.0)`` for Graph;
    raw ``itemId`` is often EWS-shaped and breaks the Graph URL if unconverted.
    ``internet_message_id``: optional RFC5322 Message-ID for ``$filter`` fallback when GET by id fails.
    """

    mailbox: str
    rest_item_id: str
    internet_message_id: str | None = None


class OutlookPluginGraphTagCategoryOut(BaseModel):
    ok: bool
    status: str
    detail: str | None = None


class CaseFolderCreate(BaseModel):
    # Relative folder path inside the case ("" == root).
    # Example: "Contracts" or "Contracts/2019"
    folder_path: str


class CaseFolderRenameUpdate(BaseModel):
    old_folder_path: str
    new_folder_path: str


class CaseFolderDeleteUpdate(BaseModel):
    folder_path: str


class CaseFolderMoveUpdate(BaseModel):
    old_folder_path: str
    new_parent_path: str


class CaseFileRenameUpdate(BaseModel):
    original_filename: str = Field(min_length=1, max_length=512)


class CommentFileUpdate(BaseModel):
    text: str = Field(min_length=0, max_length=500_000)


class CaseFileMoveUpdate(BaseModel):
    """Target folder path inside the case (empty string = root)."""

    folder_path: str = ""


class FileDesktopCheckoutOut(BaseModel):
    """WebDAV URLs for ONLYOFFICE Desktop (or any WebDAV client). Treat `token` as a password."""

    token: str
    webdav_folder_url: str
    webdav_file_url: str
    filename: str
    expires_at: datetime
    instructions: str
    libreoffice_cli_hint: str = Field(
        description=(
            "Example shell command using lowriter/localc/limpress (Linux). "
            "Avoids generic `libreoffice`, which some systems redirect to another office suite."
        ),
    )
    onlyoffice_cli_hint: str = Field(
        description=(
            "Always empty: ONLYOFFICE Desktop does not open http(s) WebDAV URLs from the CLI (args are local paths only). "
            "Many desktop builds also lack a LibreOffice-style 'open this WebDAV URL' menu; use in-browser ONLYOFFICE, "
            "LibreOffice Open Remote, or a WebDAV mount."
        ),
    )


class FileEditSessionStatusOut(BaseModel):
    active: bool
    expires_at: datetime | None = None
    webdav_file_url: str | None = None


class OnlyofficeEditorConfigOut(BaseModel):
    """JWT + plaintext fields for DocsAPI.DocEditor.

    ONLYOFFICE requires the plain config fields (document, editorConfig) to be passed to
    DocsAPI.DocEditor alongside the JWT token. The JWT is a signature of those fields, not
    a replacement — without document.url in the plain config the editor creates a blank iframe.
    """

    document_server_url: str
    token: str
    document_type: str
    # Plain (unsigned) fields that must be passed directly to DocsAPI.DocEditor alongside the JWT.
    document: dict
    editor_config: dict


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------

class LedgerPostCreate(BaseModel):
    """
    Body for POST /cases/{id}/ledger/post.

    A single posting records one transaction that affects one or both accounts.
    SAR-typical use cases:
      - client receipt  : debit client, credit client  (money in to client account)
      - bill payment    : debit client, credit office   (transfer to office on bill)
      - office disbursement: debit office, credit office (e.g. search fee)
    """

    description: str = Field(min_length=1, max_length=500)
    reference: str | None = Field(default=None, max_length=200)
    contact_label: str | None = Field(default=None, max_length=300)
    amount_pence: int = Field(gt=0, description="Amount in pence (integer)")
    # Which account(s) to affect and in which direction.
    # At least one leg is required; both may be supplied.
    client_direction: Literal["debit", "credit"] | None = None
    office_direction: Literal["debit", "credit"] | None = None

    model_config = {"extra": "forbid"}


class LedgerEntryOut(BaseModel):
    id: uuid.UUID
    pair_id: uuid.UUID
    account_type: Literal["client", "office"]
    direction: Literal["debit", "credit"]
    amount_pence: int
    description: str
    reference: str | None
    contact_label: str | None = None
    posted_by_user_id: uuid.UUID | None
    posted_at: datetime
    is_approved: bool = True

    model_config = {"from_attributes": True}


class LedgerAccountSummary(BaseModel):
    account_type: Literal["client", "office"]
    balance_pence: int  # positive = net credit; negative = net debit


class LedgerOut(BaseModel):
    entries: list[LedgerEntryOut]
    client: LedgerAccountSummary
    office: LedgerAccountSummary


class CaseInvoiceLineCreate(BaseModel):
    line_type: Literal["fee", "disbursement", "vat"]
    description: str = Field(min_length=1, max_length=500)
    amount_pence: int = Field(gt=0)
    tax_pence: int = Field(default=0, ge=0)
    credit_user_id: uuid.UUID | None = None


class CaseInvoiceCreate(BaseModel):
    credit_user_id: uuid.UUID
    payee_name: str | None = Field(default=None, max_length=500)
    contact_id: uuid.UUID | None = None
    lines: list[CaseInvoiceLineCreate] = Field(min_length=1)


class CaseInvoiceLineOut(BaseModel):
    id: uuid.UUID
    line_type: str
    description: str
    amount_pence: int
    tax_pence: int
    credit_user_id: uuid.UUID | None


class CaseInvoiceOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    invoice_number: str
    status: str
    total_pence: int
    payee_name: str | None
    credit_user_id: uuid.UUID | None = None
    credit_user_display_name: str | None = None
    contact_id: uuid.UUID | None
    ledger_pair_id: uuid.UUID | None
    created_by_user_id: uuid.UUID | None
    approved_by_user_id: uuid.UUID | None
    approved_at: datetime | None
    voided_at: datetime | None
    created_at: datetime
    lines: list[CaseInvoiceLineOut]


class CaseInvoicesOut(BaseModel):
    case_id: uuid.UUID
    invoices: list[CaseInvoiceOut]


class BillingSettingsOut(BaseModel):
    default_vat_percent: float


class BillingSettingsUpdate(BaseModel):
    default_vat_percent: float = Field(ge=0, le=100)

    model_config = {"extra": "forbid"}


class BillingLineTemplateOut(BaseModel):
    id: uuid.UUID
    matter_sub_type_id: uuid.UUID
    line_kind: Literal["fee", "disbursement"]
    label: str
    default_amount_pence: int
    sort_order: int


class BillingLineTemplateCreate(BaseModel):
    matter_sub_type_id: uuid.UUID
    line_kind: Literal["fee", "disbursement"]
    label: str = Field(min_length=1, max_length=200)
    default_amount_pence: int = Field(default=0, ge=0)
    sort_order: int = Field(default=0, ge=0)

    model_config = {"extra": "forbid"}


class BillingLineTemplateUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=200)
    default_amount_pence: int | None = Field(default=None, ge=0)
    sort_order: int | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class InvoiceBillingDefaultsUser(BaseModel):
    id: str
    email: str
    display_name: str


class InvoiceBillingDefaultsOut(BaseModel):
    default_vat_percent: float
    fee_earner_user_id: uuid.UUID | None = None
    fee_templates: list[BillingLineTemplateOut]
    disbursement_templates: list[BillingLineTemplateOut]
    users: list[InvoiceBillingDefaultsUser]


# ---------------------------------------------------------------------------
# Finance templates (admin)
# ---------------------------------------------------------------------------

class FinanceItemTemplateCreate(BaseModel):
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    direction: Literal["debit", "credit"]
    sort_order: int = Field(default=0, ge=0)

    model_config = {"extra": "forbid"}


class FinanceItemTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    direction: Literal["debit", "credit"] | None = None
    sort_order: int | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class FinanceItemTemplateOut(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    name: str
    direction: Literal["debit", "credit"]
    sort_order: int


class FinanceCategoryTemplateCreate(BaseModel):
    matter_sub_type_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = Field(default=0, ge=0)

    model_config = {"extra": "forbid"}


class FinanceCategoryTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class FinanceCategoryTemplateOut(BaseModel):
    id: uuid.UUID
    matter_sub_type_id: uuid.UUID
    name: str
    sort_order: int
    items: list[FinanceItemTemplateOut] = []


class FinanceTemplateOut(BaseModel):
    matter_sub_type_id: uuid.UUID
    categories: list[FinanceCategoryTemplateOut]


# ---------------------------------------------------------------------------
# Finance case data (per-case)
# ---------------------------------------------------------------------------

class FinanceItemCreate(BaseModel):
    category_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    direction: Literal["debit", "credit"]
    sort_order: int = Field(default=0, ge=0)

    model_config = {"extra": "forbid"}


class FinanceItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    direction: Literal["debit", "credit"] | None = None
    amount_pence: int | None = Field(default=None, ge=0)
    sort_order: int | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class FinanceItemOut(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    template_item_id: uuid.UUID | None
    name: str
    direction: Literal["debit", "credit"]
    amount_pence: int | None
    sort_order: int


class FinanceCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = Field(default=0, ge=0)

    model_config = {"extra": "forbid"}


class FinanceCategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = Field(default=None, ge=0)

    model_config = {"extra": "forbid"}


class FinanceCategoryOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    template_category_id: uuid.UUID | None
    name: str
    sort_order: int
    items: list[FinanceItemOut] = []


class FinanceOut(BaseModel):
    case_id: uuid.UUID
    categories: list[FinanceCategoryOut]


# Sub-menu Events (admin templates + case rows)
class MatterSubTypeEventTemplateOut(BaseModel):
    id: uuid.UUID
    matter_sub_type_id: uuid.UUID
    name: str
    sort_order: int
    created_at: datetime
    updated_at: datetime


class MatterSubTypeEventTemplateCreate(BaseModel):
    matter_sub_type_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    sort_order: int = 0


class MatterSubTypeEventTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    sort_order: int | None = None


class CaseEventOut(BaseModel):
    id: uuid.UUID
    case_id: uuid.UUID
    template_id: uuid.UUID | None
    name: str
    sort_order: int
    event_date: date | None
    track_in_calendar: bool = False
    calendar_event_uid: str | None = None
    created_at: datetime
    updated_at: datetime


class CaseEventsOut(BaseModel):
    case_id: uuid.UUID
    events: list[CaseEventOut]


class CaseEventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CaseEventUpdate(BaseModel):
    event_date: date | None = None
    track_in_calendar: bool | None = None
    calendar_event_uid: str | None = Field(default=None, max_length=512)

    @field_validator("event_date", mode="before")
    @classmethod
    def _empty_event_date_to_none(cls, v: object) -> object:
        if v == "" or v is None:
            return None
        return v

