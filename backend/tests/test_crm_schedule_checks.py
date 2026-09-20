from datetime import date,datetime,timedelta,timezone
import uuid
import pytest
from sqlalchemy import select
from app.core import settings
from app.crm_worker import check_auto_schedule,check_reconcile_schedule
from app.db import SessionLocal
from app.models import CrmSyncRun,CrmSyncState

def _clear_state(db,*entity_types):
    for entity_type in entity_types:
        existing=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type==entity_type))
        if existing:db.delete(existing)
    db.commit()

def _clear_active_runs(db):
    # check_auto_schedule/check_reconcile_schedule both bail out while any run is
    # queued/discovering/running — other test files can leave runs in that state in
    # this shared test DB, so isolate our schedule-check tests from that leftover state.
    for run in db.scalars(select(CrmSyncRun).where(CrmSyncRun.status.in_({'queued','discovering','running'}))).all():
        run.status='cancelled'
    db.commit()

def test_auto_schedule_catches_up_when_watermark_is_stale(monkeypatch):
    db=SessionLocal()
    try:
        _clear_state(db,'auto_schedule','watermark:both');_clear_active_runs(db)
        watermark=CrmSyncState(entity_type='watermark:both',last_successful_date=date.today()-timedelta(days=5),last_successful_sync_at=datetime.now(timezone.utc)-timedelta(hours=48));db.add(watermark);db.commit()
        monkeypatch.setattr(settings,'crm_schedule_enabled',True);monkeypatch.setattr(settings,'crm_schedule_cron','0 0 30 2 *')  # cron never matches on its own
        check_auto_schedule()
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='auto_schedule'))
        assert state and state.cursor_json.get('run_id')
        run=db.get(CrmSyncRun,uuid.UUID(state.cursor_json['run_id']))
        assert run is not None and run.sync_type=='incremental_update'
    finally:db.close()

def test_auto_schedule_skips_when_fresh_and_cron_does_not_match(monkeypatch):
    db=SessionLocal()
    try:
        _clear_state(db,'auto_schedule','watermark:both');_clear_active_runs(db)
        watermark=CrmSyncState(entity_type='watermark:both',last_successful_date=date.today(),last_successful_sync_at=datetime.now(timezone.utc));db.add(watermark);db.commit()
        monkeypatch.setattr(settings,'crm_schedule_enabled',True);monkeypatch.setattr(settings,'crm_schedule_cron','0 0 30 2 *')
        before=db.scalar(select(CrmSyncRun.id).order_by(CrmSyncRun.created_at.desc()))
        check_auto_schedule()
        after=db.scalar(select(CrmSyncRun.id).order_by(CrmSyncRun.created_at.desc()))
        assert before==after
        assert db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='auto_schedule')) is None
    finally:db.close()

def test_auto_schedule_failure_is_caught_rolled_back_and_does_not_crash(monkeypatch):
    db=SessionLocal()
    try:
        _clear_state(db,'auto_schedule','watermark:both');_clear_active_runs(db)
        watermark=CrmSyncState(entity_type='watermark:both',last_successful_date=date.today()-timedelta(days=5),last_successful_sync_at=datetime.now(timezone.utc)-timedelta(hours=48));db.add(watermark);db.commit()
        monkeypatch.setattr(settings,'crm_schedule_enabled',True);monkeypatch.setattr(settings,'crm_schedule_cron','0 0 30 2 *')
        def boom(*a,**k):raise RuntimeError('simulated CRM failure')
        monkeypatch.setattr('app.crm_worker.create_incremental',boom)
        check_auto_schedule()  # must not raise
        assert db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='auto_schedule')) is None
    finally:db.close()

def test_reconcile_schedule_creates_wide_window_run_and_dedupes_by_hour(monkeypatch):
    db=SessionLocal()
    try:
        _clear_state(db,'reconcile_schedule');_clear_active_runs(db)
        monkeypatch.setattr(settings,'crm_schedule_enabled',True);monkeypatch.setattr(settings,'crm_reconcile_cron','* * * * *')
        check_reconcile_schedule()
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='reconcile_schedule'))
        assert state and state.cursor_json.get('run_id')
        run=db.get(CrmSyncRun,uuid.UUID(state.cursor_json['run_id']))
        assert run is not None
        assert (run.requested_to_date-run.requested_from_date).days>=settings.crm_reconcile_window_days-1
        check_reconcile_schedule()  # within the hour: must not create a second run
        db.refresh(state)
        assert state.cursor_json.get('run_id')==str(run.id)
    finally:db.close()

def test_reconcile_schedule_failure_is_caught_and_does_not_crash(monkeypatch):
    db=SessionLocal()
    try:
        _clear_state(db,'reconcile_schedule');_clear_active_runs(db)
        monkeypatch.setattr(settings,'crm_schedule_enabled',True);monkeypatch.setattr(settings,'crm_reconcile_cron','* * * * *')
        def boom(*a,**k):raise RuntimeError('simulated CRM failure')
        monkeypatch.setattr('app.crm_worker.create_incremental',boom)
        check_reconcile_schedule()  # must not raise
        assert db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='reconcile_schedule')) is None
    finally:db.close()
