"""Slugs for matter-level contact types (stored on ``case_contact.matter_contact_type``)."""

CLIENT_SLUG = "client"
LAWYERS_SLUG = "lawyers"

SYSTEM_MATTER_CONTACT_SLUGS: frozenset[str] = frozenset(
    {"client", "lawyers", "new-lender", "existing-lender"}
)


def normalize_matter_contact_type_slug(raw: str | None) -> str:
    return (raw or "").strip().lower()
