import enum
import uuid
from decimal import Decimal
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    user = "user"


class UserPermissionCategory(Base):
    """Admin-defined permission set; optional FK from user.permission_category_id."""

    __tablename__ = "user_permission_category"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), unique=True, nullable=False)
    perm_fee_earner: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    perm_post_client: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    perm_post_office: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    perm_approve_payments: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    perm_approve_invoices: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class User(Base):
    __tablename__ = "user"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    role: Mapped[UserRole] = mapped_column(Enum(UserRole, name="user_role"), nullable=False, default=UserRole.user)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    permission_category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_permission_category.id", ondelete="SET NULL"), nullable=True
    )

    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_2fa_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Fernet-encrypted CalDAV app password (Radicale htpasswd); plaintext shown only on enable/reset.
    caldav_password_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Top-bar "E-mail": open OS default mail client (mailto:) vs Outlook on the web.
    email_launch_preference: Mapped[str] = mapped_column(String(32), nullable=False, default="desktop")
    email_outlook_web_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class MatterHeadType(Base):
    __tablename__ = "matter_head_type"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class MatterSubType(Base):
    __tablename__ = "matter_sub_type"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    head_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_head_type.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    prefix: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class MatterSubTypeMenu(Base):
    __tablename__ = "matter_sub_type_menu"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sub_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseStatus(str, enum.Enum):
    open = "open"
    closed = "closed"
    archived = "archived"
    quote = "quote"
    post_completion = "post_completion"


class CaseLockMode(str, enum.Enum):
    none = "none"
    whitelist = "whitelist"
    blacklist = "blacklist"


class CaseAccessMode(str, enum.Enum):
    allow = "allow"
    deny = "deny"


class UserCalendar(Base):
    """Logical calendar: Radicale collection under owner's principal at /{owner_id}/{radicale_slug}/."""

    __tablename__ = "user_calendar"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Radicale calendar collection id (directory name); stable after create.
    radicale_slug: Mapped[str] = mapped_column(String(80), nullable=False)
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class UserCalendarShare(Base):
    __tablename__ = "user_calendar_share"

    calendar_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_calendar.id", ondelete="CASCADE"), primary_key=True
    )
    grantee_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), primary_key=True
    )
    can_write: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class UserCalendarSubscription(Base):
    """Subscriber added a public calendar to their Canary calendar list (read-only in v1)."""

    __tablename__ = "user_calendar_subscription"

    subscriber_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), primary_key=True
    )
    calendar_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_calendar.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class UserCalendarCategory(Base):
    """Canary-only category; owner defines list; colour drives in-app FullCalendar display."""

    __tablename__ = "user_calendar_category"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    calendar_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_calendar.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # #RRGGBB or null (default event styling in UI).
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CalendarEventCategory(Base):
    """Maps iCalendar UID + logical calendar to a category (not stored in Radicale)."""

    __tablename__ = "calendar_event_category"

    calendar_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_calendar.id", ondelete="CASCADE"), primary_key=True
    )
    event_uid: Mapped[str] = mapped_column(String(512), primary_key=True)
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user_calendar_category.id", ondelete="SET NULL"), nullable=True
    )


class RoundcubeSsoTokenUse(Base):
    __tablename__ = "roundcube_sso_token_use"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    jti: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class MatterContactTypeConfig(Base):
    """Admin-configurable labels for matter contact type slugs on ``case_contact.matter_contact_type``."""

    __tablename__ = "matter_contact_type_config"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Case(Base):
    __tablename__ = "case"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_number: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    # Matter description
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    # Client name(s) denormalized for the main menu; snapshots still live in case_contact.
    client_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    fee_earner_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=True)
    status: Mapped[CaseStatus] = mapped_column(Enum(CaseStatus, name="case_status"), nullable=False, default=CaseStatus.open)
    practice_area: Mapped[str | None] = mapped_column(String(200), nullable=True)
    matter_head_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_head_type.id", ondelete="SET NULL"), nullable=True, index=True
    )
    matter_sub_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="SET NULL"), nullable=True
    )
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=False)
    is_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    lock_mode: Mapped[CaseLockMode] = mapped_column(
        Enum(CaseLockMode, name="case_lock_mode"),
        nullable=False,
        default=CaseLockMode.none,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseReferenceCounter(Base):
    __tablename__ = "case_reference_counter"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    next_value: Mapped[int] = mapped_column(Integer, nullable=False, default=1)


class CasePropertyDetails(Base):
    """Per-case Property menu data (UK or free-form address + title numbers). Payload is JSON."""

    __tablename__ = "case_property_details"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), primary_key=True
    )
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class PrecedentKind(str, enum.Enum):
    letter = "letter"
    email = "email"
    document = "document"


