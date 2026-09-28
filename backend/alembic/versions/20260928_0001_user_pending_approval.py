"""add pending_approval to users

Self-service registration creates an inactive, pending account; a super admin
approves it (choosing the role) or rejects it (deletes the row).
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "20260928_0001"
down_revision: Union[str, None] = "20260927_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("pending_approval", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("users", "pending_approval")
