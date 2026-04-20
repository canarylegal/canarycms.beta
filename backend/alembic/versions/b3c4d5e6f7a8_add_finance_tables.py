"""add finance template and case finance tables

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-04-03

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "b3c4d5e6f7a8"
down_revision = "a2b3c4d5e6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Admin templates ───────────────────────────────────────────────────────

    op.create_table(
        "finance_category_template",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "matter_sub_type_id",
            UUID(as_uuid=True),
            sa.ForeignKey("matter_sub_type.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_finance_category_template_sub_type_id",
        "finance_category_template",
        ["matter_sub_type_id"],
    )

    op.create_table(
        "finance_item_template",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("finance_category_template.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        # "debit" | "credit"
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_finance_item_template_category_id",
        "finance_item_template",
        ["category_id"],
    )

    # ── Case-level finance data ───────────────────────────────────────────────

    op.create_table(
        "finance_category",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "case_id",
            UUID(as_uuid=True),
            sa.ForeignKey("case.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Null if this is a custom category not linked to the template.
        sa.Column(
            "template_category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("finance_category_template.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_finance_category_case_id", "finance_category", ["case_id"])

    op.create_table(
        "finance_item",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("finance_category.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Null if this is a custom item not linked to the template.
        sa.Column(
            "template_item_id",
            UUID(as_uuid=True),
            sa.ForeignKey("finance_item_template.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("direction", sa.String(10), nullable=False),
        # Null = amount not yet entered by user.
        sa.Column("amount_pence", sa.Integer, nullable=True),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_finance_item_category_id", "finance_item", ["category_id"])


def downgrade() -> None:
    op.drop_index("ix_finance_item_category_id", table_name="finance_item")
    op.drop_table("finance_item")
    op.drop_index("ix_finance_category_case_id", table_name="finance_category")
    op.drop_table("finance_category")
    op.drop_index("ix_finance_item_template_category_id", table_name="finance_item_template")
    op.drop_table("finance_item_template")
    op.drop_index("ix_finance_category_template_sub_type_id", table_name="finance_category_template")
    op.drop_table("finance_category_template")
