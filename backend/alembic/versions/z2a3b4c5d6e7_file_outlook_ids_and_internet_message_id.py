"""file: Outlook REST item id + RFC822 Message-ID for OWA links

Revision ID: z2a3b4c5d6e7
Revises: y5z6a7b8c9d0
Create Date: 2026-04-18

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "z2a3b4c5d6e7"
down_revision = "y5z6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file", sa.Column("source_internet_message_id", sa.Text(), nullable=True))
    op.add_column("file", sa.Column("source_outlook_item_id", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("file", "source_outlook_item_id")
    op.drop_column("file", "source_internet_message_id")
