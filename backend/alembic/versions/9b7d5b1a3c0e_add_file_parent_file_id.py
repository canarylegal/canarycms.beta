"""add file parent/child link for grouped artifacts

Revision ID: 9b7d5b1a3c0e
Revises: d1e2f3a4b5c6
Create Date: 2026-03-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "9b7d5b1a3c0e"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "file",
        sa.Column(
            "parent_file_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_index(op.f("ix_file_parent_file_id"), "file", ["parent_file_id"], unique=False)

    op.create_foreign_key(
        op.f("fk_file_parent_file_id_file"),
        "file",
        "file",
        ["parent_file_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("fk_file_parent_file_id_file"), "file", type_="foreignkey")
    op.drop_index(op.f("ix_file_parent_file_id"), table_name="file")
    op.drop_column("file", "parent_file_id")

