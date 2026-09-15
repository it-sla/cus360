"""add pg_trgm

Revision ID: 20260802_0009
Revises: 20260716_0008
"""
from alembic import op

revision='20260802_0009'
down_revision='20260716_0008'

def upgrade():
    op.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm')

def downgrade():
    op.execute('DROP EXTENSION IF EXISTS pg_trgm')
