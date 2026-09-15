"""add source_row_hash to daily_call_logs"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
revision: str = '75c1bf35d6b3'
down_revision: Union[str, None] = '83a020547ce8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
def upgrade() -> None:
    op.add_column('daily_call_logs', sa.Column('source_row_hash', sa.String(), nullable=False))
    op.create_index(op.f('ix_daily_call_logs_source_row_hash'), 'daily_call_logs', ['source_row_hash'], unique=True)
def downgrade() -> None:
    op.drop_index(op.f('ix_daily_call_logs_source_row_hash'), table_name='daily_call_logs')
    op.drop_column('daily_call_logs', 'source_row_hash')
