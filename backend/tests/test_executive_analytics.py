import pytest

def test_executive_dashboard_endpoint(client):
    res = client.get('/api/v1/analytics/executive-dashboard')
    assert res.status_code == 200
    data = res.json()
    
    assert 'timeframe' in data
    assert 'kpi_cards' in data
    assert 'revenue_analytics' in data
    assert 'customer_growth' in data
    assert 'billing_analytics' in data
    assert 'customer_behavior' in data
    assert 'operational_analytics' in data
    assert 'leaderboards' in data
    assert 'executive_insights' in data

    kpis = data['kpi_cards']
    assert 'active_customers' in kpis
    assert 'total_billing' in kpis
    assert 'avg_revenue_per_customer' in kpis
    assert 'highest_spending_customer' in kpis

def test_executive_dashboard_timeframe_filters(client):
    for tf in ['today', 'this_week', 'this_month', 'this_quarter', 'this_year', 'all_time']:
        res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': tf})
        assert res.status_code == 200
        assert res.json()['timeframe'] == tf


def test_executive_dashboard_custom_range_uses_the_literal_dates_given():
    """Regression guard: Rankings and Profitability once silently dropped a custom range
    (the `timeframe: 'custom'` key got lost building the request, so every endpoint fell
    back to its default period while the page still displayed the dates the user picked —
    see handoversession.md). This endpoint must actually resolve `c_start`/`c_end` to the
    literal date_from/date_to given, not silently substitute a default window, and the
    comparison period must be an equal-length window immediately before it."""
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    c.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})

    res = c.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'custom', 'date_from': '2026-08-01', 'date_to': '2026-08-15'})
    assert res.status_code == 200
    bounds = res.json()['bounds']
    assert bounds['c_start'] == '2026-08-01'
    assert bounds['c_end'] == '2026-08-15'
    # Same 15-day span, immediately preceding — not last month, not last year, not the
    # server's default fallback range.
    assert bounds['p_start'] == '2026-07-17'
    assert bounds['p_end'] == '2026-07-31'


def test_all_customers_ae_code_matches_company_assignment_not_stale_shipment_ae(client):
    """Regression: a company with a real assigned_ae_code (the same field customer_type
    /segment -- Key Account/Reseller -- is derived from, docs/customer-segmentation-rules.md)
    must report that AE here too, even if its own shipment rows carry a blank/stale
    ae_code. Otherwise filtering this list to 'UNASSIGNED' shows companies whose segment
    says they ARE assigned -- exactly the bug reported against Customer Analytics/
    Business Analytics, both of which read this endpoint's revenue_analytics.all_customers."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Company, Shipment
    from app.utils import normalize_name
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        co = Company(icris_number=f'AEMISMATCH-{tag}', company_name=f'AE Mismatch Test {tag}',
                     normalized_name=normalize_name(f'AE Mismatch Test {tag}'), source='manual',
                     assigned_ae_code='RT', customer_type='Key Account')
        db.add(co); db.flush()
        # Shipment's own ae_code is blank -- simulates a row synced before AE assignment.
        db.add(Shipment(shipment_number=f'AEMIS-{tag}', source='crm', company_id=co.id,
                        pay_term='PP', bill_amount=Decimal('50'), shipment_date=date.today(), ae_code=''))
        db.commit()

        res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'all_time'})
        assert res.status_code == 200
        matches = [c for c in res.json()['revenue_analytics']['all_customers'] if c['company_id'] == str(co.id)]
        assert len(matches) == 1
        assert matches[0]['ae_code'] == 'RT'
        assert matches[0]['segment'] == 'Key Account'
    finally:
        db.rollback()
        from sqlalchemy import text
        db.execute(text("DELETE FROM shipments WHERE shipment_number LIKE :p"), {'p': f'AEMIS-{tag}%'})
        db.execute(text("DELETE FROM companies WHERE icris_number LIKE :p"), {'p': f'AEMISMATCH-{tag}%'})
        db.commit()
        db.close()


def _seed_pay_term_shipments(db):
    """One shipment per pay-term case, each billed 100. Returns the tracking-number prefix."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.models import Shipment
    tag = uuid.uuid4().hex[:8].upper()
    cases = {'PP': 'PP', 'FC': 'FC', 'FD': 'FD', 'NONREV': 'NON_REV', 'RTS': 'RTS',
             'BLANK': '', 'NULL': None, 'UNKNOWN': 'SOMETHING_NEW', 'LOWER': 'pp', 'PADDED': ' PP '}
    for label, term in cases.items():
        db.add(Shipment(shipment_number=f'REV-{tag}-{label}', source='crm', pay_term=term,
                        bill_amount=Decimal('100'), shipment_date=date.today()))
    db.flush()
    return tag


