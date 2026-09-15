"""extend company master import audit and manual protection

Revision ID: 20260716_0005
Revises: 20260716_0004
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision="20260716_0005";down_revision="20260716_0004";branch_labels=None;depends_on=None
TZ=sa.DateTime(timezone=True);UUID=postgresql.UUID(as_uuid=True)
def upgrade():
    inspector=sa.inspect(op.get_bind());company_cols={x['name'] for x in inspector.get_columns('companies')};batch_cols={x['name'] for x in inspector.get_columns('company_import_batches')}
    for column in [sa.Column('manual_override_fields',postgresql.JSONB(),nullable=False,server_default='[]'),sa.Column('last_company_import_at',TZ),sa.Column('last_company_import_batch_id',UUID)]:
        if column.name not in company_cols:op.add_column('companies',column)
    additions=[sa.Column('worksheet_name',sa.String()),sa.Column('mapping_json',postgresql.JSONB())]+[sa.Column(name,sa.Integer(),nullable=False,server_default='0') for name in ('valid_count','blank_icris_count','blank_name_count','unique_icris_count','duplicate_group_count','promoted_count','alias_added_count','unchanged_count','conflict_count','rejected_count')]
    for column in additions:
        if column.name not in batch_cols:op.add_column('company_import_batches',column)
    for item in inspector.get_unique_constraints('company_import_batches'):
        if item.get('column_names')==['file_hash']:op.drop_constraint(item['name'],'company_import_batches',type_='unique')
def downgrade():raise RuntimeError('Company import audit downgrade is disabled to preserve import history')
