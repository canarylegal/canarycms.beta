"""add sub type prefix and menus

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-03-27 14:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = 'b2c3d4e5f6a7'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('matter_sub_type', sa.Column('prefix', sa.Text(), nullable=True))
    op.create_table(
        'matter_sub_type_menu',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('sub_type_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['sub_type_id'], ['matter_sub_type.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('matter_sub_type_menu')
    op.drop_column('matter_sub_type', 'prefix')
