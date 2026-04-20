"""case_task priority

Revision ID: m4n5o6p7q8r9
Revises: l3m4n5o6p7q8
Create Date: 2026-04-07
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "m4n5o6p7q8r9"
down_revision = "l3m4n5o6p7q8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "case_task",
        sa.Column("priority", sa.String(length=20), nullable=False, server_default="normal"),
    )


def downgrade() -> None:
    op.drop_column("case_task", "priority")
