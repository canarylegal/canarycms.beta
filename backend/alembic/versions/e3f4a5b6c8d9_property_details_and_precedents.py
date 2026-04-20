"""case property details (JSONB) + precedents

Revision ID: e3f4a5b6c8d9
Revises: d2e3f4a5b6c7
Create Date: 2026-03-31

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects.postgresql import ENUM, JSONB, UUID

revision = "e3f4a5b6c8d9"
down_revision = "d2e3f4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    existing = set(insp.get_table_names())

    if "case_property_details" not in existing:
        op.create_table(
            "case_property_details",
            sa.Column("case_id", UUID(as_uuid=True), nullable=False),
            sa.Column("payload", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("timezone('utc', now())"),
            ),
            sa.ForeignKeyConstraint(["case_id"], ["case.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("case_id"),
        )

    # Create enum at most once (avoid duplicate CREATE TYPE from sa.Enum + create_table).
    op.execute(
        sa.text(
            """
            DO $$ BEGIN
                CREATE TYPE precedent_kind AS ENUM ('letter', 'email', 'document');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
            END $$;
            """
        )
    )

    if "precedent" not in existing:
        kind_col = ENUM("letter", "email", "document", name="precedent_kind", create_type=False)
        op.create_table(
            "precedent",
            sa.Column("id", UUID(as_uuid=True), nullable=False),
            sa.Column("name", sa.String(length=300), nullable=False),
            sa.Column("reference", sa.String(length=200), nullable=False),
            sa.Column("kind", kind_col, nullable=False),
            sa.Column("file_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("timezone('utc', now())"),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("timezone('utc', now())"),
            ),
            sa.ForeignKeyConstraint(["file_id"], ["file.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("file_id"),
        )


def downgrade() -> None:
    op.drop_table("precedent")
    op.execute(sa.text("DROP TYPE IF EXISTS precedent_kind"))
    op.drop_table("case_property_details")
