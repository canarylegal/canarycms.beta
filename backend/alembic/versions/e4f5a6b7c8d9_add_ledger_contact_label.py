"""add contact_label to ledger_entry

Revision ID: e4f5a6b7c8d9
Revises: c0d1e2f3a4b5
Create Date: 2026-04-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "e4f5a6b7c8d9"
down_revision = "c0d1e2f3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ledger_entry",
        sa.Column("contact_label", sa.String(300), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ledger_entry", "contact_label")