class PrecedentCategory(Base):
    __tablename__ = "precedent_category"
    __table_args__ = (UniqueConstraint("matter_sub_type_id", "name", name="uq_precedent_category_sub_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    matter_sub_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class Precedent(Base):
    __tablename__ = "precedent"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    reference: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[PrecedentKind] = mapped_column(Enum(PrecedentKind, name="precedent_kind"), nullable=False)
    file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("file.id", ondelete="CASCADE"), nullable=False)
    # Scope: (NULL,NULL,NULL) = all cases; (H,NULL,NULL) = all sub-types under head H; (H,S,NULL) = all categories under sub S; (H,S,C) = one category.
    matter_head_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_head_type.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    matter_sub_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("precedent_category.id", ondelete="RESTRICT"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseAccessRule(Base):
    __tablename__ = "case_access_rule"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=False)
    mode: Mapped[CaseAccessMode] = mapped_column(Enum(CaseAccessMode, name="case_access_mode"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class ContactType(str, enum.Enum):
    person = "person"
    organisation = "organisation"


class Contact(Base):
    __tablename__ = "contact"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    type: Mapped[ContactType] = mapped_column(Enum(ContactType, name="contact_type"), nullable=False)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # Person name fields (type == 'person')
    title: Mapped[str | None] = mapped_column(String(50), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    middle_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(150), nullable=True)

    # Organisation name fields (type == 'organisation')
    company_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    trading_name: Mapped[str | None] = mapped_column(String(300), nullable=True)

    address_line1: Mapped[str | None] = mapped_column(String(300), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(300), nullable=True)
    city: Mapped[str | None] = mapped_column(String(200), nullable=True)
    county: Mapped[str | None] = mapped_column(String(150), nullable=True)
    postcode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseContact(Base):
    __tablename__ = "case_contact"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id"), nullable=False)
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contact.id", ondelete="SET NULL"), nullable=True
    )
    is_linked_to_master: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    type: Mapped[ContactType] = mapped_column(Enum(ContactType, name="contact_type"), nullable=False)
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # Person name fields (type == 'person')
    title: Mapped[str | None] = mapped_column(String(50), nullable=True)
    first_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    middle_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(150), nullable=True)

    # Organisation name fields (type == 'organisation')
    company_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    trading_name: Mapped[str | None] = mapped_column(String(300), nullable=True)

    address_line1: Mapped[str | None] = mapped_column(String(300), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(300), nullable=True)
    city: Mapped[str | None] = mapped_column(String(200), nullable=True)
    county: Mapped[str | None] = mapped_column(String(150), nullable=True)
    postcode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Matter-only fields (not pushed to global Contact when editing snapshot).
    matter_contact_type: Mapped[str | None] = mapped_column(String(200), nullable=True)
    matter_contact_reference: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # For matter_contact_type == "lawyers": up to four linked Client matter contacts (UUID strings in JSON).
    lawyer_client_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class FileCategory(str, enum.Enum):
    case_document = "case_document"
    precedent = "precedent"
    system = "system"


class File(Base):
    __tablename__ = "file"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id"), nullable=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=False)
    category: Mapped[FileCategory] = mapped_column(Enum(FileCategory, name="file_category"), nullable=False)

    # Virtual folder path inside the case's documents tree ("" == root).
    folder_path: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # "Pinned" controls whether the file is shown in the pinned section.
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(200), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    checksum: Mapped[str | None] = mapped_column(String(128), nullable=True)

    # Optional parent/child relationship for grouped artifacts in the UI.
    # Used by the Roundcube "file email into case" feature:
    # an email (.eml) becomes the parent, and each MIME attachment becomes a child.
    parent_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("file.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )

    # When a message is filed from Roundcube, we keep IMAP location so Canary can
    # open the live message in Roundcube (_extwin=1) while it still exists on the server.
    source_imap_mbox: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_imap_uid: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Parsed from parent .eml on upload (message/rfc822); UI second line in document list.
    source_mail_from_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_mail_from_email: Mapped[str | None] = mapped_column(Text, nullable=True)
    # True if message was filed from a sent/outbox folder (or from-address matches uploader). None = unknown.
    source_mail_is_outbound: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # RFC5322 Message-ID header value (angle brackets optional), parsed from parent .eml on upload.
    source_internet_message_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Outlook/Exchange REST item id from the Office add-in when filing from Outlook (OWA read deeplink).
    source_outlook_item_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Microsoft Graph message id (often same string as REST item id) — OWA read deeplink / desktop open.
    outlook_graph_message_id: Mapped[str | None] = mapped_column(String(450), nullable=True)
    # Graph ``webLink`` when available (preferred one-click open in the browser).
    outlook_web_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    # True for new docs from compose-office until the user finishes OnlyOffice "Save & Close" (published).
    oo_compose_pending: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class FileEditSession(Base):
    """Short-lived WebDAV edit lease for a single case file (desktop editors, e.g. ONLYOFFICE)."""

    __tablename__ = "file_edit_session"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("file.id", ondelete="CASCADE"), nullable=False)
    case_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), nullable=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_event"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=True)

    action: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(String(500), nullable=True)

    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(300), nullable=True)

    # Small metadata (never secrets); stored as JSON string for now to avoid adding JSONB dependency immediately.
    meta_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseNote(Base):
    __tablename__ = "case_note"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id"), nullable=False)
    author_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=False)

    body: Mapped[str] = mapped_column(Text, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseTaskStatus(str, enum.Enum):
    open = "open"
    done = "done"
    cancelled = "cancelled"


class CaseTaskPriority(str, enum.Enum):
    low = "low"
    normal = "normal"
    high = "high"


class MatterSubTypeStandardTask(Base):
    """Admin-defined task titles suggested when creating a case task for a matter sub-type."""

    __tablename__ = "matter_sub_type_standard_task"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    matter_sub_type_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="CASCADE"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseTask(Base):
    __tablename__ = "case_task"
    __table_args__ = (
        Index(
            "uq_case_task_case_event_id",
            "case_event_id",
            unique=True,
            postgresql_where=text("case_event_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id"), nullable=False)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user.id"), nullable=False)

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[CaseTaskStatus] = mapped_column(
        Enum(CaseTaskStatus, name="case_task_status"),
        nullable=False,
        default=CaseTaskStatus.open,
    )
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    standard_task_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type_standard_task.id", ondelete="SET NULL"), nullable=True
    )
    assigned_to_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    case_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case_event.id", ondelete="CASCADE"), nullable=True
    )
    priority: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    is_private: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# Ledger (SAR 2019)
