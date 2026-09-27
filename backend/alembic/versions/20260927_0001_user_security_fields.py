"""add session_version, last_login_at, failed_login_count, locked_until to users

Backs three things: session revocation on password change/reset/deactivation
(session_version), a last-login column for the Users table, and a simple
5-attempts/15-minutes login lockout (failed_login_count, locked_until).
"""
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "20260927_0001"
down_revision: Union[str, None] = "20260925_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("session_version", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("failed_login_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("users", sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "locked_until")
    op.drop_column("users", "failed_login_count")
    op.drop_column("users", "last_login_at")
    op.drop_column("users", "session_version")
