"""file: Graph-style OWA pointers (parity with canarycms.experimental)

Revision ID: a1b2c3d4e5f8
Revises: z2a3b4c5d6e7
Create Date: 2026-04-19

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a1b2c3d4e5f8"
down_revision = "z2a3b4c5d6e7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("file", sa.Column("outlook_graph_message_id", sa.String(length=450), nullable=True))
    op.add_column("file", sa.Column("outlook_web_link", sa.Text(), nullable=True))
    op.execute(
        """
        UPDATE file
        SET outlook_graph_message_id = source_outlook_item_id
        WHERE outlook_graph_message_id IS NULL
          AND source_outlook_item_id IS NOT NULL
          AND trim(source_outlook_item_id) <> ''
        """
    )


def downgrade() -> None:
    op.drop_column("file", "outlook_web_link")
    op.drop_column("file", "outlook_graph_message_id")
