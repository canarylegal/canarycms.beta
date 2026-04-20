"""add auto_filed_imap_message audit log

Revision ID: f6a7b8c9d0e1
Revises: e4f5a6b7c8d9
Create Date: 2026-04-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "f6a7b8c9d0e1"
down_revision = "e4f5a6b7c8d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "auto_filed_imap_message",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "case_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_imap_mbox", sa.Text(), nullable=False),
        sa.Column("source_imap_uid", sa.String(100), nullable=False),
        sa.Column(
            "filed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_auto_filed_imap_message_lookup",
        "auto_filed_imap_message",
        ["case_id", "source_imap_mbox", "source_imap_uid"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_auto_filed_imap_message_lookup", table_name="auto_filed_imap_message")
    op.drop_table("auto_filed_imap_message")
