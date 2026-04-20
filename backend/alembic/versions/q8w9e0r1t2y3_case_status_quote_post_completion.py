"""Add case_status enum values quote and post_completion."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "q8w9e0r1t2y3"
down_revision = "p0q1r2s3t4u5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # PostgreSQL: extend existing enum (values are lowercase to match CaseStatus values).
    op.execute(sa.text("ALTER TYPE case_status ADD VALUE IF NOT EXISTS 'quote'"))
    op.execute(sa.text("ALTER TYPE case_status ADD VALUE IF NOT EXISTS 'post_completion'"))


def downgrade() -> None:
    raise NotImplementedError("PostgreSQL does not support removing enum values safely.")
