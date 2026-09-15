"""add notification snooze column"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = '75a81879eeb5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
def upgrade() -> None:
    op.add_column('user_notification_state',
        sa.Column('snoozed', postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='{}'))
def downgrade() -> None:
    op.drop_column('user_notification_state', 'snoozed')
