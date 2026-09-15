"""track CRM field provenance and manual shipment overrides

Revision ID: 20260716_0004
Revises: 20260716_0003
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision="20260716_0004";down_revision="20260716_0003";branch_labels=None;depends_on=None
def upgrade():
    columns={x['name'] for x in sa.inspect(op.get_bind()).get_columns('shipments')}
    if 'manual_override_fields' not in columns:op.add_column('shipments',sa.Column('manual_override_fields',postgresql.JSONB(),nullable=False,server_default='[]'))
    if 'crm_field_provenance' not in columns:op.add_column('shipments',sa.Column('crm_field_provenance',postgresql.JSONB(),nullable=False,server_default='{}'))
def downgrade():raise RuntimeError('Field provenance downgrade is disabled to preserve manual override metadata')
