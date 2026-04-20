"""ledger entry approval (pending postings)

Revision ID: n1o2p3q4r5s6
Revises: m4n5o6p7q8r9
Create Date: 2026-04-07
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "n1o2p3q4r5s6"
down_revision = "m4n5o6p7q8r9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ledger_entry",
        sa.Column("is_approved", sa.Boolean(), nullable=False, server_default=sa.text("true")),
    )
    op.alter_column("ledger_entry", "is_approved", server_default=None)


def downgrade() -> None:
    op.drop_column("ledger_entry", "is_approved")
