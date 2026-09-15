"""allow audited repeat company-master imports

Revision ID: 20260716_0006
Revises: 20260716_0005
"""
from alembic import op
import sqlalchemy as sa
revision='20260716_0006';down_revision='20260716_0005';branch_labels=None;depends_on=None
def upgrade():
    inspector=sa.inspect(op.get_bind())
    for item in inspector.get_indexes('company_import_batches'):
        if item.get('unique') and item.get('column_names')==['file_hash']:op.drop_index(item['name'],table_name='company_import_batches')
    indexes={item['name'] for item in sa.inspect(op.get_bind()).get_indexes('company_import_batches')}
    if 'ix_company_import_batches_file_hash' not in indexes:op.create_index('ix_company_import_batches_file_hash','company_import_batches',['file_hash'],unique=False)
def downgrade():raise RuntimeError('Repeat-import audit downgrade is disabled to preserve import history')
