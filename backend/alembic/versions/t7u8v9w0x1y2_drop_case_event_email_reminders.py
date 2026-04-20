"""Remove case event e-mail reminder column and audit table.

Revision ID: t7u8v9w0x1y2
Revises: s5t6u7v8w9x0
Create Date: 2026-04-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "t7u8v9w0x1y2"
down_revision = "s5t6u7v8w9x0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("ix_case_event_reminder_sent_event", table_name="case_event_reminder_sent")
    op.drop_table("case_event_reminder_sent")
    op.drop_column("case_event", "email_reminders_enabled")


def downgrade() -> None:
    op.add_column(
        "case_event",
        sa.Column("email_reminders_enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column("case_event", "email_reminders_enabled", server_default=None)
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
