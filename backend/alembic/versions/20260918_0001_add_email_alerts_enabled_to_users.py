"""add email_alerts_enabled to users

Revision ID: 20260918_0001
Revises: f4a7c9e2b810
Create Date: 2026-09-18
"""
from alembic import op
import sqlalchemy as sa

revision = '20260918_0001'
down_revision = 'f4a7c9e2b810'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('email_alerts_enabled', sa.Boolean(), nullable=False, server_default='true'))


def downgrade():
    op.drop_column('users', 'email_alerts_enabled')
