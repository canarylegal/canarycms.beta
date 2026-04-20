"""drop roundcube SSO table; remove per-user IMAP host/port (use CANARY_IMAP_* env)

Revision ID: u8v9w0x1y2z3
Revises: q8w9e0r1t2y3
Create Date: 2026-04-18

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "u8v9w0x1y2z3"
down_revision = "q8w9e0r1t2y3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("roundcube_sso_token_use")
    op.drop_column("user_email_config", "imap_host")
    op.drop_column("user_email_config", "imap_port")


def downgrade() -> None:
    op.add_column(
        "user_email_config",
        sa.Column("imap_port", sa.Integer(), nullable=False, server_default="993"),
    )
    op.add_column(
        "user_email_config",
        sa.Column("imap_host", sa.String(length=255), nullable=False, server_default=""),
    )
    op.alter_column("user_email_config", "imap_host", server_default=None)
    op.alter_column("user_email_config", "imap_port", server_default=None)

    op.create_table(
        "roundcube_sso_token_use",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("jti", sa.String(length=128), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_roundcube_sso_token_use_jti"), "roundcube_sso_token_use", ["jti"], unique=True)
