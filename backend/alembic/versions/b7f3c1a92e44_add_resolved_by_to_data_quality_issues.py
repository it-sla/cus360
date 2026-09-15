"""add resolved_by to data_quality_issues"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'b7f3c1a92e44'
down_revision: Union[str, None] = 'a4d8f2c91b03'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('data_quality_issues', sa.Column('resolved_by', sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column('data_quality_issues', 'resolved_by')
