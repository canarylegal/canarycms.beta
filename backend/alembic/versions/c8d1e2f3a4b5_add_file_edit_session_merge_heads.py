"""add file_edit_session (WebDAV desktop edit) and merge alembic heads

Revision ID: c8d1e2f3a4b5
Revises: b6a2e5ce9f3b, 57c827bce15b
Create Date: 2026-03-20
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "c8d1e2f3a4b5"
down_revision = ("b6a2e5ce9f3b", "57c827bce15b")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "file_edit_session",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token", sa.String(length=128), nullable=False),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("case_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["case_id"], ["case.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["file_id"], ["file.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_file_edit_session_token"), "file_edit_session", ["token"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_file_edit_session_token"), table_name="file_edit_session")
    op.drop_table("file_edit_session")
