"""user calendars, shares, and public subscriptions

Revision ID: c9d8e7f6a5b4
Revises: b8c9d0e1f2a3
Create Date: 2026-03-31

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "c9d8e7f6a5b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_calendar",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("owner_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("radicale_slug", sa.String(80), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_user_id", "radicale_slug", name="uq_user_calendar_owner_slug"),
    )
    op.create_index("ix_user_calendar_owner_user_id", "user_calendar", ["owner_user_id"])
    op.create_index("ix_user_calendar_is_public", "user_calendar", ["is_public"])

    op.create_table(
        "user_calendar_share",
        sa.Column("calendar_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user_calendar.id", ondelete="CASCADE"), nullable=False),
        sa.Column("grantee_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("can_write", sa.Boolean(), nullable=False, server_default="false"),
        sa.PrimaryKeyConstraint("calendar_id", "grantee_user_id"),
    )
    op.create_index("ix_user_calendar_share_grantee", "user_calendar_share", ["grantee_user_id"])

    op.create_table(
        "user_calendar_subscription",
        sa.Column("subscriber_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("calendar_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("user_calendar.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("subscriber_user_id", "calendar_id"),
    )


def downgrade() -> None:
    op.drop_table("user_calendar_subscription")
    op.drop_table("user_calendar_share")
    op.drop_index("ix_user_calendar_is_public", table_name="user_calendar")
    op.drop_index("ix_user_calendar_owner_user_id", table_name="user_calendar")
    op.drop_table("user_calendar")
