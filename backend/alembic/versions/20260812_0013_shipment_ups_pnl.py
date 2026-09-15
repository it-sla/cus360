"""add per-shipment UPS profit/loss fields and UPS detail provenance on MAWBs

Source: S_MenifestPrevUPS.aspx?ID=<n> ("UNITED PARCEL SERVICE PROFIT AND LOSS (SP Export)"),
a 12-column per-shipment grid whose Total row equals the MAWB-level figures already
stored by the MenifestPreview_UPSProLossTot.aspx sync.
"""

from alembic import op
import sqlalchemy as sa

revision = "20260812_0013"
down_revision = "20260811_0012"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("shipments", sa.Column("pnl_bill_amount", sa.Numeric(18, 2), nullable=True))
    op.add_column("shipments", sa.Column("pnl_ups_discount_percent", sa.Numeric(6, 2), nullable=True))
    op.add_column("shipments", sa.Column("pnl_ups_bill_amount", sa.Numeric(18, 2), nullable=True))
    op.add_column("shipments", sa.Column("pnl_profit_loss", sa.Numeric(18, 2), nullable=True))
    op.add_column("shipments", sa.Column("pnl_bill_number", sa.String(), nullable=True))
    op.add_column("shipments", sa.Column("pnl_synced_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_shipments_pnl_synced_at", "shipments", ["pnl_synced_at"])

    op.add_column("master_air_waybills", sa.Column("ups_crm_record_id", sa.String(), nullable=True))
    op.add_column("master_air_waybills", sa.Column("ups_detail_synced_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_master_air_waybills_ups_crm_record_id", "master_air_waybills", ["ups_crm_record_id"])


def downgrade():
    op.drop_index("ix_master_air_waybills_ups_crm_record_id", table_name="master_air_waybills")
    op.drop_column("master_air_waybills", "ups_detail_synced_at")
    op.drop_column("master_air_waybills", "ups_crm_record_id")

    op.drop_index("ix_shipments_pnl_synced_at", table_name="shipments")
    op.drop_column("shipments", "pnl_synced_at")
    op.drop_column("shipments", "pnl_bill_number")
    op.drop_column("shipments", "pnl_profit_loss")
    op.drop_column("shipments", "pnl_ups_bill_amount")
    op.drop_column("shipments", "pnl_ups_discount_percent")
    op.drop_column("shipments", "pnl_bill_amount")
