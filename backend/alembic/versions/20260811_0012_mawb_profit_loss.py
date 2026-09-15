"""add UPS profit/loss fields to master_air_waybills"""

from alembic import op
import sqlalchemy as sa

revision = "20260811_0012"
down_revision = "20260810_0011"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("master_air_waybills", sa.Column("pnl_bill_amount", sa.Numeric(18, 2), nullable=True))
    op.add_column("master_air_waybills", sa.Column("pnl_ups_bill_amount", sa.Numeric(18, 2), nullable=True))
    op.add_column("master_air_waybills", sa.Column("pnl_profit_loss", sa.Numeric(18, 2), nullable=True))
    op.add_column("master_air_waybills", sa.Column("pnl_source_checksum", sa.String(), nullable=True))
    op.add_column("master_air_waybills", sa.Column("pnl_synced_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_master_air_waybills_pnl_source_checksum", "master_air_waybills", ["pnl_source_checksum"])


def downgrade():
    op.drop_index("ix_master_air_waybills_pnl_source_checksum", table_name="master_air_waybills")
    op.drop_column("master_air_waybills", "pnl_synced_at")
    op.drop_column("master_air_waybills", "pnl_source_checksum")
    op.drop_column("master_air_waybills", "pnl_profit_loss")
    op.drop_column("master_air_waybills", "pnl_ups_bill_amount")
    op.drop_column("master_air_waybills", "pnl_bill_amount")
