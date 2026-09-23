"""rename territory_name values to include neighborhood ranges

Revision ID: 20260923_0002
Revises: 20260923_0001
Create Date: 2026-09-23 00:00:00.000000

"""
import sqlalchemy as sa
from alembic import op

revision = '20260923_0002'
down_revision = '20260923_0001'
branch_labels = None
depends_on = None

# Confirmed 2026-09-23 — same 4 geographic AEs from migration 20260923_0001, renamed to
# include the neighborhood range each territory covers. Must stay in sync with
# TERRITORY_NAMES in backend/app/ae_imports.py.
TERRITORY_NAMES = {
    'AS': 'Territory 1 — North & West Kathmandu (Thamel to Sitapaila)',
    'PR': 'Territory 2 — Northeast & East Kathmandu (Baneshwor to Boudha)',
    'PS': 'Territory 3 — Southeast Kathmandu (Koteshwor to Kupondole)',
    'NT': 'Territory 4 — Southwest Kathmandu (Kirtipur to Jawalakhel)',
}


def upgrade() -> None:
    conn = op.get_bind()
    for ae_code, territory in TERRITORY_NAMES.items():
        conn.execute(
            sa.text('UPDATE account_executives SET territory_name = :t WHERE ae_code = :c'),
            {'t': territory, 'c': ae_code},
        )


def downgrade() -> None:
    old_names = {
        'AS': 'Territory 1 — North & West Kathmandu',
        'PR': 'Territory 2 — Northeast & East Kathmandu',
        'PS': 'Territory 3 — Southeast Kathmandu / KTM-Lalitpur Border',
        'NT': 'Territory 4 — Southwest Kathmandu / Lalitpur & Kirtipur',
    }
    conn = op.get_bind()
    for ae_code, territory in old_names.items():
        conn.execute(
            sa.text('UPDATE account_executives SET territory_name = :t WHERE ae_code = :c'),
            {'t': territory, 'c': ae_code},
        )
