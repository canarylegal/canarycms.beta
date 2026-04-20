"""user permission categories + case event calendar/reminder flags

Revision ID: o1p2q3r4s5t6
Revises: n1o2p3q4r5s6
Create Date: 2026-04-07
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "o1p2q3r4s5t6"
down_revision = "n1o2p3q4r5s6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_permission_category",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("perm_fee_earner", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("perm_post_client", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("perm_post_office", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("perm_approve_payments", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("perm_approve_invoices", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_user_permission_category_name", "user_permission_category", ["name"], unique=True)

    op.add_column(
        "user",
        sa.Column(
            "permission_category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user_permission_category.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    op.add_column(
        "case_event",
        sa.Column("track_in_calendar", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.add_column("case_event", sa.Column("calendar_event_uid", sa.String(512), nullable=True))
    op.add_column(
        "case_event",
        sa.Column("email_reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column("case_event", "track_in_calendar", server_default=None)
    op.alter_column("case_event", "email_reminders_enabled", server_default=None)


def downgrade() -> None:
    op.drop_column("case_event", "email_reminders_enabled")
    op.drop_column("case_event", "calendar_event_uid")
    op.drop_column("case_event", "track_in_calendar")
    op.drop_column("user", "permission_category_id")
    op.drop_index("ix_user_permission_category_name", table_name="user_permission_category")
    op.drop_table("user_permission_category")
