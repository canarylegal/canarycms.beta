"""add matter types

Revision ID: a1b2c3d4e5f6
Revises: f4a8b2c1d9e0
Create Date: 2026-03-27 12:00:00.000000

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = 'a1b2c3d4e5f6'
down_revision = 'f4a8b2c1d9e0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'matter_head_type',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_table(
        'matter_sub_type',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('head_type_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['head_type_id'], ['matter_head_type.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('head_type_id', 'name', name='uq_matter_sub_type_head_name'),
    )
    op.add_column('case', sa.Column('matter_sub_type_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        'fk_case_matter_sub_type',
        'case', 'matter_sub_type',
        ['matter_sub_type_id'], ['id'],
        ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_case_matter_sub_type', 'case', type_='foreignkey')
    op.drop_column('case', 'matter_sub_type_id')
    op.drop_table('matter_sub_type')
    op.drop_table('matter_head_type')
