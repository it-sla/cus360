"""add crm_wins (mirror of CRM_Win.aspx win register)

Leaderboard wins now come from the CRM's own win register instead of
daily_call_logs.stage='Win'.
"""
from typing import Sequence, Union
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "20260929_0001"
down_revision: Union[str, None] = "20260928_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('crm_wins',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('win_date', sa.Date(), nullable=False),
        sa.Column('company_name', sa.String(), nullable=False),
        sa.Column('normalized_company_name', sa.String(), nullable=True),
        sa.Column('crm_customer_id', sa.String(), nullable=True),
        sa.Column('ae_code', sa.String(), nullable=True),
        sa.Column('weight_kg', sa.Numeric(14, 3), nullable=True),
        sa.Column('revenue_usd', sa.Numeric(16, 2), nullable=True),
        sa.Column('pieces', sa.Integer(), nullable=True),
        sa.Column('category', sa.String(), nullable=True),
        sa.Column('phone', sa.String(), nullable=True),
        sa.Column('remarks', sa.Text(), nullable=True),
        sa.Column('scraped_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_crm_wins_win_date', 'crm_wins', ['win_date'])
    op.create_index('ix_crm_wins_normalized_company_name', 'crm_wins', ['normalized_company_name'])
    op.create_index('ix_crm_wins_crm_customer_id', 'crm_wins', ['crm_customer_id'])
    op.create_index('ix_crm_wins_ae_code', 'crm_wins', ['ae_code'])


def downgrade() -> None:
    op.drop_table('crm_wins')
