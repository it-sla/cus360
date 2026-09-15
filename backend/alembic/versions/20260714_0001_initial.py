"""initial customer 360 schema and analytics views"""
from alembic import op
from app.models import Base
revision="20260714_0001"; down_revision=None; branch_labels=None; depends_on=None
def upgrade():
    Base.metadata.create_all(op.get_bind())
    op.execute("""CREATE VIEW vw_company_operational_summary AS
      SELECT c.id company_id,c.icris_number,c.company_name,c.status company_status,
      count(DISTINCT s.id)::int shipment_count,count(DISTINCT p.id)::int package_count,
      count(DISTINCT s.id) FILTER (WHERE s.match_status='matched')::int matched_shipment_count,
      count(DISTINCT s.id) FILTER (WHERE s.match_status='suggested')::int suggested_shipment_count,
      0::int unmatched_shipment_count,max(s.shipment_date) last_shipment_date,max(s.created_at) last_imported_at,
      count(DISTINCT d.id)::int document_count,count(DISTINCT d.id) FILTER (WHERE d.status='active')::int active_document_count
      FROM companies c LEFT JOIN shipments s ON s.company_id=c.id LEFT JOIN packages p ON p.shipment_id=s.id
      LEFT JOIN company_documents d ON d.company_id=c.id GROUP BY c.id""")
    op.execute("""CREATE VIEW vw_destination_summary AS SELECT import_country,export_country,count(*)::int shipment_count FROM shipments GROUP BY import_country,export_country""")
    op.execute("""CREATE VIEW vw_manifest_import_quality AS SELECT id batch_id,file_name,created_at imported_at,total_rows,shipment_count,package_count,matched_count,suggested_count,unmatched_count,warning_count,failed_count,status FROM manifest_import_batches""")
    op.execute("""CREATE VIEW vw_company_document_summary AS SELECT c.id company_id,c.icris_number,c.company_name,count(d.id)::int document_count,count(d.id) FILTER(WHERE d.status='active')::int active_document_count,count(DISTINCT d.category)::int category_count FROM companies c LEFT JOIN company_documents d ON d.company_id=c.id GROUP BY c.id""")
def downgrade():
    op.execute("DROP VIEW IF EXISTS vw_company_document_summary"); op.execute("DROP VIEW IF EXISTS vw_manifest_import_quality"); op.execute("DROP VIEW IF EXISTS vw_destination_summary"); op.execute("DROP VIEW IF EXISTS vw_company_operational_summary")
    Base.metadata.drop_all(op.get_bind())

