"""precedent categories scoped to matter sub-type; required precedent category

Revision ID: j1k2l3m4n5o6
Revises: i9j0k1l2m3n4
Create Date: 2026-04-07
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "j1k2l3m4n5o6"
down_revision = "i9j0k1l2m3n4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()

    op.execute(
        sa.text(
            "ALTER TABLE matter_sub_type DROP CONSTRAINT IF EXISTS matter_sub_type_default_precedent_category_id_fkey"
        )
    )
    op.drop_column("matter_sub_type", "default_precedent_category_id")

    op.drop_index("ix_precedent_category_name", table_name="precedent_category")

    op.add_column(
        "precedent_category",
        sa.Column("matter_sub_type_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "precedent_category_matter_sub_type_id_fkey",
        "precedent_category",
        "matter_sub_type",
        ["matter_sub_type_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    first_sub = conn.execute(
        sa.text("SELECT id FROM matter_sub_type ORDER BY created_at ASC NULLS LAST LIMIT 1")
    ).scalar()
    if first_sub:
        conn.execute(
            sa.text(
                "UPDATE precedent_category SET matter_sub_type_id = :sid WHERE matter_sub_type_id IS NULL"
            ),
            {"sid": first_sub},
        )

    op.execute(sa.text("DELETE FROM precedent_category WHERE matter_sub_type_id IS NULL"))

    n_cat = conn.execute(sa.text("SELECT COUNT(*) FROM precedent_category")).scalar() or 0
    if n_cat == 0 and first_sub:
        cid = uuid.uuid4()
        conn.execute(
            sa.text(
                """
                INSERT INTO precedent_category (id, name, sort_order, matter_sub_type_id, created_at, updated_at)
                VALUES (:id, 'General', 0, :sid, now(), now())
                """
            ),
            {"id": cid, "sid": first_sub},
        )

    op.execute(
        sa.text(
            """
            UPDATE precedent SET category_id = (
                SELECT id FROM precedent_category ORDER BY sort_order ASC, name ASC LIMIT 1
            )
            WHERE category_id IS NULL
            """
        )
    )

    n_null = conn.execute(sa.text("SELECT COUNT(*) FROM precedent WHERE category_id IS NULL")).scalar() or 0
    if n_null > 0:
        raise RuntimeError(
            "Cannot complete migration: precedents without category and no precedent_category rows; "
            "add at least one matter sub-type and precedent category."
        )

    op.execute(sa.text("ALTER TABLE precedent DROP CONSTRAINT IF EXISTS precedent_category_id_fkey"))
    op.alter_column("precedent", "category_id", existing_type=UUID(as_uuid=True), nullable=False)
    op.create_foreign_key(
        "precedent_category_id_fkey",
        "precedent",
        "precedent_category",
        ["category_id"],
        ["id"],
        ondelete="RESTRICT",
    )

    op.alter_column(
        "precedent_category",
        "matter_sub_type_id",
        existing_type=UUID(as_uuid=True),
        nullable=False,
    )

    op.create_unique_constraint(
        "uq_precedent_category_sub_name",
        "precedent_category",
        ["matter_sub_type_id", "name"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_precedent_category_sub_name", "precedent_category", type_="unique")

    op.execute(sa.text("ALTER TABLE precedent DROP CONSTRAINT IF EXISTS precedent_category_id_fkey"))
    op.create_foreign_key(
        "precedent_category_id_fkey",
        "precedent",
        "precedent_category",
        ["category_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.alter_column("precedent", "category_id", existing_type=UUID(as_uuid=True), nullable=True)

    op.execute(
        sa.text(
            "ALTER TABLE precedent_category DROP CONSTRAINT IF EXISTS precedent_category_matter_sub_type_id_fkey"
        )
    )
    op.drop_column("precedent_category", "matter_sub_type_id")

    op.create_index("ix_precedent_category_name", "precedent_category", ["name"], unique=True)

    op.add_column(
        "matter_sub_type",
        sa.Column(
            "default_precedent_category_id",
            UUID(as_uuid=True),
            sa.ForeignKey("precedent_category.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
