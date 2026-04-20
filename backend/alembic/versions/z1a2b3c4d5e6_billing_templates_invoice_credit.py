"""billing line templates, settings, case_invoice.credit_user_id

Revision ID: z1a2b3c4d5e6
Revises: p2q3r4s5t6u7
Create Date: 2026-04-10

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "z1a2b3c4d5e6"
down_revision = "p2q3r4s5t6u7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "billing_settings",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("default_vat_percent", sa.Numeric(8, 3), nullable=False, server_default="20.000"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("INSERT INTO billing_settings (id, default_vat_percent) VALUES (1, 20.000)")

    op.create_table(
        "billing_line_template",
        sa.Column("id", UUID(as_uuid=True), nullable=False),
        sa.Column("matter_sub_type_id", UUID(as_uuid=True), nullable=False),
        sa.Column("line_kind", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("default_amount_pence", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
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
        sa.ForeignKeyConstraint(["matter_sub_type_id"], ["matter_sub_type.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_billing_line_template_sub_kind",
        "billing_line_template",
        ["matter_sub_type_id", "line_kind"],
    )

    op.add_column(
        "case_invoice",
        sa.Column("credit_user_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_case_invoice_credit_user",
        "case_invoice",
        "user",
        ["credit_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_case_invoice_credit_user", "case_invoice", type_="foreignkey")
    op.drop_column("case_invoice", "credit_user_id")
    op.drop_index("ix_billing_line_template_sub_kind", table_name="billing_line_template")
    op.drop_table("billing_line_template")
    op.drop_table("billing_settings")
