from datetime import date, timedelta
from decimal import Decimal
import uuid

from app.db import SessionLocal
from app.models import Company, DataQualityIssue, Shipment


def _seed_icris_issue(db, issue_type, shipment_date, bill_amount=Decimal('100'), pay_term='PP', company_id=None):
    tag = uuid.uuid4().hex[:10].upper()
    s = Shipment(shipment_number=f'DQ-{tag}', source='crm', pay_term=pay_term,
                 bill_amount=bill_amount, shipment_date=shipment_date, match_status='icris_missing',
                 company_id=company_id)
    db.add(s)
    db.flush()
    issue = DataQualityIssue(issue_type=issue_type, severity='warning', status='open',
                              shipment_id=s.id, source_company_name='Test Co', details_json={'reason': 'test'})
    db.add(issue)
    db.flush()
    return s, issue


def test_buffer_applies_to_both_blank_and_invalid_icris(client):
    """The 30-day buffer must cover crm_invalid_icris too, not just crm_blank_icris —
    that's the whole point of unifying the two under one accounting-buffer rule."""
    db = SessionLocal()
    try:
        _s1, blank_issue = _seed_icris_issue(db, 'crm_blank_icris', date.today() - timedelta(days=90), bill_amount=Decimal('111'))
        _s2, invalid_issue = _seed_icris_issue(db, 'crm_invalid_icris', date.today() - timedelta(days=90), bill_amount=Decimal('222'))
        db.commit()

        res = client.get('/api/v1/data-quality/issues', params={'icris_buffer_state': 'stuck', 'limit': 500})
        assert res.status_code == 200
        ids = {i['id']: i for i in res.json()['items']}
        assert str(blank_issue.id) in ids and ids[str(blank_issue.id)]['icris_buffer_state'] == 'stuck'
        assert str(invalid_issue.id) in ids and ids[str(invalid_issue.id)]['icris_buffer_state'] == 'stuck'
    finally:
        db.rollback()
        db.close()


def test_recent_icris_issue_is_pending_not_stuck(client):
    db = SessionLocal()
    try:
        _s, issue = _seed_icris_issue(db, 'crm_invalid_icris', date.today() - timedelta(days=5))
        db.commit()

        res = client.get('/api/v1/data-quality/issues', params={'icris_buffer_state': 'pending', 'limit': 500})
        ids = {i['id'] for i in res.json()['items']}
        assert str(issue.id) in ids
    finally:
        db.rollback()
        db.close()


def test_icris_not_in_master_is_excluded_from_the_buffer(client):
    """crm_icris_not_in_master is a different situation entirely (waiting on a
    company-master import, not accounting) — it must never appear under icris_buffer_state
    filtering even if the underlying shipment is old."""
    db = SessionLocal()
    try:
        _s, issue = _seed_icris_issue(db, 'crm_icris_not_in_master', date.today() - timedelta(days=90))
        db.commit()
        issue_id = str(issue.id)
    finally:
        db.rollback()
        db.close()

    res = client.get('/api/v1/data-quality/issues', params={'icris_buffer_state': 'stuck', 'limit': 500})
    ids = {i['id'] for i in res.json()['items']}
    assert issue_id not in ids


def test_sort_by_revenue_still_works_across_both_types(client):
    db = SessionLocal()
    try:
        _s1, low = _seed_icris_issue(db, 'crm_blank_icris', date.today() - timedelta(days=90), bill_amount=Decimal('5'))
        _s2, high = _seed_icris_issue(db, 'crm_invalid_icris', date.today() - timedelta(days=90), bill_amount=Decimal('8888'))
        db.commit()

        res = client.get('/api/v1/data-quality/issues', params={'sort': 'revenue', 'icris_buffer_state': 'stuck', 'limit': 500})
        order = [i['id'] for i in res.json()['items']]
        assert order.index(str(high.id)) < order.index(str(low.id))
    finally:
        db.rollback()
        db.close()


def test_summary_reports_icris_buffer_age_and_not_in_master_count(client):
    db = SessionLocal()
    try:
        _seed_icris_issue(db, 'crm_blank_icris', date.today() - timedelta(days=90), bill_amount=Decimal('500'))
        tag = uuid.uuid4().hex[:8].upper()
        company = Company(icris_number=f'NIM{tag}', company_name='Not In Master Co', normalized_name=f'not in master co {tag}', is_provisional=True)
        db.add(company)
        db.flush()
        db.add(DataQualityIssue(issue_type='crm_icris_not_in_master', severity='info', status='open',
                                 company_id=company.id, source_company_name='Not In Master Co', details_json={}))
        db.commit()

        res = client.get('/api/v1/data-quality/summary')
        assert res.status_code == 200
        data = res.json()
        assert data['icris_buffer_days'] == 30
        states = {row['state'] for row in data['icris_buffer_age']}
        assert 'stuck' in states
        assert data['icris_not_in_master_open'] >= 1
    finally:
        db.rollback()
        db.close()


def test_manual_resolve_records_admin_as_resolved_by(client):
    db = SessionLocal()
    try:
        _s, issue = _seed_icris_issue(db, 'crm_blank_icris', date.today())
        db.commit()
        issue_id = str(issue.id)
    finally:
        db.rollback()
        db.close()

    res = client.patch(f'/api/v1/data-quality/issues/{issue_id}', json={'status': 'resolved'})
    assert res.status_code == 200

    db = SessionLocal()
    try:
        refreshed = db.get(DataQualityIssue, issue.id)
        assert refreshed.status == 'resolved'
        assert refreshed.resolved_by == 'test-admin@customer360.test'
    finally:
        db.rollback()
        db.close()


def test_resolution_log_shows_before_and_after(client):
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        company = Company(icris_number=f'RL{tag}', company_name='Resolved Co', normalized_name=f'resolved co {tag}')
        db.add(company)
        db.flush()
        s = Shipment(shipment_number=f'DQ-{tag}', source='crm', pay_term='PP', bill_amount=Decimal('42'),
                     shipment_date=date.today(), match_status='matched', company_id=company.id)
        db.add(s)
        db.flush()
        issue = DataQualityIssue(issue_type='crm_blank_icris', severity='warning', status='resolved',
                                  shipment_id=s.id, source_company_name='Resolved Co (old)', source_icris_number=None,
                                  details_json={}, resolved_by='crm_sync')
        from app.models import now as model_now
        issue.resolved_at = model_now()
        db.add(issue)
        db.commit()
        issue_id = str(issue.id)
    finally:
        db.rollback()
        db.close()

    res = client.get('/api/v1/data-quality/resolution-log', params={'resolved_by': 'crm_sync', 'limit': 500})
    assert res.status_code == 200
    items = {i['id']: i for i in res.json()['items']}
    assert issue_id in items
    row = items[issue_id]
    assert row['before_company_name'] == 'Resolved Co (old)'
    assert row['after_company_name'] == 'Resolved Co'
    assert row['resolved_by'] == 'crm_sync'
