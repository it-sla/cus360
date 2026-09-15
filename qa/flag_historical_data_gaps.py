"""One-time backfill: raise DataQualityIssue rows for two historical gaps documented in
docs/03-data-rules.md and docs/10-known-issues.md M-10. Additive only -- creates issue
rows against `master_air_waybills`, never modifies shipment or MAWB data. Idempotent:
skips any MAWB that already has an open/acknowledged issue of the relevant type.

1. crm_mawb_footer_unshipped -- a MAWB whose manifest footer (pp/fc/fd_bill_amount) totals
   more than zero but has zero ingested shipment rows. Revenue booked at the CRM never
   made it into Customer 360 for this MAWB (docs/03-data-rules.md rule 6b, "Remaining known
   gap"). ~9 MAWBs / $32,340.50 as of 2026-08-07 -- flagged for review, not corrected here,
   since the root cause (why ingestion skipped these) needs a decision (qa/OPEN-QUESTIONS.md Q13).

2. crm_corrupted_mawb_geo -- a MAWB whose destination/origin matches the parser-corruption
   heuristic added for M-10 (crm_parser.py:177-181): a leaked field label, the literal
   'Total'/'SN', a bare number, or a non-alphanumeric lead character. 52 such MAWBs as of
   2026-08-06, some carrying real revenue (MAWB 277: 73 shipments, $23,590.53) that Geography
   Analytics currently attributes to a garbage destination string. Per owner decision, these
   are flagged for manual review rather than nulled out -- the value stays in place.

    DRY RUN (default):  docker exec -i customer360-backend-1 python - < qa/flag_historical_data_gaps.py
    COMMIT:              docker exec -i -e COMMIT=1 customer360-backend-1 python - < qa/flag_historical_data_gaps.py
"""
import os

from sqlalchemy import text, select, or_
from app.db import SessionLocal
from app.models import DataQualityIssue, MasterAirWaybill

COMMIT = os.environ.get('COMMIT') == '1'
UNSHIPPED_ISSUE_TYPE = 'crm_mawb_footer_unshipped'
CORRUPTED_GEO_ISSUE_TYPE = 'crm_corrupted_mawb_geo'

# Exact match to crm_parser.py:177-181's leaked-label heuristic, kept independent of that
# module (this is a one-off historical scan, not a live parsing path) but must stay in sync
# if that heuristic ever changes.
_LEAKED_LABEL_PREFIXES = ('exchange rate:', 'flight no:', 'fuel surch', 'from:', 'to:', 'date:', 'mawb:')


def _looks_corrupted(value):
    v = (value or '').strip()
    if not v:
        return False
    cf = v.casefold()
    return cf.startswith(_LEAKED_LABEL_PREFIXES) or cf in {'total', 'sn'} or v.isdigit() or not v[0].isalnum()


db = SessionLocal()
try:
    already_unshipped = {
        i.mawb_id for i in db.scalars(
            select(DataQualityIssue).where(
                DataQualityIssue.issue_type == UNSHIPPED_ISSUE_TYPE,
                DataQualityIssue.status.in_(('open', 'acknowledged')),
            )
        ).all()
    }
    already_corrupted = {
        i.mawb_id for i in db.scalars(
            select(DataQualityIssue).where(
                DataQualityIssue.issue_type == CORRUPTED_GEO_ISSUE_TYPE,
                DataQualityIssue.status.in_(('open', 'acknowledged')),
            )
        ).all()
    }

    # ---- Gap 1: footer total > 0, zero ingested shipments
    unshipped_rows = db.execute(text("""
        SELECT m.id, m.mawb_number, m.manifest_date,
               coalesce(m.pp_bill_amount,0)+coalesce(m.fc_bill_amount,0)+coalesce(m.fd_bill_amount,0) AS footer_total
        FROM master_air_waybills m
        WHERE (coalesce(m.pp_bill_amount,0)+coalesce(m.fc_bill_amount,0)+coalesce(m.fd_bill_amount,0)) > 0
          AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.mawb_id = m.id)
    """)).mappings().all()
    unshipped_todo = [r for r in unshipped_rows if r['id'] not in already_unshipped]

    # ---- Gap 2: corrupted destination/origin
    all_mawbs = db.scalars(select(MasterAirWaybill)).all()
    corrupted_todo = [
        m for m in all_mawbs
        if m.id not in already_corrupted and (_looks_corrupted(m.destination) or _looks_corrupted(m.origin))
    ]

    print(f"Gap 1 -- MAWBs with footer total but zero shipments : {len(unshipped_rows)}")
    print(f"         already flagged (open/ack)                 : {len(unshipped_rows) - len(unshipped_todo)}")
    print(f"         new issues to create                       : {len(unshipped_todo)}")
    print(f"         total footer revenue never ingested        : {round(sum(float(r['footer_total']) for r in unshipped_todo), 2)}")
    print()
    print(f"Gap 2 -- MAWBs with corrupted destination/origin     : {len(all_mawbs) and sum(1 for m in all_mawbs if _looks_corrupted(m.destination) or _looks_corrupted(m.origin))}")
    print(f"         already flagged (open/ack)                 : {len(already_corrupted)}")
    print(f"         new issues to create                       : {len(corrupted_todo)}")

    if COMMIT:
        for r in unshipped_todo:
            db.add(DataQualityIssue(
                issue_type=UNSHIPPED_ISSUE_TYPE, severity='warning', mawb_id=r['id'],
                details_json={
                    'mawb_number': r['mawb_number'], 'manifest_date': str(r['manifest_date']),
                    'footer_total': str(r['footer_total']),
                    'reason': 'CRM manifest footer (pp/fc/fd_bill_amount) totals nonzero but no shipment rows were ingested for this MAWB -- revenue booked at the source was never brought in.',
                },
            ))
        for m in corrupted_todo:
            db.add(DataQualityIssue(
                issue_type=CORRUPTED_GEO_ISSUE_TYPE, severity='warning', mawb_id=m.id,
                details_json={
                    'mawb_number': m.mawb_number, 'destination': m.destination, 'origin': m.origin,
                    'reason': 'destination/origin matches the M-10 parser-corruption heuristic (leaked field label, "Total"/"SN", a bare number, or non-alphanumeric lead char) -- not a real airport/country code. Flagged for manual review; value left in place per owner decision.',
                },
            ))
        db.commit()
        print(f"\nCOMMITTED: {len(unshipped_todo)} + {len(corrupted_todo)} issues created.")
    else:
        print("\nDRY RUN -- nothing written. Re-run with COMMIT=1 to apply.")
finally:
    db.close()
