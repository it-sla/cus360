"""One-time backfill: apply the blank-Pay-Term inference to shipments that were synced
before `crm_sync.upsert_detail` started inferring it (see docs/03-data-rules.md §6b).

Rule: blank Pay Term + a bill amount on the row means it was billed prepaid -> PP.
Blank Pay Term + no bill amount means it was never billed -> FC (bills $0 either way).

Skips any shipment with a manual override on pay_term. Additive/update only — sets
`pay_term` and tags provenance as `crm_inferred`; does not touch any other field.

    DRY RUN (default):  docker exec -i customer360-backend-1 python - < qa/backfill_infer_pay_term.py
    COMMIT:             docker exec -i -e COMMIT=1 customer360-backend-1 python - < qa/backfill_infer_pay_term.py
"""
import os

from sqlalchemy import select, or_
from app.db import SessionLocal
from app.models import Shipment, now

COMMIT = os.environ.get('COMMIT') == '1'

db = SessionLocal()
try:
    targets = db.scalars(
        select(Shipment).where(or_(Shipment.pay_term.is_(None), Shipment.pay_term == ''))
    ).all()

    todo = [s for s in targets if 'pay_term' not in (s.manual_override_fields or [])]
    skipped_manual = len(targets) - len(todo)

    pp = [s for s in todo if s.bill_amount]
    fc = [s for s in todo if not s.bill_amount]
    revenue_added = sum(float(s.bill_amount or 0) for s in pp)

    print(f'shipments with blank pay term      : {len(targets)}')
    print(f'skipped (manual pay_term override) : {skipped_manual}')
    print(f'inferred as PP (has bill amount)   : {len(pp)}  (+${revenue_added:,.2f} revenue)')
    print(f'inferred as FC (no bill amount)    : {len(fc)}')

    for s in todo:
        provenance = dict(s.crm_field_provenance or {})
        provenance['pay_term'] = {'source': 'crm_inferred', 'manifest_id': s.crm_manifest_id, 'updated_at': now().isoformat()}
        s.pay_term = 'PP' if s.bill_amount else 'FC'
        s.crm_field_provenance = provenance

    if COMMIT:
        db.commit()
        print(f'\nCOMMITTED — {len(todo)} shipments updated.')
    else:
        db.rollback()
        print('\nDRY RUN — nothing written. Re-run with COMMIT=1 to apply.')
finally:
    db.close()
