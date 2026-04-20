"""add roundcube_sso_token_use table for one-time SSO tokens

Revision ID: f4a8b2c1d9e0
Revises: e1f2a3b4c5d7
Create Date: 2026-03-27
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "f4a8b2c1d9e0"
down_revision = "e1f2a3b4c5d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "roundcube_sso_token_use",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("jti", sa.String(length=128), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("jti"),
    )
    op.create_index(op.f("ix_roundcube_sso_token_use_jti"), "roundcube_sso_token_use", ["jti"], unique=True)


def downgrade() -> None:
    op.drop_index(op.f("ix_roundcube_sso_token_use_jti"), table_name="roundcube_sso_token_use")
    op.drop_table("roundcube_sso_token_use")

