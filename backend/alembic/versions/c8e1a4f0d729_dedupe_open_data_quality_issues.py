"""dedupe open data_quality_issues created by the sync_item_id matching bug

Before this migration, issue() (crm_sync.py) matched existing open issues on
sync_item_id as well as (issue_type, shipment_id, mawb_id). sync_item_id is unique
per sync run, so every re-sync of a still-broken shipment created a brand-new open
row instead of reusing the existing one. crm_invalid_icris ended up with 8,786 open
rows for only 4,381 actually-affected shipments. This is a one-time cleanup of the
data that bug already produced; the matching logic itself is fixed separately in
crm_sync.py.
"""
from typing import Sequence, Union
from alembic import op

revision: str = 'c8e1a4f0d729'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Keep the earliest open row per (issue_type, shipment_id, mawb_id), rolling the
    # group's latest last_seen_at onto it, then delete the rest. NULLs in shipment_id/
    # mawb_id partition together correctly in Postgres window functions.
    op.execute("""
        WITH ranked AS (
            SELECT id, issue_type, shipment_id, mawb_id, last_seen_at,
                   row_number() OVER (PARTITION BY issue_type, shipment_id, mawb_id ORDER BY first_seen_at ASC, id ASC) AS rn
            FROM data_quality_issues
            WHERE status = 'open'
        ),
        latest AS (
            SELECT issue_type, shipment_id, mawb_id, max(last_seen_at) AS max_last_seen_at
            FROM data_quality_issues
            WHERE status = 'open'
            GROUP BY issue_type, shipment_id, mawb_id
        )
        UPDATE data_quality_issues d
        SET last_seen_at = latest.max_last_seen_at
        FROM ranked, latest
        WHERE d.id = ranked.id AND ranked.rn = 1
          AND ranked.issue_type = latest.issue_type
          AND d.shipment_id IS NOT DISTINCT FROM latest.shipment_id
          AND d.mawb_id IS NOT DISTINCT FROM latest.mawb_id
    """)
    op.execute("""
        WITH ranked AS (
            SELECT id, row_number() OVER (PARTITION BY issue_type, shipment_id, mawb_id ORDER BY first_seen_at ASC, id ASC) AS rn
            FROM data_quality_issues
            WHERE status = 'open'
        )
        DELETE FROM data_quality_issues WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    """)


def downgrade() -> None:
    raise RuntimeError('Deleted duplicate rows cannot be reconstructed; this migration is not reversible.')
