from pathlib import Path
from datetime import date, timedelta
from decimal import Decimal
import uuid
import pytest
from sqlalchemy import func, select
from app.crm_sync import sync_active_pipeline, run_active_pipeline_sync
from app.crm_connector import SessionExpired
from app.crm_parser import CrmParseError
from app.db import SessionLocal
from app.models import CrmSyncRun, DataQualityIssue, PipelineDateEvent, PipelineItem, User

FIX = Path(__file__).parent / 'fixtures'

TODAY = date.today()
OVERDUE = TODAY - timedelta(days=5)
PUSHED = TODAY + timedelta(days=3)
NOT_YET_OVERDUE = TODAY + timedelta(days=10)
PUSHED_FURTHER = TODAY + timedelta(days=20)

def date_events_for(db, company_name):
    return db.scalars(select(PipelineDateEvent).where(PipelineDateEvent.company_name == company_name).order_by(PipelineDateEvent.id)).all()

def row(company_name, expected_date, ae='AS', country='US', win_loss='', revenue=None, icris=''):
    return {
        'expected_date': expected_date, 'Company Name': company_name, 'Acc No': icris, 'Country': country,
        'weight_kg': Decimal('10'), 'revenue_usd': revenue, 'pieces': 1, 'Category': 'SME', 'AE': ae,
        'Win/Loss': win_loss, 'Remarks': '', 'detail_ref': None,
    }

PIPELINE_HEADER_ROW = '<tr><td>S.no.</td><td>Expected Date</td><td>Company Name</td><td>Acc No</td><td>Country</td><td>Weight(kg)</td><td>Revenue($)</td><td>PCS</td><td>Category</td><td>AE</td><td>Win/Loss</td><td>Remarks</td></tr>'
def pipeline_html(n):
    """Builds valid Active Pipeline grid HTML with n data rows, same shape as
    test_parse_active_pipeline_list in test_crm_parser.py."""
    rows = ''.join(
        f'<tr><td>{i+1}</td><td>{(TODAY + timedelta(days=i+1)).strftime("%m/%d/%Y")}</td>'
        f'<td>Snapshot Co {i}</td><td></td><td>US</td><td>10</td><td>100</td><td>1</td>'
        f'<td>SME</td><td>AS</td><td></td><td></td></tr>'
        for i in range(n)
    )
    return f'<table>{PIPELINE_HEADER_ROW}{rows}</table>'

