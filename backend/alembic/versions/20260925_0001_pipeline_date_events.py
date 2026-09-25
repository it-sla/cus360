"""add pipeline_date_events table to log pushed/vanished/reappeared Expected Dates

Active Pipeline is truncate-and-replace on every sync (pipeline_items has no
history of its own), and pipeline_snapshots only lets you view one day at a
time — neither shows what changed between two syncs. AEs in the old CRM push
a deal's Expected Date out instead of closing it, or a deal simply drops off
the grid (date cleared, pushed past the lookahead window, or deleted). This
table is an append-only log of those changes, one row per detected event.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260925_0001"
down_revision = "20260923_0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pipeline_date_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("event_date", sa.Date(), nullable=False),
        sa.Column("sync_run_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("crm_sync_runs.id"), nullable=True),
        sa.Column("event_type", sa.String(), nullable=False),
        sa.Column("company_name", sa.String(), nullable=False),
        sa.Column("icris_number", sa.String(), nullable=True),
        sa.Column("ae_code", sa.String(), nullable=True),
        sa.Column("country", sa.String(), nullable=True),
        sa.Column("old_expected_date", sa.Date(), nullable=True),
        sa.Column("new_expected_date", sa.Date(), nullable=True),
        sa.Column("days_shifted", sa.Integer(), nullable=True),
        sa.Column("was_overdue", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revenue_usd", sa.Numeric(16, 2), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_pipeline_date_events_event_date", "pipeline_date_events", ["event_date"])
    op.create_index("ix_pipeline_date_events_sync_run_id", "pipeline_date_events", ["sync_run_id"])
    op.create_index("ix_pipeline_date_events_event_type", "pipeline_date_events", ["event_type"])
    op.create_index("ix_pipeline_date_events_company_name", "pipeline_date_events", ["company_name"])
    op.create_index("ix_pipeline_date_events_icris_number", "pipeline_date_events", ["icris_number"])
    op.create_index("ix_pipeline_date_events_ae_code", "pipeline_date_events", ["ae_code"])


def downgrade():
    op.drop_index("ix_pipeline_date_events_ae_code", table_name="pipeline_date_events")
    op.drop_index("ix_pipeline_date_events_icris_number", table_name="pipeline_date_events")
    op.drop_index("ix_pipeline_date_events_company_name", table_name="pipeline_date_events")
    op.drop_index("ix_pipeline_date_events_event_type", table_name="pipeline_date_events")
    op.drop_index("ix_pipeline_date_events_sync_run_id", table_name="pipeline_date_events")
    op.drop_index("ix_pipeline_date_events_event_date", table_name="pipeline_date_events")
    op.drop_table("pipeline_date_events")
