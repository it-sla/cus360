import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.crm_parser import parse_supervisor_targets, CrmParseError
from app.db import SessionLocal
from app.models import AeTarget, CrmSyncState
import pytest

_TD = lambda vals: '<tr>' + ''.join(f'<td>{v}</td>' for v in vals) + '</tr>'


def _period_tables(actual_id, plan_id, actual, target):
    header = _TD(['', 'Pcs(Exp)', 'Vol(Exp)', 'Rev(Exp)', 'Pcs(Imp)', 'Vol(Imp)', 'Rev(Imp)'])
    return (
        f'<table id="{actual_id}">{header}{_TD(["Actual"] + actual)}</table>'
        f'<table id="{plan_id}">{_TD(["Target"] + target)}</table>'
    )


HTML = '<html><body>' + \
    _period_tables('MainContent_atc_TourFile_TabPanel1_tbl_DayActual', 'MainContent_atc_TourFile_TabPanel1_tbl_DayPlan',
                    ['11', '409.50', '0.00', '0', '0.00', '0.00'], ['102', '1,061.20', '11,025.99', '0', '0', '0']) + \
    _period_tables('MainContent_atc_TourFile_TabPanel1_tbl_Week', 'MainContent_atc_TourFile_TabPanel1_tbl_WeekPlan',
                    ['35', '817.50', '4,578.29', '0', '0.00', '0.00'], ['613', '6,367.20', '66,155.94', '0', '0', '0']) + \
    _period_tables('MainContent_atc_TourFile_TabPanel1_tbl_month', 'MainContent_atc_TourFile_TabPanel1_tbl_monthPlan',
                    ['923', '15,863.00', '185,627.75', '0', '0.00', '0.00'], ['2553', '26,530.00', '275,649.73', '0', '0', '0']) + \
    _period_tables('MainContent_atc_TourFile_TabPanel1_tbl_yearly', 'MainContent_atc_TourFile_TabPanel1_tbl_yearlyPlan',
                    ['11042', '172,100.30', '1,925,798.04', '1209', '2,690.33', '272.73'], ['22530', '269,789.00', '2,711,598.39', '0', '0', '0']) + \
    '</body></html>'


def test_parse_supervisor_targets_reads_all_four_periods():
    periods = parse_supervisor_targets(HTML)
    assert set(periods) == {'daily', 'weekly', 'monthly', 'yearly'}
    monthly = periods['monthly']
    assert float(monthly['actual']['rev_exp']) == 185627.75
    assert float(monthly['target']['rev_exp']) == 275649.73
    assert monthly['target']['pcs_exp'] == 2553
    assert monthly['target']['pcs_imp'] == 0


def test_parse_supervisor_targets_raises_when_a_table_is_missing():
    broken = HTML.replace('MainContent_atc_TourFile_TabPanel1_tbl_yearlyPlan', 'renamed_by_crm')
    with pytest.raises(CrmParseError):
        parse_supervisor_targets(broken)


def _floated(periods):
    # cursor_json is JSONB — Decimal isn't natively serializable, same conversion crm_worker
    # does before storing a snapshot.
    return {p: {k: {f: (float(v) if v is not None else None) for f, v in fig.items()} for k, fig in kinds.items()} for p, kinds in periods.items()}


def test_executive_dashboard_maps_timeframe_to_crm_period(client):
    db = SessionLocal()
    try:
        state = db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type == 'supervisor_targets'))
        if not state:
            state = CrmSyncState(entity_type='supervisor_targets')
            db.add(state)
        state.cursor_json = {
            'fetched_at': datetime.now(timezone.utc).isoformat(),
            'periods': _floated(parse_supervisor_targets(HTML)),
        }
        db.commit()
    finally:
        db.close()

    res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'this_month'})
    assert res.status_code == 200
    targets = res.json()['crm_targets']
    assert targets['period'] == 'monthly'
    assert targets['target']['rev_exp'] == 275649.73

    # This-year target still comes from the CRM snapshot even though ae_targets_sum_for_range
    # would also match — the CRM path is tried first and wins (crm_targets or fallback).
    res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'this_year'})
    assert res.json()['crm_targets']['target']['rev_exp'] == 2711598.39


def test_executive_dashboard_falls_back_to_ae_targets_sum_when_crm_has_no_snapshot(client):
    """CRM_Win.aspx's sibling page only ever shows the *current* period, so a year with
    no live snapshot (any 'By Year' pick other than the current year, last_month, a custom
    range, ...) must fall back to summing ae_targets instead of returning null.

    The endpoint sums *every* AE's target for the year, so — unlike other tests' uuid-tagged
    ae_codes, which stay isolated because they're queried back out by ae_code — this test's
    rows must be deleted afterward, or a persistent test DB accumulates them across runs and
    inflates the company-wide sum for year 2098 every time this file runs again."""
    tag = uuid.uuid4().hex[:6].upper()
    ae_code = f'TG{tag}'
    db = SessionLocal()
    try:
        for month in range(1, 13):
            db.add(AeTarget(ae_code=ae_code, year=2098, month=month, weight_target=10, piece_target=1, revenue_target=100))
        db.commit()

        res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'year_2098'})
        assert res.status_code == 200
        targets = res.json()['crm_targets']
        assert targets is not None
        assert targets['period'] == 'yearly'
        assert targets['target']['rev_exp'] == 1200.0
        assert targets['target']['pcs_exp'] == 12.0
        assert targets['target']['vol_exp'] == 120.0
        assert targets['actual']['rev_exp'] == 0.0  # no real shipments in 2098
    finally:
        db.execute(AeTarget.__table__.delete().where(AeTarget.ae_code == ae_code))
        db.commit()
        db.close()


def test_executive_dashboard_reports_no_target_when_ae_targets_has_no_matching_year(client):
    res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'year_1999'})
    assert res.json()['crm_targets'] is None
