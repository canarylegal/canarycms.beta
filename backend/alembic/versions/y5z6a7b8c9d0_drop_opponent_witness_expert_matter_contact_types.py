"""Remove default matter contact types opponent, witness, expert."""

from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op

revision = "y5z6a7b8c9d0"
down_revision = "w3x4y5z6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "DELETE FROM matter_contact_type_config WHERE slug IN ('opponent', 'witness', 'expert')"
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    rows = [
        ("opponent", "Opponent / other party", 50, False),
        ("witness", "Witness", 60, False),
        ("expert", "Expert", 70, False),
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
