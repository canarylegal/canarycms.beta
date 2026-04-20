"""Matter contact type config, primary client on case, lawyer–client links on case_contact."""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "n0o1p2q3r4s5"
down_revision = "m9n8o7p6q5r4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "matter_contact_type_config",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column("slug", sa.String(100), nullable=False),
        sa.Column("label", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.UniqueConstraint("slug", name="uq_matter_contact_type_config_slug"),
    )
    op.create_index("ix_matter_contact_type_config_sort_order", "matter_contact_type_config", ["sort_order"])

    conn = op.get_bind()
    rows = [
        ("client", "Client", 10, True),
        ("lawyers", "Lawyers", 20, True),
        ("new-lender", "New lender", 30, True),
        ("existing-lender", "Existing lender", 40, True),
        ("other", "Other", 80, False),
    ]
    for slug, label, sort_order, is_system in rows:
        conn.execute(
            sa.text(
                """
                INSERT INTO matter_contact_type_config (id, slug, label, sort_order, is_system)
                VALUES (:id, :slug, :label, :sort_order, :is_system)
                """
            ),
            {"id": uuid.uuid4(), "slug": slug, "label": label, "sort_order": sort_order, "is_system": is_system},
        )

    op.add_column(
        "case_contact",
        sa.Column("lawyer_client_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
    )

    op.add_column(
        "case",
        sa.Column("primary_client_case_contact_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_case_primary_client_case_contact",
        "case",
        "case_contact",
        ["primary_client_case_contact_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_case_primary_client_case_contact", "case", type_="foreignkey")
    op.drop_column("case", "primary_client_case_contact_id")
    op.drop_column("case_contact", "lawyer_client_ids")
    op.drop_index("ix_matter_contact_type_config_sort_order", table_name="matter_contact_type_config")
    op.drop_table("matter_contact_type_config")
