"""user.job_title for admin display and precedent merge

Revision ID: k3l4m5n6o7p8
Revises: z1a2b3c4d5e6
Create Date: 2026-04-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "k3l4m5n6o7p8"
down_revision = "z1a2b3c4d5e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user", sa.Column("job_title", sa.String(length=300), nullable=True))


def downgrade() -> None:
    op.drop_column("user", "job_title")