def test_date_push_without_resolution_is_flagged():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed').delete()
        sync_active_pipeline(db, [row('Push Test Co', OVERDUE, revenue=Decimal('5000'))])
        db.flush()
        stats = sync_active_pipeline(db, [row('Push Test Co', PUSHED, revenue=Decimal('5000'))])
        db.flush()
        assert stats['date_pushed_count'] == 1
        issue = db.scalar(select(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed', DataQualityIssue.source_company_name == 'Push Test Co'))
        assert issue is not None
        assert issue.severity == 'high'  # revenue > 1000
        assert issue.details_json['old_expected_date'] == OVERDUE.isoformat()
        assert issue.details_json['new_expected_date'] == PUSHED.isoformat()
    finally:
        db.rollback(); db.close()

def test_actually_resolved_deal_is_not_flagged_as_pushed():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed').delete()
        sync_active_pipeline(db, [row('Resolved Co', OVERDUE)])
        db.flush()
        stats = sync_active_pipeline(db, [row('Resolved Co', PUSHED, win_loss='Win')])
        assert stats['date_pushed_count'] == 0
    finally:
        db.rollback(); db.close()

def test_still_overdue_same_date_is_not_flagged():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed').delete()
        sync_active_pipeline(db, [row('Same Date Co', OVERDUE)])
        db.flush()
        stats = sync_active_pipeline(db, [row('Same Date Co', OVERDUE)])
        assert stats['date_pushed_count'] == 0
    finally:
        db.rollback(); db.close()

def test_ambiguous_duplicate_key_is_skipped():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed').delete()
        # Two old rows share the same (company, ae, country) key — ambiguous, must not guess.
        sync_active_pipeline(db, [row('Dup Co', OVERDUE), row('Dup Co', OVERDUE - timedelta(days=1))])
        db.flush()
        stats = sync_active_pipeline(db, [row('Dup Co', PUSHED)])
        assert stats['date_pushed_count'] == 0
    finally:
        db.rollback(); db.close()

def test_empty_snapshot_does_not_wipe_existing_pipeline():
    # A scrape that parses to zero rows (broken/timed-out page) must not truncate a
    # populated pipeline — it should skip and retain the existing rows.
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        sync_active_pipeline(db, [row('Keep Co', OVERDUE), row('Keep Co 2', PUSHED)])
        db.flush()
        stats = sync_active_pipeline(db, [])
        assert stats.get('skipped_empty') is True
        assert stats['retained_rows'] == 2
        assert db.scalar(select(PipelineItem).where(PipelineItem.company_name == 'Keep Co')) is not None
    finally:
        db.rollback(); db.close()

def test_empty_snapshot_into_empty_table_is_a_clean_noop():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.flush()
        stats = sync_active_pipeline(db, [])
        assert not stats.get('skipped_empty')
        assert stats['total_rows'] == 0
    finally:
        db.rollback(); db.close()

def test_new_deal_never_seen_before_is_not_flagged():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        stats = sync_active_pipeline(db, [row('Brand New Co', PUSHED)])
        assert stats['date_pushed_count'] == 0
    finally:
        db.rollback(); db.close()

def test_run_active_pipeline_sync_creates_completed_run_with_row_count():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.flush()
        run = run_active_pipeline_sync(db, pipeline_html(3), 'http://crm.example/pipeline')
        db.flush()
        assert run.sync_type == 'pipeline'
        assert run.status == 'completed'
        assert run.shipments_found == 3
        assert db.get(CrmSyncRun, run.id) is not None
    finally:
        db.rollback(); db.close()

def test_run_active_pipeline_sync_detects_login_page_and_retains_existing_rows():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        sync_active_pipeline(db, [row('Kept Alive Co', PUSHED)])
        db.flush()
        login_html = (FIX / 'crm_login.html').read_text()
        with pytest.raises(SessionExpired):
            run_active_pipeline_sync(db, login_html, 'http://crm.example/pipeline')
        db.flush()
        # Existing pipeline data must be untouched by a session-expired fetch.
        assert db.scalar(select(PipelineItem).where(PipelineItem.company_name == 'Kept Alive Co')) is not None
        failed_run = db.scalar(select(CrmSyncRun).where(CrmSyncRun.sync_type == 'pipeline', CrmSyncRun.status == 'failed').order_by(CrmSyncRun.created_at.desc()))
        assert failed_run is not None
        assert 'session expired' in failed_run.error_message.lower()
    finally:
        db.rollback(); db.close()

def test_run_active_pipeline_sync_refuses_suspicious_row_collapse():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        sync_active_pipeline(db, [row(f'Prior Co {i}', PUSHED) for i in range(10)])
        db.flush()
        # 2 rows vs 10 on file is well under the 40% collapse threshold — looks like a
        # partially-rendered page, not a genuine pipeline shrink.
        run = run_active_pipeline_sync(db, pipeline_html(2), 'http://crm.example/pipeline')
        db.flush()
        assert run.status == 'completed_with_errors'
        assert 'suspicious snapshot' in run.error_message
        assert db.scalar(select(func.count()).select_from(PipelineItem)) == 10
    finally:
        db.rollback(); db.close()

def test_run_active_pipeline_sync_allows_normal_sized_snapshot_after_populated_table():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        sync_active_pipeline(db, [row(f'Prior Co {i}', PUSHED) for i in range(10)])
        db.flush()
        # 8 of 10 (80%) is a normal day-to-day fluctuation, not a collapse — must go through.
        run = run_active_pipeline_sync(db, pipeline_html(8), 'http://crm.example/pipeline')
        db.flush()
        assert run.status == 'completed'
        assert db.scalar(select(func.count()).select_from(PipelineItem)) == 8
    finally:
        db.rollback(); db.close()

def test_date_event_pushed_not_yet_overdue():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Early Push Co').delete()
        sync_active_pipeline(db, [row('Early Push Co', NOT_YET_OVERDUE, revenue=Decimal('500'))])
        db.flush()
        sync_active_pipeline(db, [row('Early Push Co', PUSHED_FURTHER, revenue=Decimal('500'))])
        db.flush()
        events = date_events_for(db, 'Early Push Co')
        assert len(events) == 1
        assert events[0].event_type == 'pushed'
        assert events[0].was_overdue is False
        assert events[0].days_shifted == (PUSHED_FURTHER - NOT_YET_OVERDUE).days
    finally:
        db.rollback(); db.close()

def test_date_event_pushed_while_overdue_keeps_dataqualityissue():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete()
        db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Overdue Push Co').delete()
        db.query(DataQualityIssue).where(DataQualityIssue.source_company_name == 'Overdue Push Co').delete()
        sync_active_pipeline(db, [row('Overdue Push Co', OVERDUE, revenue=Decimal('5000'))])
        db.flush()
        sync_active_pipeline(db, [row('Overdue Push Co', PUSHED, revenue=Decimal('5000'))])
        db.flush()
        events = date_events_for(db, 'Overdue Push Co')
        assert len(events) == 1
        assert events[0].event_type == 'pushed'
        assert events[0].was_overdue is True
        # the original pipeline_date_pushed alert/DataQualityIssue must still fire alongside the log
        assert db.scalar(select(DataQualityIssue).where(DataQualityIssue.issue_type == 'pipeline_date_pushed', DataQualityIssue.source_company_name == 'Overdue Push Co')) is not None
    finally:
        db.rollback(); db.close()

def test_date_event_vanished_when_dropped_unresolved():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Vanish Co').delete()
        sync_active_pipeline(db, [row('Vanish Co', PUSHED)])
        db.flush()
        sync_active_pipeline(db, [row('Someone Else Co', PUSHED)])
        db.flush()
        events = date_events_for(db, 'Vanish Co')
        assert len(events) == 1
        assert events[0].event_type == 'vanished'
        assert events[0].old_expected_date == PUSHED
        assert events[0].new_expected_date is None
    finally:
        db.rollback(); db.close()

def test_date_event_not_logged_when_resolved_deal_drops_out():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Closed Deal Co').delete()
        sync_active_pipeline(db, [row('Closed Deal Co', PUSHED, win_loss='Win')])
        db.flush()
        sync_active_pipeline(db, [row('Someone Else Co', PUSHED)])
        db.flush()
        assert date_events_for(db, 'Closed Deal Co') == []
    finally:
        db.rollback(); db.close()

def test_date_event_reappeared_links_to_prior_vanished():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Comeback Co').delete()
        sync_active_pipeline(db, [row('Comeback Co', PUSHED)])
        db.flush()
        sync_active_pipeline(db, [row('Someone Else Co', PUSHED)])  # Comeback Co vanishes here
        db.flush()
        sync_active_pipeline(db, [row('Comeback Co', PUSHED_FURTHER), row('Someone Else Co', PUSHED)])
        db.flush()
        events = date_events_for(db, 'Comeback Co')
        assert [e.event_type for e in events] == ['vanished', 'reappeared']
        reappeared = events[1]
        assert reappeared.old_expected_date == PUSHED
        assert reappeared.new_expected_date == PUSHED_FURTHER
    finally:
        db.rollback(); db.close()

def test_date_event_ambiguous_key_is_skipped():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).where(PipelineDateEvent.company_name == 'Dup Event Co').delete()
        sync_active_pipeline(db, [row('Dup Event Co', OVERDUE), row('Dup Event Co', OVERDUE - timedelta(days=1))])
        db.flush()
        sync_active_pipeline(db, [row('Dup Event Co', PUSHED)])
        db.flush()
        assert date_events_for(db, 'Dup Event Co') == []
    finally:
        db.rollback(); db.close()

def test_date_events_not_written_on_collapsed_or_empty_snapshot():
    db = SessionLocal()
    try:
        db.query(PipelineItem).delete(); db.query(PipelineDateEvent).delete()
        sync_active_pipeline(db, [row(f'Collapse Co {i}', PUSHED) for i in range(10)])
        db.flush()
        before = db.scalar(select(func.count()).select_from(PipelineDateEvent))
        run_active_pipeline_sync(db, pipeline_html(2), 'http://crm.example/pipeline')  # 2 of 10 -> refused as suspicious collapse
        db.flush()
        stats = sync_active_pipeline(db, [])  # empty snapshot -> skipped, existing rows retained
        assert stats.get('skipped_empty') is True
        after = db.scalar(select(func.count()).select_from(PipelineDateEvent))
        assert after == before
    finally:
        db.rollback(); db.close()

def _login_as(role):
    from fastapi.testclient import TestClient
    from app.auth import hash_password
    from app.main import app
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    email = f'pipeline-role-{role}-{tag.lower()}@customer360.test'
    try:
        db.add(User(email=email, display_name=f'Role {role}', role=role, password_hash=hash_password('test-password-not-real'), is_active=True))
        db.commit()
    finally:
        db.close()
    c = TestClient(app)
    res = c.post('/api/v1/auth/login', json={'email': email, 'password': 'test-password-not-real'})
    assert res.status_code == 200
    return c, email

def _forget(email):
    db = SessionLocal()
    try:
        db.query(User).filter(User.email == email).delete()
        db.commit()
    finally:
        db.close()

@pytest.mark.parametrize('role,expected', [
    ('super_admin', 200), ('admin', 200), ('sales_lead', 200), ('ae', 403), ('user', 403),
])
def test_pipeline_date_events_role_boundary(role, expected):
    c, email = _login_as(role)
    try:
        res = c.get('/api/v1/pipeline/date-events')
        assert res.status_code == expected
    finally:
        _forget(email)

@pytest.mark.parametrize('role,expected', [
    ('super_admin', 200), ('admin', 200), ('sales_lead', 200), ('ae', 403), ('user', 403),
])
def test_pipeline_history_role_boundary(role, expected):
    c, email = _login_as(role)
    try:
        res = c.get('/api/v1/pipeline/history')
        assert res.status_code == expected
    finally:
        _forget(email)

def test_run_active_pipeline_sync_bad_structure_marks_run_failed():
    db = SessionLocal()
    try:
        with pytest.raises(CrmParseError):
            run_active_pipeline_sync(db, '<html><body>not a pipeline page</body></html>', 'http://crm.example/pipeline')
        db.flush()
        failed_run = db.scalar(select(CrmSyncRun).where(CrmSyncRun.sync_type == 'pipeline', CrmSyncRun.status == 'failed').order_by(CrmSyncRun.created_at.desc()))
        assert failed_run is not None
    finally:
        db.rollback(); db.close()
