"""add territory_name to account_executives

Revision ID: 20260923_0001
Revises: 20260922_0001
Create Date: 2026-09-23 00:00:00.000000

"""
import sqlalchemy as sa
from alembic import op

revision = '20260923_0001'
down_revision = '20260922_0001'
branch_labels = None
depends_on = None

# Confirmed 2026-09-23: only the 4 geographic AEs get a "Territory N" label plus DN as
# "Resellers". SLR / AJ / RT are left NULL (unclassified) — user will divide AJ/RT later.
TERRITORY_NAMES = {
    'AS': 'Territory 1 — North & West Kathmandu',
    'PR': 'Territory 2 — Northeast & East Kathmandu',
    'PS': 'Territory 3 — Southeast Kathmandu / KTM-Lalitpur Border',
    'NT': 'Territory 4 — Southwest Kathmandu / Lalitpur & Kirtipur',
    'DN': 'Resellers',
}


def upgrade() -> None:
    op.add_column('account_executives', sa.Column('territory_name', sa.String(), nullable=True))
    conn = op.get_bind()
    for ae_code, territory in TERRITORY_NAMES.items():
        conn.execute(
            sa.text('UPDATE account_executives SET territory_name = :t WHERE ae_code = :c'),
            {'t': territory, 'c': ae_code},
        )


def downgrade() -> None:
    op.drop_column('account_executives', 'territory_name')