# ---------------------------------------------------------------------------

class LedgerAccountType(str, enum.Enum):
    client = "client"
    office = "office"


class LedgerDirection(str, enum.Enum):
    debit = "debit"
    credit = "credit"


class LedgerAccount(Base):
    """One client account + one office account per case, created on first access."""

    __tablename__ = "ledger_account"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), nullable=False
    )
    account_type: Mapped[LedgerAccountType] = mapped_column(
        Enum(LedgerAccountType, name="ledger_account_type"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class LedgerEntry(Base):
    """Single leg of a double-entry posting; two rows share the same pair_id."""

    __tablename__ = "ledger_entry"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    account_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ledger_account.id", ondelete="CASCADE"), nullable=False
    )
    pair_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    direction: Mapped[LedgerDirection] = mapped_column(
        Enum(LedgerDirection, name="ledger_direction"), nullable=False
    )
    # Stored in integer pence to avoid floating-point errors.
    amount_pence: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    contact_label: Mapped[str | None] = mapped_column(String(300), nullable=True)
    posted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    posted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    is_approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


# ---------------------------------------------------------------------------
# Finance templates (admin-defined per matter sub-type) + case-level finance
# ---------------------------------------------------------------------------

class FinanceCategoryTemplate(Base):
    """Admin-defined category within a matter sub-type's finance template."""

    __tablename__ = "finance_category_template"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    matter_sub_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class FinanceItemTemplate(Base):
    """Admin-defined debit/credit line item within a finance category template."""

    __tablename__ = "finance_item_template"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("finance_category_template.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)  # "debit" | "credit"
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class FinanceCategory(Base):
    """Case-specific finance category; may originate from a template or be custom."""

    __tablename__ = "finance_category"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), nullable=False
    )
    template_category_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("finance_category_template.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class FinanceItem(Base):
    """Case-specific finance line item; may originate from a template or be custom."""

    __tablename__ = "finance_item"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    category_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("finance_category.id", ondelete="CASCADE"), nullable=False
    )
    template_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("finance_item_template.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)  # "debit" | "credit"
    amount_pence: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# Sub-menu: Events (admin template per matter sub-type + per-case dated rows)
# ---------------------------------------------------------------------------


class MatterSubTypeEventTemplate(Base):
    """Admin-defined event label for a matter sub-type (order + name)."""

    __tablename__ = "matter_sub_type_event_template"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    matter_sub_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseEvent(Base):
    """Per-case event row (seeded from template); user sets event_date."""

    __tablename__ = "case_event"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), nullable=False
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type_event_template.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    track_in_calendar: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    calendar_event_uid: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class InvoiceSeq(Base):
    """Single-row sequence for global invoice numbers."""

    __tablename__ = "invoice_seq"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    next_num: Mapped[int] = mapped_column(BigInteger, nullable=False, default=1)


