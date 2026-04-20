"""add source_mail_from_* on file for filed .eml display

Revision ID: f5c6d7e8f9a0
Revises: e3f4a5b6c8d9
Create Date: 2026-03-31

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f5c6d7e8f9a0"
down_revision = "e3f4a5b6c8d9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file", sa.Column("source_mail_from_name", sa.Text(), nullable=True))
    op.add_column("file", sa.Column("source_mail_from_email", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("file", "source_mail_from_email")
    op.drop_column("file", "source_mail_from_name")
