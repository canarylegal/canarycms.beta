"""Remove leftover tables/columns from removed e-sign integrations (if present)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "m9n8o7p6q5r4"
down_revision = "x2y3z4a5b6c7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS docuseal_submission CASCADE"))
    op.execute(sa.text("DROP TABLE IF EXISTS documenso_envelope CASCADE"))
    op.execute(sa.text('ALTER TABLE "user" DROP COLUMN IF EXISTS documenso_login_email'))
    op.execute(sa.text('ALTER TABLE "user" DROP COLUMN IF EXISTS documenso_password_enc'))


def downgrade() -> None:
    raise NotImplementedError
