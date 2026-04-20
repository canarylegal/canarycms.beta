"""add email thread auto-filing tables and auto_filed column

Revision ID: c0d1e2f3a4b5
Revises: b3c4d5e6f7a8
Create Date: 2026-04-03

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "c0d1e2f3a4b5"
down_revision = "b3c4d5e6f7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add auto_filed flag to existing file table
    op.add_column(
        "file",
        sa.Column("auto_filed", sa.Boolean(), nullable=False, server_default="false"),
    )

    # email_thread_ref: tracks Message-IDs per case for thread matching
    op.create_table(
        "email_thread_ref",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "case_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_email_thread_ref_message_id", "email_thread_ref", ["message_id"])

    # case_docs_view: per-user last-viewed timestamp, drives the badge
    op.create_table(
        "case_docs_view",
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "case_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("last_viewed_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("case_docs_view")
    op.drop_index("ix_email_thread_ref_message_id", table_name="email_thread_ref")
    op.drop_table("email_thread_ref")
    op.drop_column("file", "auto_filed")
