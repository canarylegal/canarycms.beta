"""Add case.matter_head_type_id — aligns DB with Case ORM (formerly missing revision).
Revision ID: e8f9a0b1c2d3
Revises: f0a1b2c3d4e5
Create Date: 2026-04-28
"""
from __future__ import annotations
import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import UUID
revision = "e8f9a0b1c2d3"
down_revision = "f0a1b2c3d4e5"
branch_labels = None
depends_on = None
def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("case")}
    if "matter_head_type_id" in cols:
        return
    op.add_column("case", sa.Column("matter_head_type_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        "fk_case_matter_head_type_id",
        "case",
        "matter_head_type",
        ["matter_head_type_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_case_matter_head_type_id", "case", ["matter_head_type_id"])
def downgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in inspect(bind).get_columns("case")}
    if "matter_head_type_id" not in cols:
        return
    op.drop_index("ix_case_matter_head_type_id", table_name="case")
    op.drop_constraint("fk_case_matter_head_type_id", "case", type_="foreignkey")
    op.drop_column("case", "matter_head_type_id")
