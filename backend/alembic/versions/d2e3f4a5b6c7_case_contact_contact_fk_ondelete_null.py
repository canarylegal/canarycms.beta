"""case_contact.contact_id FK: ON DELETE SET NULL

Revision ID: d2e3f4a5b6c7
Revises: c1a2b3c4d5e6
Create Date: 2026-03-31

"""
from __future__ import annotations

from alembic import op

revision = "d2e3f4a5b6c7"
down_revision = "c1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("case_contact_contact_id_fkey", "case_contact", type_="foreignkey")
    op.create_foreign_key(
        "case_contact_contact_id_fkey",
        "case_contact",
        "contact",
        ["contact_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("case_contact_contact_id_fkey", "case_contact", type_="foreignkey")
    op.create_foreign_key(
        "case_contact_contact_id_fkey",
        "case_contact",
        "contact",
        ["contact_id"],
        ["id"],
    )
