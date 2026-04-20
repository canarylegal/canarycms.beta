"""add precedent_category and links on precedent and matter_sub_type

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
Create Date: 2026-04-07
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "i9j0k1l2m3n4"
down_revision = "h8i9j0k1l2m3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "precedent_category",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_precedent_category_name", "precedent_category", ["name"], unique=True)

    op.add_column(
        "precedent",
        sa.Column("category_id", UUID(as_uuid=True), sa.ForeignKey("precedent_category.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column(
        "matter_sub_type",
        sa.Column(
            "default_precedent_category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("precedent_category.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("matter_sub_type", "default_precedent_category_id")
    op.drop_column("precedent", "category_id")
    op.drop_index("ix_precedent_category_name", table_name="precedent_category")
    op.drop_table("precedent_category")
