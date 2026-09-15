"""add auth users and seed initial accounts"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app.auth import hash_password

revision = "20260804_0010"
down_revision = "20260802_0009"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)

    if not inspector.has_table("users"):
        op.create_table(
            "users",
            sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("email", sa.String(), nullable=False, unique=True),
            sa.Column("display_name", sa.String(), nullable=False),
            sa.Column("role", sa.String(), nullable=False),
            sa.Column("password_hash", sa.String(), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        )
        op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)
        op.create_index(op.f("ix_users_role"), "users", ["role"], unique=False)

    admin_password = hash_password("admin123")
    user_password = hash_password("user123")

    bind.execute(
        sa.text(
            """
            INSERT INTO users (id, created_at, updated_at, email, display_name, role, password_hash, is_active)
            VALUES (:id, NOW(), NOW(), :email, :display_name, :role, :password_hash, TRUE)
            ON CONFLICT (email) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                role = EXCLUDED.role,
                password_hash = EXCLUDED.password_hash,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()
            """
        ),
        [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "email": "admin@gmail.com",
                "display_name": "Administrator",
                "role": "admin",
                "password_hash": admin_password,
            },
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "email": "user@gmail.com",
                "display_name": "Standard User",
                "role": "user",
                "password_hash": user_password,
            },
        ],
    )


def downgrade():
    op.execute(sa.text("DELETE FROM users WHERE email IN ('admin@gmail.com', 'user@gmail.com')"))
    inspector = inspect(op.get_bind())
    if inspector.has_table("users"):
        op.drop_index(op.f("ix_users_role"), table_name="users")
        op.drop_index(op.f("ix_users_email"), table_name="users")
        op.drop_table("users")