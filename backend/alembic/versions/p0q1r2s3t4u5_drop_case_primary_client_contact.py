"""Remove case.primary_client_case_contact_id (unused designation field)."""

from __future__ import annotations

from alembic import op

revision = "p0q1r2s3t4u5"
down_revision = "n0o1p2q3r4s5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("fk_case_primary_client_case_contact", "case", type_="foreignkey")
    op.drop_column("case", "primary_client_case_contact_id")


def downgrade() -> None:
    raise NotImplementedError
