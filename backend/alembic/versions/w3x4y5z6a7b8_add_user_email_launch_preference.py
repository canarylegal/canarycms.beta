"""add user email_launch_preference and email_outlook_web_url

Revision ID: w3x4y5z6a7b8
Revises: v2w3x4y5z6a7
Create Date: 2026-04-18

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "w3x4y5z6a7b8"
down_revision = "v2w3x4y5z6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user",
        sa.Column(
            "email_launch_preference",
            sa.String(length=32),
            nullable=False,
            server_default="desktop",
        ),
    )
    op.add_column("user", sa.Column("email_outlook_web_url", sa.Text(), nullable=True))
    op.alter_column("user", "email_launch_preference", server_default=None)


def downgrade() -> None:
    op.drop_column("user", "email_outlook_web_url")
    op.drop_column("user", "email_launch_preference")
