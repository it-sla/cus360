"""backfill crm_missing_bill_type issues for shipments blank before this type existed

crm_sync.py now flags a shipment whose Bill Type is blank (can't classify as Document
vs Non-Document, so it falls into the 'unclassified' bucket on /analytics/document-type).
Shipments already blank before this detection existed have no issue row and would only
get one on their next CRM re-sync, which may never happen for older records. This
backfills them once.
"""
from typing import Sequence, Union
from alembic import op

revision: str = 'd3f6b8a1c452'
down_revision: Union[str, None] = 'c8e1a4f0d729'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO data_quality_issues (id, issue_type, severity, shipment_id, mawb_id, details_json, status, first_seen_at, last_seen_at, created_at, updated_at)
        SELECT gen_random_uuid(), 'crm_missing_bill_type', 'warning', s.id, s.mawb_id,
               jsonb_build_object('tracking_number', s.shipment_number, 'reason', 'CRM Bill Type is blank — cannot classify as Document or Non-Document; counted in the unclassified bucket on document-type analytics'),
               'open', now(), now(), now(), now()
        FROM shipments s
        WHERE (s.bill_type IS NULL OR btrim(s.bill_type) = '')
          AND NOT EXISTS (
              SELECT 1 FROM data_quality_issues i
              WHERE i.issue_type = 'crm_missing_bill_type' AND i.shipment_id = s.id AND i.status = 'open'
          )
    """)


def downgrade() -> None:
    op.execute("DELETE FROM data_quality_issues WHERE issue_type = 'crm_missing_bill_type'")
