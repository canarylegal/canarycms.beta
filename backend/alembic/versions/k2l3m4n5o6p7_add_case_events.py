"""matter sub-type event templates + per-case events with dates

Revision ID: k2l3m4n5o6p7
Revises: j1k2l3m4n5o6
Create Date: 2026-04-07
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "k2l3m4n5o6p7"
down_revision = "j1k2l3m4n5o6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "matter_sub_type_event_template",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "matter_sub_type_id",
            UUID(as_uuid=True),
            sa.ForeignKey("matter_sub_type.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(
        "ix_matter_sub_type_event_template_sub_type",
        "matter_sub_type_event_template",
        ["matter_sub_type_id"],
    )

    op.create_table(
        "case_event",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("case_id", UUID(as_uuid=True), sa.ForeignKey("case.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "template_id",
            UUID(as_uuid=True),
            sa.ForeignKey("matter_sub_type_event_template.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("event_date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_case_event_case_id", "case_event", ["case_id"])


def downgrade() -> None:
    op.drop_index("ix_case_event_case_id", table_name="case_event")
    op.drop_table("case_event")
    op.drop_index("ix_matter_sub_type_event_template_sub_type", table_name="matter_sub_type_event_template")
    op.drop_table("matter_sub_type_event_template")
