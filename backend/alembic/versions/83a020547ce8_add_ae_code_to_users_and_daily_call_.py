"""add ae_code to users and daily_call_logs table"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
revision: str = '83a020547ce8'
down_revision: Union[str, None] = '20260812_0015'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
def upgrade() -> None:
    op.create_table('daily_call_logs',
    sa.Column('call_date', sa.Date(), nullable=False),
    sa.Column('company_name', sa.String(), nullable=False),
    sa.Column('crm_customer_id', sa.String(), nullable=True),
    sa.Column('stage', sa.String(), nullable=True),
    sa.Column('category', sa.String(), nullable=True),
    sa.Column('contact_person', sa.String(), nullable=True),
    sa.Column('phone', sa.String(), nullable=True),
    sa.Column('call_type', sa.String(), nullable=True),
    sa.Column('ae_code', sa.String(), nullable=True),
    sa.Column('remarks', sa.Text(), nullable=True),
    sa.Column('supervisor_comment', sa.Text(), nullable=True),
    sa.Column('follow_up_date', sa.Date(), nullable=True),
    sa.Column('scraped_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('id', sa.UUID(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_daily_call_logs_ae_code'), 'daily_call_logs', ['ae_code'], unique=False)
    op.create_index(op.f('ix_daily_call_logs_call_date'), 'daily_call_logs', ['call_date'], unique=False)
    op.create_index(op.f('ix_daily_call_logs_category'), 'daily_call_logs', ['category'], unique=False)
    op.create_index(op.f('ix_daily_call_logs_company_name'), 'daily_call_logs', ['company_name'], unique=False)
    op.create_index(op.f('ix_daily_call_logs_crm_customer_id'), 'daily_call_logs', ['crm_customer_id'], unique=False)
    op.add_column('users', sa.Column('ae_code', sa.String(), nullable=True))
    op.create_index(op.f('ix_users_ae_code'), 'users', ['ae_code'], unique=False)
def downgrade() -> None:
    op.drop_index(op.f('ix_users_ae_code'), table_name='users')
    op.drop_column('users', 'ae_code')
    op.drop_index(op.f('ix_daily_call_logs_crm_customer_id'), table_name='daily_call_logs')
    op.drop_index(op.f('ix_daily_call_logs_company_name'), table_name='daily_call_logs')
    op.drop_index(op.f('ix_daily_call_logs_category'), table_name='daily_call_logs')
    op.drop_index(op.f('ix_daily_call_logs_call_date'), table_name='daily_call_logs')
    op.drop_index(op.f('ix_daily_call_logs_ae_code'), table_name='daily_call_logs')
    op.drop_table('daily_call_logs')
