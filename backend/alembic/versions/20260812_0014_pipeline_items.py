"""add pipeline_items table for CRM Active Pipeline scrape

Source: CRM_Activepipeline.aspx detail grid (Expected Date, Company Name, Acc No, Country,
Weight(kg), Revenue($), PCS, Category, AE, Win/Loss, Remarks). This is a whole-table snapshot
of the CRM's current active pipeline, not an append log — sync truncates and reinserts it on
every scrape, so no natural row key is needed.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260812_0014"
down_revision = "20260812_0013"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pipeline_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
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
    )
    op.create_index("ix_pipeline_items_expected_date", "pipeline_items", ["expected_date"])
    op.create_index("ix_pipeline_items_company_name", "pipeline_items", ["company_name"])
    op.create_index("ix_pipeline_items_icris_number", "pipeline_items", ["icris_number"])
    op.create_index("ix_pipeline_items_category", "pipeline_items", ["category"])
    op.create_index("ix_pipeline_items_ae_code", "pipeline_items", ["ae_code"])
    op.create_index("ix_pipeline_items_win_loss", "pipeline_items", ["win_loss"])


def downgrade():
    op.drop_index("ix_pipeline_items_win_loss", table_name="pipeline_items")
    op.drop_index("ix_pipeline_items_ae_code", table_name="pipeline_items")
    op.drop_index("ix_pipeline_items_category", table_name="pipeline_items")
    op.drop_index("ix_pipeline_items_icris_number", table_name="pipeline_items")
    op.drop_index("ix_pipeline_items_company_name", table_name="pipeline_items")
    op.drop_index("ix_pipeline_items_expected_date", table_name="pipeline_items")
    op.drop_table("pipeline_items")
