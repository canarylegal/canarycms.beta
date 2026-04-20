"""per-calendar categories and Canary-only event category links

Revision ID: d0e1f2a3b4c5
Revises: c9d8e7f6a5b4

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "d0e1f2a3b4c5"
down_revision = "c9d8e7f6a5b4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_calendar_category",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("calendar_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user_calendar.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("color", sa.String(20), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("calendar_id", "name", name="uq_calendar_category_name"),
    )
    op.create_index("ix_user_calendar_category_calendar_id", "user_calendar_category", ["calendar_id"])

    op.create_table(
        "calendar_event_category",
        sa.Column("calendar_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user_calendar.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_uid", sa.String(512), nullable=False),
        sa.Column("category_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user_calendar_category.id", ondelete="SET NULL"), nullable=True),
        sa.PrimaryKeyConstraint("calendar_id", "event_uid"),
    )
    op.create_index("ix_calendar_event_category_category_id", "calendar_event_category", ["category_id"])


def downgrade() -> None:
    op.drop_table("calendar_event_category")
    op.drop_table("user_calendar_category")
