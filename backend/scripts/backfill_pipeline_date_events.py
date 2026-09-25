"""One-time backfill: rebuild pipeline_date_events from the pipeline_snapshots
already on file (available since 2026-09-22), so the date-change log has history
in it instead of starting empty from the day this feature shipped.

Each sync's archived batch is grouped by its archived_at timestamp (the same
`stamp` value _diff_pipeline's caller stamps every row in that batch with, in
sync_active_pipeline), not by snapshot_date, since more than one sync can land
on the same calendar day and grouping by date alone would blend two distinct
before/after pairs into one. Consecutive batches are diffed with the exact same
_diff_pipeline() used by live syncs; the newest batch is also diffed against the
current pipeline_items table, so the backfill covers right up to "now".

Idempotent: before inserting, an event already on file for the same
(event_date, event_type, company_name, ae_code, old_expected_date,
new_expected_date) is skipped, so running this twice adds nothing new.

Known limit: pipeline_snapshots itself only ever held rows fetched from "today
onward" until crm_pipeline_lookback_days shipped, so a deal that had already
gone overdue before this feature existed reads as 'vanished' here, not as
whatever actually happened to it in the CRM.

Run via:
    docker exec -i customer360-backend-1 python - < backend/scripts/backfill_pipeline_date_events.py
"""
from sqlalchemy import select

from app.crm_sync import _diff_pipeline
from app.db import SessionLocal
from app.models import PipelineDateEvent, PipelineItem, PipelineSnapshot


def as_new_row(item):
    return {'Company Name': item.company_name, 'Acc No': item.icris_number or '', 'Country': item.country or '',
            'expected_date': item.expected_date, 'AE': item.ae_code or '', 'Win/Loss': item.win_loss or '',
            'revenue_usd': item.revenue_usd}


db = SessionLocal()
try:
    batch_stamps = [r[0] for r in db.execute(
        select(PipelineSnapshot.archived_at).distinct().order_by(PipelineSnapshot.archived_at)
    ).all()]
    print(f'{len(batch_stamps)} archived sync batches on file')

    existing = {
        (e.event_date, e.event_type, e.company_name, e.ae_code, e.old_expected_date, e.new_expected_date)
        for e in db.scalars(select(PipelineDateEvent)).all()
    }

    def insert_new(events, event_date, sync_run_id):
        inserted = 0
        for e in events:
            dedupe_key = (event_date, e['event_type'], e['company_name'], e['ae_code'], e['old_expected_date'], e['new_expected_date'])
            if dedupe_key in existing:
                continue
            existing.add(dedupe_key)
            db.add(PipelineDateEvent(event_date=event_date, sync_run_id=sync_run_id, event_type=e['event_type'],
                                      company_name=e['company_name'], icris_number=e['icris_number'], ae_code=e['ae_code'],
                                      country=e['country'], old_expected_date=e['old_expected_date'], new_expected_date=e['new_expected_date'],
                                      days_shifted=e['days_shifted'], was_overdue=e['was_overdue'], revenue_usd=e['revenue_usd']))
            inserted += 1
        return inserted

    total_inserted = 0
    for i in range(len(batch_stamps) - 1):
        older_stamp, newer_stamp = batch_stamps[i], batch_stamps[i + 1]
        older_items = db.scalars(select(PipelineSnapshot).where(PipelineSnapshot.archived_at == older_stamp)).all()
        newer_items = db.scalars(select(PipelineSnapshot).where(PipelineSnapshot.archived_at == newer_stamp)).all()
        newer_run_id = newer_items[0].sync_run_id if newer_items else None
        events = _diff_pipeline(db, older_items, [as_new_row(x) for x in newer_items], newer_stamp.date())
        total_inserted += insert_new(events, newer_stamp.date(), newer_run_id)
        db.flush()

    if batch_stamps:
        from datetime import date
        newest_stamp = batch_stamps[-1]
        newest_items = db.scalars(select(PipelineSnapshot).where(PipelineSnapshot.archived_at == newest_stamp)).all()
        current_items = db.scalars(select(PipelineItem)).all()
        today = date.today()
        events = _diff_pipeline(db, newest_items, [as_new_row(x) for x in current_items], today)
        total_inserted += insert_new(events, today, None)

    db.commit()
    print(f'{total_inserted} new pipeline_date_events inserted ({len(existing) - total_inserted} already on file)')
finally:
    db.close()