def test_only_billable_pay_terms_count_as_revenue_but_all_stay_counted_as_shipments():
    """The source CRM totals revenue into exactly three buckets — PP, FC, FD. Anything
    else (NON_REV, RTS, blank, NULL, or an unseen term) is not revenue to the CRM and
    must not be to us. Verified against the CRM's own manifest footers 2026-08-07.

    Excluded rows are still real cargo movements, so shipment COUNTS must be unaffected."""
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from sqlalchemy import text
    db = SessionLocal()
    try:
        tag = _seed_pay_term_shipments(db)
        row = db.execute(text(f"""
            SELECT count(*)::int AS shipments,
                   sum({REVENUE_AMOUNT_SQL})::float AS revenue
            FROM shipments s WHERE s.shipment_number LIKE :p
        """), {'p': f'REV-{tag}-%'}).mappings().one()
        # all 10 seeded rows remain counted as shipments
        assert row['shipments'] == 10
        # billable: PP, FC, FD, plus the lowercase and padded PP variants = 5 x 100
        # excluded: NON_REV, RTS, blank, NULL, unknown term
        assert row['revenue'] == 500.0
        db.rollback()
    finally:
        db.close()


def test_unknown_pay_term_defaults_to_non_revenue_not_revenue():
    """Allowlist, not denylist — a pay term nobody has seen before must never
    silently inflate revenue."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from sqlalchemy import text
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from app.models import Shipment
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        db.add(Shipment(shipment_number=f'UNK-{tag}', source='crm', pay_term='FUTURE_TERM_XYZ',
                        bill_amount=Decimal('9999'), shipment_date=date.today()))
        db.flush()
        rev = db.execute(text(f"SELECT sum({REVENUE_AMOUNT_SQL})::float FROM shipments s WHERE s.shipment_number=:n"),
                         {'n': f'UNK-{tag}'}).scalar()
        assert rev == 0.0
        db.rollback()
    finally:
        db.close()


def test_revenue_expression_is_shared_by_every_analytics_call_site():
    """All revenue call sites must use the single shared expression, so the basis
    can never silently drift apart between endpoints again."""
    import pathlib, re
    src = pathlib.Path(__file__).resolve().parents[1] / 'app' / 'main.py'
    text_src = src.read_text(encoding='utf-8')
    # Everything after the constant's own definition (its closing `END")`), so the
    # constant body itself isn't mistaken for a hand-rolled call site.
    body = text_src.split('END")', 1)[1]
    # No call site may hand-roll the old raw expression.
    assert 'coalesce(s.bill_amount, s.declared_value, 0)' not in body
    assert 'SUM(s.bill_amount)' not in body
    assert len(re.findall(r'REVENUE_AMOUNT_SQL', body)) >= 8


def test_ae_performance_health_buckets_sum_to_company_count(client):
    """Every customer lands in exactly one health bucket. If these ever disagree, the
    leaderboard counts and the drill-down list silently diverge (Dormant said 61 but
    filtered to 60 because 'Unknown' was folded into 'dormant')."""
    res = client.get('/api/v1/analytics/ae-performance', params={'timeframe': 'all_time'})
    assert res.status_code == 200
    data = res.json()
    assert 'items' in data and 'bounds' in data and 'health_thresholds' in data
    assert data['items'], 'expected at least one AE'
    for ae in data['items']:
        buckets = ae['active'] + ae['warning'] + ae['dormant'] + ae['unknown']
        assert buckets == ae['companies'], (
            f"{ae['ae']}: buckets {buckets} != companies {ae['companies']}")
        # the drill-down list must be exactly as long as the company count it advertises
        assert len(ae['customers']) == ae['companies']
        # and each customer's status must map to the bucket it was counted in
        by_status = {}
        for c in ae['customers']:
            by_status[c['status']] = by_status.get(c['status'], 0) + 1
        assert by_status.get('Active', 0) == ae['active']
        assert by_status.get('Warning', 0) == ae['warning']
        assert by_status.get('Dormant', 0) == ae['dormant']
        assert by_status.get('Unknown', 0) == ae['unknown']


def test_ae_performance_timeframes_are_actually_distinct(client):
    """'7d'/'30d'/'90d' used to all silently return the same 30-day window because
    get_timeframe_bounds didn't recognise them."""
    def total(tf):
        r = client.get('/api/v1/analytics/ae-performance', params={'timeframe': tf})
        assert r.status_code == 200
        d = r.json()
        return d['bounds']['c_start'], d['bounds']['c_end']

    w7, w30, w90 = total('last_7_days'), total('last_30_days'), total('last_90_days')
    assert w7 != w30 != w90 and w7 != w90, f'windows collapsed: {w7} {w30} {w90}'


def test_ae_performance_revenue_reconciles_with_executive_dashboard(client):
    """Both endpoints must report the same revenue for the same window -- they share
    REVENUE_AMOUNT_SQL, and this proves the AE grouping doesn't drop or double-count."""
    params = {'timeframe': 'all_time'}
    ae = client.get('/api/v1/analytics/ae-performance', params=params).json()
    ex = client.get('/api/v1/analytics/executive-dashboard', params=params).json()
    ae_total = round(sum(x['revenue'] for x in ae['items']), 2)
    assert ae_total == round(ex['kpi_cards']['total_billing']['value'], 2)
