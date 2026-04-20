"""case event reminder audit + case invoices

Revision ID: p2q3r4s5t6u7
Revises: o1p2q3r4s5t6
Create Date: 2026-04-07
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "p2q3r4s5t6u7"
down_revision = "o1p2q3r4s5t6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "case_event_reminder_sent",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "case_event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case_event.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("bucket", sa.SmallInteger(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("case_event_id", "bucket", name="uq_case_event_reminder_bucket"),
    )
    op.create_index("ix_case_event_reminder_sent_event", "case_event_reminder_sent", ["case_event_id"])

    op.create_table(
        "invoice_seq",
        sa.Column("id", sa.SmallInteger(), primary_key=True),
        sa.Column("next_num", sa.BigInteger(), nullable=False, server_default="1"),
    )
    op.execute("INSERT INTO invoice_seq (id, next_num) VALUES (1, 1)")

    op.create_table(
        "case_invoice",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("case_id", UUID(as_uuid=True), sa.ForeignKey("case.id", ondelete="CASCADE"), nullable=False),
        sa.Column("invoice_number", sa.String(40), nullable=False, unique=True),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("ledger_pair_id", UUID(as_uuid=True), nullable=True),
        sa.Column("reversal_pair_id", UUID(as_uuid=True), nullable=True),
        sa.Column("total_pence", sa.BigInteger(), nullable=False),
        sa.Column("payee_name", sa.Text(), nullable=True),
        sa.Column("contact_id", UUID(as_uuid=True), sa.ForeignKey("contact.id", ondelete="SET NULL"), nullable=True),
        sa.Column(
            "created_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "approved_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("voided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_case_invoice_case", "case_invoice", ["case_id"])

    op.create_table(
        "case_invoice_line",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "invoice_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case_invoice.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("line_type", sa.String(24), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("amount_pence", sa.BigInteger(), nullable=False),
        sa.Column("tax_pence", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "credit_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index("ix_case_invoice_line_invoice", "case_invoice_line", ["invoice_id"])


def downgrade() -> None:
    op.drop_index("ix_case_invoice_line_invoice", table_name="case_invoice_line")
    op.drop_table("case_invoice_line")
    op.drop_index("ix_case_invoice_case", table_name="case_invoice")
    op.drop_table("case_invoice")
    op.drop_table("invoice_seq")
    op.drop_index("ix_case_event_reminder_sent_event", table_name="case_event_reminder_sent")
    op.drop_table("case_event_reminder_sent")
