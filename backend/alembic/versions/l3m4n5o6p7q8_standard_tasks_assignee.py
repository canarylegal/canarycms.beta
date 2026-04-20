"""standard matter tasks + case task assignee / standard link

Revision ID: l3m4n5o6p7q8
Revises: k2l3m4n5o6p7
Create Date: 2026-04-07
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "l3m4n5o6p7q8"
down_revision = "k2l3m4n5o6p7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "matter_sub_type_standard_task",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "matter_sub_type_id",
            UUID(as_uuid=True),
            sa.ForeignKey("matter_sub_type.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "ix_matter_sub_type_standard_task_sub_type_id",
        "matter_sub_type_standard_task",
        ["matter_sub_type_id"],
    )

    op.add_column(
        "case_task",
        sa.Column(
            "standard_task_id",
            UUID(as_uuid=True),
            sa.ForeignKey("matter_sub_type_standard_task.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "case_task",
        sa.Column(
            "assigned_to_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("case_task", "assigned_to_user_id")
    op.drop_column("case_task", "standard_task_id")
    op.drop_index("ix_matter_sub_type_standard_task_sub_type_id", table_name="matter_sub_type_standard_task")
    op.drop_table("matter_sub_type_standard_task")
