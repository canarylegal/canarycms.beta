"""add matter-specific contact type and reference on case_contact

Revision ID: c1a2b3c4d5e6
Revises: b2c3d4e5f6a7
Create Date: 2026-03-27

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c1a2b3c4d5e6"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("case_contact", sa.Column("matter_contact_type", sa.String(length=200), nullable=True))
    op.add_column("case_contact", sa.Column("matter_contact_reference", sa.String(length=500), nullable=True))


def downgrade() -> None:
    op.drop_column("case_contact", "matter_contact_reference")
    op.drop_column("case_contact", "matter_contact_type")
