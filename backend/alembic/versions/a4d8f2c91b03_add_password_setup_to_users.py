"""add password setup flow columns to users"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'a4d8f2c91b03'
down_revision: Union[str, None] = '75c1bf35d6b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column('users', 'password_hash', existing_type=sa.String(), nullable=True)
    op.add_column('users', sa.Column('must_change_password', sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column('users', sa.Column('setup_token_hash', sa.String(), nullable=True))
    op.add_column('users', sa.Column('setup_token_expires_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f('ix_users_setup_token_hash'), 'users', ['setup_token_hash'], unique=True)


def downgrade() -> None:
    op.drop_index(op.f('ix_users_setup_token_hash'), table_name='users')
    op.drop_column('users', 'setup_token_expires_at')
    op.drop_column('users', 'setup_token_hash')
    op.drop_column('users', 'must_change_password')
    op.alter_column('users', 'password_hash', existing_type=sa.String(), nullable=False)
