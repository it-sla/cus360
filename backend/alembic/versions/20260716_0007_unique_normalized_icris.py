"""enforce case-insensitive trimmed ICRIS uniqueness

Revision ID: 20260716_0007
Revises: 20260716_0006
"""
from alembic import op
revision='20260716_0007';down_revision='20260716_0006';branch_labels=None;depends_on=None
def upgrade():op.execute('CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_normalized_icris ON companies ((upper(btrim(icris_number))))')
def downgrade():raise RuntimeError('Normalized ICRIS uniqueness downgrade is disabled to protect customer identity')
