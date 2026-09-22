"""add pipeline_snapshots table to archive Active Pipeline history

pipeline_items is truncated and reinserted on every CRM sync (see 20260812_0014),
so past states were previously lost. This table captures the outgoing snapshot
before each truncate, keyed by the date it was archived.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260922_0001"
down_revision = "20260920_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pipeline_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column("sync_run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("crm_sync_runs.id"), nullable=True),
        sa.Column("expected_date", sa.Date(), nullable=False),
        sa.Column("company_name", sa.String(), nullable=False),
        sa.Column("icris_number", sa.String(), nullable=True),
        sa.Column("country", sa.String(), nullable=True),
        sa.Column("weight_kg", sa.Numeric(14, 3), nullable=True),
        sa.Column("revenue_usd", sa.Numeric(16, 2), nullable=True),
        sa.Column("pieces", sa.Integer(), nullable=True),
        sa.Column("category", sa.String(), nullable=True),
        sa.Column("ae_code", sa.String(), nullable=True),
        sa.Column("win_loss", sa.String(), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("source_detail_ref", sa.Text(), nullable=True),
        sa.Column("scraped_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_pipeline_snapshots_snapshot_date", "pipeline_snapshots", ["snapshot_date"])
    op.create_index("ix_pipeline_snapshots_sync_run_id", "pipeline_snapshots", ["sync_run_id"])
    op.create_index("ix_pipeline_snapshots_expected_date", "pipeline_snapshots", ["expected_date"])
    op.create_index("ix_pipeline_snapshots_company_name", "pipeline_snapshots", ["company_name"])
    op.create_index("ix_pipeline_snapshots_icris_number", "pipeline_snapshots", ["icris_number"])
    op.create_index("ix_pipeline_snapshots_category", "pipeline_snapshots", ["category"])
    op.create_index("ix_pipeline_snapshots_ae_code", "pipeline_snapshots", ["ae_code"])
    op.create_index("ix_pipeline_snapshots_win_loss", "pipeline_snapshots", ["win_loss"])


def downgrade():
    op.drop_index("ix_pipeline_snapshots_win_loss", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_ae_code", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_category", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_icris_number", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_company_name", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_expected_date", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_sync_run_id", table_name="pipeline_snapshots")
    op.drop_index("ix_pipeline_snapshots_snapshot_date", table_name="pipeline_snapshots")
    op.drop_table("pipeline_snapshots")
