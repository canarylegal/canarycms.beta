"""make file_edit_session.case_id nullable for precedent editing

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
Create Date: 2026-04-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "h8i9j0k1l2m3"
down_revision = "g7h8i9j0k1l2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("file_edit_session", "case_id", nullable=True)


def downgrade() -> None:
    op.alter_column("file_edit_session", "case_id", nullable=False)
