"""remove auto-filing tables, thread refs, user mailbox config, file.auto_filed

Revision ID: v2w3x4y5z6a7
Revises: u8v9w0x1y2z3
Create Date: 2026-04-18

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "v2w3x4y5z6a7"
down_revision = "u8v9w0x1y2z3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("auto_filed_imap_message")
    op.drop_table("email_thread_ref")
    op.drop_table("user_email_config")
    op.drop_column("file", "auto_filed")


def downgrade() -> None:
    op.add_column(
        "file",
        sa.Column("auto_filed", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.alter_column("file", "auto_filed", server_default=None)

    op.create_table(
        "user_email_config",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("imap_user", sa.String(length=320), nullable=False),
        sa.Column("imap_password_enc", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "email_thread_ref",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("case_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["case_id"], ["case.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_email_thread_ref_message_id", "email_thread_ref", ["message_id"])

    op.create_table(
        "auto_filed_imap_message",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("case_id", sa.UUID(), nullable=False),
        sa.Column("source_imap_mbox", sa.Text(), nullable=False),
        sa.Column("source_imap_uid", sa.String(length=100), nullable=False),
        sa.Column("filed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["case_id"], ["case.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_auto_filed_imap_message_lookup",
        "auto_filed_imap_message",
        ["case_id", "source_imap_mbox", "source_imap_uid"],
        unique=True,
    )
