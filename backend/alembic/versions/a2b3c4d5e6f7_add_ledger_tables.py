"""add ledger_account and ledger_entry tables (SAR 2019)

Revision ID: a2b3c4d5e6f7
Revises: d0e1f2a3b4c5
Create Date: 2026-04-03

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "a2b3c4d5e6f7"
down_revision = "d0e1f2a3b4c5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Each case gets exactly two ledger accounts created on first use.
    op.create_table(
        "ledger_account",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "case_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # "client" | "office"
        sa.Column("account_type", sa.String(20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("case_id", "account_type", name="uq_ledger_account_case_type"),
    )
    op.create_index("ix_ledger_account_case_id", "ledger_account", ["case_id"])

    # Each row is ONE side of a double-entry pair.
    # A single posting creates TWO rows sharing the same pair_id.
    op.create_table(
        "ledger_entry",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "account_id",
            UUID(as_uuid=True),
            sa.ForeignKey("ledger_account.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # pair_id links the two legs of a double-entry posting together.
        sa.Column("pair_id", UUID(as_uuid=True), nullable=False),
        # "debit" | "credit"
        sa.Column("direction", sa.String(10), nullable=False),
        # Stored as integer pence to avoid floating-point rounding.
        sa.Column("amount_pence", sa.Integer, nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        # Optional reference (e.g. cheque number, invoice ref).
        sa.Column("reference", sa.String(200), nullable=True),
        sa.Column(
            "posted_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "posted_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_ledger_entry_account_id", "ledger_entry", ["account_id"])
    op.create_index("ix_ledger_entry_pair_id", "ledger_entry", ["pair_id"])


def downgrade() -> None:
    op.drop_index("ix_ledger_entry_pair_id", table_name="ledger_entry")
    op.drop_index("ix_ledger_entry_account_id", table_name="ledger_entry")
    op.drop_table("ledger_entry")
    op.drop_index("ix_ledger_account_case_id", table_name="ledger_account")
    op.drop_table("ledger_account")