class BillingSettings(Base):
    """Singleton row (id=1): default VAT % for new invoice lines."""

    __tablename__ = "billing_settings"

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    default_vat_percent: Mapped[Decimal] = mapped_column(Numeric(8, 3), nullable=False, default=Decimal("20"))


class BillingLineTemplate(Base):
    """Admin-defined default fee / disbursement labels and amounts per matter sub-type."""

    __tablename__ = "billing_line_template"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    matter_sub_type_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("matter_sub_type.id", ondelete="CASCADE"), nullable=False
    )
    line_kind: Mapped[str] = mapped_column(String(16), nullable=False)  # "fee" | "disbursement"
    label: Mapped[str] = mapped_column(String(200), nullable=False)
    default_amount_pence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseInvoice(Base):
    __tablename__ = "case_invoice"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), nullable=False)
    invoice_number: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    ledger_pair_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    reversal_pair_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    total_pence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    payee_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    credit_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    contact_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("contact.id", ondelete="SET NULL"), nullable=True
    )
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    approved_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=datetime.utcnow)


class CaseInvoiceLine(Base):
    __tablename__ = "case_invoice_line"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case_invoice.id", ondelete="CASCADE"), nullable=False
    )
    line_type: Mapped[str] = mapped_column(String(24), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount_pence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    tax_pence: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    credit_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )


class CaseDocsView(Base):
    """Per-user timestamp of when they last viewed a case's documents."""

    __tablename__ = "case_docs_view"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("user.id", ondelete="CASCADE"), primary_key=True
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("case.id", ondelete="CASCADE"), primary_key=True
    )
    last_viewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
