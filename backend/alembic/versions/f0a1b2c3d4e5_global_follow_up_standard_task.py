"""Global system standard task \"Follow up\" + is_system / nullable sub-type FK.

Revision ID: f0a1b2c3d4e5
Revises: b2c3d4e5f6a9
Create Date: 2026-04-18
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "f0a1b2c3d4e5"
down_revision = "b2c3d4e5f6a9"
branch_labels = None
depends_on = None

FOLLOW_UP_ID = "a0000001-0000-4000-8000-000000000001"


def upgrade() -> None:
    op.add_column(
        "matter_sub_type_standard_task",
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.alter_column(
        "matter_sub_type_standard_task",
        "matter_sub_type_id",
        existing_type=UUID(as_uuid=True),
        nullable=True,
    )
    op.execute(
        f"""
        INSERT INTO matter_sub_type_standard_task
            (id, matter_sub_type_id, title, sort_order, is_system, created_at, updated_at)
        VALUES
            ('{FOLLOW_UP_ID}'::uuid, NULL, 'Follow up', -100, true, now(), now())
        """
    )
    op.create_check_constraint(
        "ck_matter_sub_type_standard_task_scope",
        "matter_sub_type_standard_task",
        "(is_system = true AND matter_sub_type_id IS NULL) OR (is_system = false AND matter_sub_type_id IS NOT NULL)",
    )
    op.alter_column(
        "matter_sub_type_standard_task",
        "is_system",
        server_default=None,
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM matter_sub_type_standard_task WHERE id = '{FOLLOW_UP_ID}'::uuid")
    op.drop_constraint("ck_matter_sub_type_standard_task_scope", "matter_sub_type_standard_task", type_="check")
    op.alter_column(
        "matter_sub_type_standard_task",
        "matter_sub_type_id",
        existing_type=UUID(as_uuid=True),
        nullable=False,
    )
    op.drop_column("matter_sub_type_standard_task", "is_system")
