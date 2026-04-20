"""add source_mail_is_outbound on file for mail icon direction

Revision ID: a7b8c9d0e1f2
Revises: f5c6d7e8f9a0
Create Date: 2026-03-31

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a7b8c9d0e1f2"
down_revision = "f5c6d7e8f9a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file", sa.Column("source_mail_is_outbound", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("file", "source_mail_is_outbound")
