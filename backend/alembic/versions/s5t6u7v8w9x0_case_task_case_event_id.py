"""case_task.case_event_id — link tasks to tracked case events

Revision ID: s5t6u7v8w9x0
Revises: r4s5t6u7v8w9
Create Date: 2026-04-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "s5t6u7v8w9x0"
down_revision = "r4s5t6u7v8w9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "case_task",
        sa.Column("case_event_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "case_task_case_event_id_fkey",
        "case_task",
        "case_event",
        ["case_event_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "uq_case_task_case_event_id",
        "case_task",
        ["case_event_id"],
        unique=True,
        postgresql_where=sa.text("case_event_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_case_task_case_event_id", table_name="case_task")
    op.drop_constraint("case_task_case_event_id_fkey", "case_task", type_="foreignkey")
    op.drop_column("case_task", "case_event_id")
