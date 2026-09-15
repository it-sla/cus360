"""add AE roster, company AE assignment, reassignment log, and AE import batches"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260810_0011"
down_revision = "20260804_0010"
branch_labels = None
depends_on = None

# The known AE codes already in shipments.ae_code, seeded with the display names confirmed
# 2026-08-10. SLR, RTL, JS, SB have no confirmed display name yet — seeded code-only.
SEED_AES = [
    ("PS", "Pratik"),
    ("AS", "Ankit"),
    ("DN", "Dinesh"),
    ("PR", "Prakash"),
    ("RT", "Rupesh"),
    ("NT", "Namuna"),
    ("AJ", "Akrit"),
    ("SLR", None),
    ("RTL", None),
    ("JS", None),
    ("SB", None),
]


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("account_executives"):
        op.create_table(
            "account_executives",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("ae_code", sa.String(), nullable=False, unique=True),
            sa.Column("display_name", sa.String(), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        )
        op.create_index("ix_account_executives_ae_code", "account_executives", ["ae_code"], unique=True)

    if not inspector.has_table("ae_reassignment_log"):
        op.create_table(
            "ae_reassignment_log",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("from_ae_code", sa.String(), nullable=True),
            sa.Column("to_ae_code", sa.String(), nullable=True),
            sa.Column("reason", sa.String(), nullable=True),
            sa.Column("source", sa.String(), nullable=False, server_default="manual"),
            sa.Column("changed_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("shipments_updated", sa.Integer(), nullable=False, server_default="0"),
        )

    if not inspector.has_table("ae_import_batches"):
        op.create_table(
            "ae_import_batches",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("file_name", sa.String(), nullable=False),
            sa.Column("file_hash", sa.String(), nullable=False, index=True),
            sa.Column("worksheet_name", sa.String(), nullable=True),
            sa.Column("total_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("matched_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("reassigned_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("unchanged_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("unmatched_icris_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("unknown_ae_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("invalid_row_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        )

    if not inspector.has_table("ae_import_rows"):
        op.create_table(
            "ae_import_rows",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("import_batch_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("ae_import_batches.id", ondelete="CASCADE"), nullable=False, index=True),
            sa.Column("row_number", sa.Integer(), nullable=False),
            sa.Column("raw_data_json", postgresql.JSONB(), nullable=False),
            sa.Column("processing_status", sa.String(), nullable=False),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("company_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("companies.id"), nullable=True),
        )

    cols = {c["name"] for c in inspector.get_columns("companies")}
    if "assigned_ae_code" not in cols:
        op.add_column("companies", sa.Column("assigned_ae_code", sa.String(), nullable=True))
        op.create_index("ix_companies_assigned_ae_code", "companies", ["assigned_ae_code"])
    if "ae_assigned_at" not in cols:
        op.add_column("companies", sa.Column("ae_assigned_at", sa.DateTime(timezone=True), nullable=True))

    bind.execute(
        sa.text(
            """
            INSERT INTO account_executives (id, created_at, updated_at, ae_code, display_name, is_active)
            VALUES (gen_random_uuid(), NOW(), NOW(), :ae_code, :display_name, TRUE)
            ON CONFLICT (ae_code) DO NOTHING
            """
        ),
        [{"ae_code": code, "display_name": name} for code, name in SEED_AES],
    )


def downgrade():
    op.drop_index("ix_companies_assigned_ae_code", table_name="companies")
    op.drop_column("companies", "ae_assigned_at")
    op.drop_column("companies", "assigned_ae_code")
    op.drop_table("ae_import_rows")
    op.drop_table("ae_import_batches")
    op.drop_table("ae_reassignment_log")
    op.drop_index("ix_account_executives_ae_code", table_name="account_executives")
    op.drop_table("account_executives")
