"""add ae_targets table for AE monthly targets (import + manual setup)

Source for the initial load: AE_Targets_2026.xlsx, 'All_AE_Flat' sheet (Year, AE, MONTH,
Weight, Piece, Revenue, Weight_Imp, Piece_Imp, Revenue_Imp). One row per (ae_code, year,
month); export and import targets are kept in separate columns per docs/03-data-rules.md's
"PP/FC/FD totals stay separate" spirit — never aggregate distinct measures together.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260812_0015"
down_revision = "20260812_0014"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "ae_targets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ae_code", sa.String(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("weight_target", sa.Numeric(14, 3), nullable=True),
        sa.Column("piece_target", sa.Integer(), nullable=True),
        sa.Column("revenue_target", sa.Numeric(16, 2), nullable=True),
        sa.Column("weight_target_import", sa.Numeric(14, 3), nullable=True),
        sa.Column("piece_target_import", sa.Integer(), nullable=True),
        sa.Column("revenue_target_import", sa.Numeric(16, 2), nullable=True),
        sa.Column("source", sa.String(), nullable=False, server_default="manual"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.UniqueConstraint("ae_code", "year", "month", name="uq_ae_target_period"),
    )
    op.create_index("ix_ae_targets_ae_code", "ae_targets", ["ae_code"])
    op.create_index("ix_ae_targets_year", "ae_targets", ["year"])


def downgrade():
    op.drop_index("ix_ae_targets_year", table_name="ae_targets")
    op.drop_index("ix_ae_targets_ae_code", table_name="ae_targets")
    op.drop_table("ae_targets")
