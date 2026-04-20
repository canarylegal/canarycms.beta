"""add caldav_password_enc on user for Radicale provisioning

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-03-31

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user", sa.Column("caldav_password_enc", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("user", "caldav_password_enc")
