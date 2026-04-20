"""add optional IMAP refs for filed-from-Roundcube emails

Revision ID: e1f2a3b4c5d7
Revises: 9b7d5b1a3c0e
Create Date: 2026-03-26
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "e1f2a3b4c5d7"
down_revision = "9b7d5b1a3c0e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file", sa.Column("source_imap_mbox", sa.Text(), nullable=True))
    op.add_column("file", sa.Column("source_imap_uid", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("file", "source_imap_uid")
    op.drop_column("file", "source_imap_mbox")
