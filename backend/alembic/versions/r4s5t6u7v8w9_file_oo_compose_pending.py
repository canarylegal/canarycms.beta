"""file.oo_compose_pending — hide OnlyOffice compose drafts until Save & Close

Revision ID: r4s5t6u7v8w9
Revises: k3l4m5n6o7p8
Create Date: 2026-04-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "r4s5t6u7v8w9"
down_revision = "k3l4m5n6o7p8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "file",
        sa.Column("oo_compose_pending", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("file", "oo_compose_pending")
