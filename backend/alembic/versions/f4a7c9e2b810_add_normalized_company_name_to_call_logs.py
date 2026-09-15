"""add normalized_company_name to daily_call_logs

Revision ID: a1b2c3d4e5f6
Revises: d3f6b8a1c452
Create Date: 2026-09-09 00:00:00.000000

"""
import re

import sqlalchemy as sa
from alembic import op

revision = 'f4a7c9e2b810'
down_revision = 'd3f6b8a1c452'
branch_labels = None
depends_on = None


def _normalize_name(value: str) -> str:
    value = re.sub(r"[^\w\s]", " ", str(value).casefold())
    value = re.sub(r"\b(pvt|private)\s+(ltd|limited)\b", "pvt ltd", value)
    return re.sub(r"\s+", " ", value).strip()


def upgrade() -> None:
    op.add_column('daily_call_logs', sa.Column('normalized_company_name', sa.String(), nullable=True))
    op.create_index('ix_daily_call_logs_normalized_company_name', 'daily_call_logs', ['normalized_company_name'])

    conn = op.get_bind()
    rows = conn.execute(sa.text('SELECT id, company_name FROM daily_call_logs')).fetchall()
    for row_id, company_name in rows:
        conn.execute(
            sa.text('UPDATE daily_call_logs SET normalized_company_name = :n WHERE id = :id'),
            {'n': _normalize_name(company_name), 'id': row_id},
        )


def downgrade() -> None:
    op.drop_index('ix_daily_call_logs_normalized_company_name', table_name='daily_call_logs')
    op.drop_column('daily_call_logs', 'normalized_company_name')
