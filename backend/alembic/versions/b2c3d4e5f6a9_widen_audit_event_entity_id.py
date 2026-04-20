"""widen audit_event.entity_id for Microsoft Graph message ids

Revision ID: b2c3d4e5f6a9
Revises: a1b2c3d4e5f8
Create Date: 2026-04-19

Graph REST ids (e.g. AAMkAD...) are longer than 100 characters.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b2c3d4e5f6a9"
down_revision = "a1b2c3d4e5f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "audit_event",
        "entity_id",
        existing_type=sa.String(length=100),
        type_=sa.String(length=500),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "audit_event",
        "entity_id",
        existing_type=sa.String(length=500),
        type_=sa.String(length=100),
        existing_nullable=True,
    )
