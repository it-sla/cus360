"""dedupe and enforce unique entity_type on crm_sync_state

Revision ID: 20260920_0001
Revises: 20260918_0001
Create Date: 2026-09-20
"""
from alembic import op
import sqlalchemy as sa

revision = '20260920_0001'
down_revision = '20260918_0001'
branch_labels = None
depends_on = None


def upgrade():
    # keep the most recently updated row per entity_type, drop the rest
    op.execute("""
        DELETE FROM crm_sync_state a
        USING crm_sync_state b
        WHERE a.entity_type = b.entity_type
          AND (a.updated_at, a.id) < (b.updated_at, b.id)
    """)
    op.create_unique_constraint('uq_crm_sync_state_entity_type', 'crm_sync_state', ['entity_type'])


def downgrade():
    op.drop_constraint('uq_crm_sync_state_entity_type', 'crm_sync_state', type_='unique')
