"""One-time backfill: raise a `crm_missing_pay_term` DataQualityIssue for every existing
shipment whose CRM Pay Term is blank.

Going forward these are flagged at sync time (crm_sync.upsert_detail). This covers the
rows that were already imported before that check existed.

Pay Term drives the revenue basis (PP/FD/FC billable; NON_REV/RTS not), so a blank term
means the row's revenue classification is unknown.

Idempotent: skips any shipment that already has an open/acknowledged issue of this type.
Additive only — creates issue rows, never modifies or deletes shipment data.

    DRY RUN (default):  docker exec -i customer360-backend-1 python - < qa/backfill_missing_pay_term_issues.py
    COMMIT:             docker exec -i -e COMMIT=1 customer360-backend-1 python - < qa/backfill_missing_pay_term_issues.py
"""
import os

from sqlalchemy import select, or_
from app.db import SessionLocal
from app.models import DataQualityIssue, Shipment

COMMIT = os.environ.get('COMMIT') == '1'
ISSUE_TYPE = 'crm_missing_pay_term'

db = SessionLocal()
try:
    targets = db.scalars(
        select(Shipment).where(or_(Shipment.pay_term.is_(None), Shipment.pay_term == ''))
    ).all()

    already = {
        i.shipment_id for i in db.scalars(
            select(DataQualityIssue).where(
                DataQualityIssue.issue_type == ISSUE_TYPE,
                DataQualityIssue.status.in_(('open', 'acknowledged')),
            )
        ).all()
    }

    todo = [s for s in targets if s.id not in already]
    revenue = sum(float(s.bill_amount or 0) for s in todo)

    print(f'shipments with blank pay term : {len(targets)}')
    print(f'already flagged (open/ack)    : {len(targets) - len(todo)}')
    print(f'issues to create              : {len(todo)}')
    print(f'revenue currently unclassified: {revenue:,.2f}')

    for s in todo:
        db.add(DataQualityIssue(
            issue_type=ISSUE_TYPE,
            severity='warning',
            shipment_id=s.id,
            company_id=s.company_id,
            mawb_id=s.mawb_id,
            source_icris_number=s.source_icris_number,
            source_company_name=s.source_customer_name,
            details_json={
                'tracking_number': s.shipment_number,
                'bill_amount': str(s.bill_amount or 0),
                'shipment_date': str(s.shipment_date) if s.shipment_date else None,
                'reason': 'CRM Pay Term is blank; revenue classification is unknown',
                'source': 'one-time backfill',
            },
            status='open',
        ))

    if COMMIT:
        db.commit()
        print(f'\nCOMMITTED — {len(todo)} issues created.')
    else:
        db.rollback()
        print('\nDRY RUN — nothing written. Re-run with COMMIT=1 to apply.')
finally:
    db.close()
