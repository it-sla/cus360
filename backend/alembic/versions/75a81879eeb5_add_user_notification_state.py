"""add user notification state"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
revision: str = '75a81879eeb5'
down_revision: Union[str, None] = 'b7f3c1a92e44'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None
def upgrade() -> None:
    op.create_table('user_notification_state',
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('seen_alert_ids', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id')
    )
def downgrade() -> None:
    op.drop_table('user_notification_state')
