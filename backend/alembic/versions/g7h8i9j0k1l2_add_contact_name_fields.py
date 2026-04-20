"""add split name and county/company fields to contact and case_contact

Revision ID: g7h8i9j0k1l2
Revises: f6a7b8c9d0e1
Create Date: 2026-04-06
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "g7h8i9j0k1l2"
down_revision = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None

_NEW_COLS = [
    ("title",        sa.String(50)),
    ("first_name",   sa.String(150)),
    ("middle_name",  sa.String(150)),
    ("last_name",    sa.String(150)),
    ("county",       sa.String(150)),
    ("company_name", sa.String(300)),
    ("trading_name", sa.String(300)),
]


def upgrade() -> None:
    for table in ("contact", "case_contact"):
        for col_name, col_type in _NEW_COLS:
            op.add_column(table, sa.Column(col_name, col_type, nullable=True))


def downgrade() -> None:
    for table in ("contact", "case_contact"):
        for col_name, _ in _NEW_COLS:
            op.drop_column(table, col_name)
