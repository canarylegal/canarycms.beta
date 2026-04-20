"""case_task.is_private for manually created private tasks."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "x2y3z4a5b6c7"
down_revision = "t7u8v9w0x1y2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "case_task",
        sa.Column("is_private", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.alter_column("case_task", "is_private", server_default=None)


def downgrade() -> None:
    op.drop_column("case_task", "is_private")
