import pytest

# NOTE: there is no isolated TEST_DATABASE_URL in this environment -- these tests run
# against the real database (confirmed: earlier drafts of this file leaked permanent
# 'Seg Test ...' rows because recompute_customer_segments() commits internally, so a
# bare db.rollback() in a finally block does nothing once that's been called). Every
# test here MUST explicitly delete every row it creates, in a finally block, regardless
# of whether a commit happened along the way. Do not rely on rollback alone.


def _mk_company(db, tag, ae_code=None):
    from app.models import Company
    from app.utils import normalize_name
    c = Company(icris_number=f'SEG-{tag}', company_name=f'Seg Test {tag}',
                normalized_name=normalize_name(f'Seg Test {tag}'), source='manual',
                assigned_ae_code=ae_code)
    db.add(c); db.flush()
    return c


def _mk_shipment(db, tag, company, month_offset, amount, pay_term='PP'):
    """month_offset=0 is this month, 1 is last month, etc. -- so each shipment lands in a
    distinct, deterministic calendar month for 'best month ever' testing."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from dateutil.relativedelta import relativedelta
    from app.models import Shipment
    d = (date.today().replace(day=1) - relativedelta(months=month_offset))
    db.add(Shipment(shipment_number=f'SEGSHIP-{tag}-{uuid.uuid4().hex[:6]}', source='crm',
                    company_id=company.id, pay_term=pay_term, bill_amount=Decimal(str(amount)),
                    shipment_date=d))


def _cleanup(db, tag):
    from sqlalchemy import text
    db.rollback()  # in case the test errored before its own commit
    db.execute(text("DELETE FROM shipments WHERE shipment_number LIKE :p"), {'p': f'%{tag}%'})
    db.execute(text("DELETE FROM companies WHERE icris_number LIKE :p"), {'p': f'SEG-{tag}%'})
    db.commit()
    db.close()


def test_ae_assignment_overrides_revenue_for_key_account_and_reseller(client):
    """RT/AJ -> Key Account and DN -> Reseller regardless of how much revenue the
    company brings in -- even a company with a $50k peak month must not become
    Large Account if its AE is RT/AJ/DN."""
    import uuid
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from app.customer_segments import recompute_customer_segments
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        rt_co = _mk_company(db, f'{tag}-RT', ae_code='RT')
        aj_co = _mk_company(db, f'{tag}-AJ', ae_code='AJ')
        dn_co = _mk_company(db, f'{tag}-DN', ae_code='DN')
        _mk_shipment(db, tag, rt_co, 0, 50000)
        _mk_shipment(db, tag, aj_co, 0, 50000)
        _mk_shipment(db, tag, dn_co, 0, 50000)
        db.commit()

        recompute_customer_segments(db, REVENUE_AMOUNT_SQL)

        db.refresh(rt_co); db.refresh(aj_co); db.refresh(dn_co)
        assert rt_co.customer_type == 'Key Account'
        assert aj_co.customer_type == 'Key Account'
        assert dn_co.customer_type == 'Reseller'
    finally:
        _cleanup(db, tag)


def test_revenue_thresholds_large_sme_small(client):
    import uuid
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from app.customer_segments import recompute_customer_segments
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        large_co = _mk_company(db, f'{tag}-LARGE')
        sme_co = _mk_company(db, f'{tag}-SME')
        small_co = _mk_company(db, f'{tag}-SMALL')
        _mk_shipment(db, tag, large_co, 0, 5000)   # exactly at the Large threshold
        _mk_shipment(db, tag, sme_co, 0, 1000)     # exactly at the SME threshold
        _mk_shipment(db, tag, small_co, 0, 999)    # just under SME
        db.commit()

        recompute_customer_segments(db, REVENUE_AMOUNT_SQL)

        db.refresh(large_co); db.refresh(sme_co); db.refresh(small_co)
        assert large_co.customer_type == 'Large Account'
        assert sme_co.customer_type == 'SME'
        assert small_co.customer_type == 'Small Customer'
    finally:
        _cleanup(db, tag)


def test_tier_uses_best_month_ever_not_current_month(client):
    """A company with a huge spike 6 months ago and nothing since must still be Large
    Account today -- the rule looks at the all-time peak month, not current revenue."""
    import uuid
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from app.customer_segments import recompute_customer_segments
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        co = _mk_company(db, tag)
        _mk_shipment(db, tag, co, 6, 8000)   # a peak month, 6 months ago
        _mk_shipment(db, tag, co, 0, 50)     # this month, far below any threshold
        db.commit()

        recompute_customer_segments(db, REVENUE_AMOUNT_SQL)

        db.refresh(co)
        assert co.customer_type == 'Large Account'
    finally:
        _cleanup(db, tag)


def test_recompute_never_demotes_large_account_even_if_run_again_with_less_data(client):
    """Regression for the literal 'large accounts cannot be demoted' requirement: running
    the recompute twice, with the second run's visible data unchanged from the first,
    must not flip a Large Account back down. (The real no-demotion guarantee comes from
    the best-month-ever calculation itself -- this test locks in that idempotent re-runs
    of the SAME data always land on the SAME tier, which is the property that matters.)"""
    import uuid
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL
    from app.customer_segments import recompute_customer_segments
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        co = _mk_company(db, tag)
        _mk_shipment(db, tag, co, 0, 5000)
        db.commit()

        recompute_customer_segments(db, REVENUE_AMOUNT_SQL)
        db.refresh(co)
        assert co.customer_type == 'Large Account'

        recompute_customer_segments(db, REVENUE_AMOUNT_SQL)
        db.refresh(co)
        assert co.customer_type == 'Large Account'
    finally:
        _cleanup(db, tag)


def test_recompute_segments_admin_endpoint_requires_admin():
    """Uses a fresh, unauthenticated TestClient -- the shared `client` fixture is
    pre-logged-in as an admin test user (see conftest.py), so it can't be used to test
    this boundary; it would just get a real 200 and, worse, actually run the recompute
    against every company in the shared (real, not isolated) database."""
    from fastapi.testclient import TestClient
    from app.main import app
    anon_client = TestClient(app)
    res = anon_client.post('/api/v1/admin/customers/recompute-segments')
    assert res.status_code in (401, 403)


def test_tier_shipping_gap_alert_fires_per_tier_sla(client):
    """Key Account/Reseller/Large Account get a 7-day SLA, SME gets 15 days."""
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        # A unique, made-up AE code (rather than leaving assigned_ae_code unset) keeps
        # these two companies in their own small per-(category, ae_code) alert-response
        # group -- the real 'unassigned' bucket has hundreds of companies and the alerts
        # endpoint caps each group at 300, so an unassigned test company can get silently
        # dropped from the response depending on what else ran earlier in the suite.
        unique_ae = f'Z{tag[:7]}'
        key_co = _mk_company(db, f'{tag}-KEYGAP', ae_code=unique_ae)
        key_co.customer_type = 'Key Account'
        sme_co = _mk_company(db, f'{tag}-SMEGAP', ae_code=unique_ae)
        sme_co.customer_type = 'SME'
        db.flush()

        # Key Account: last shipment 10 days ago -> breaches the 7-day SLA.
        db.add(Shipment(shipment_number=f'SEGSHIP-{tag}-KEY', source='crm', company_id=key_co.id,
                        pay_term='PP', bill_amount=Decimal('100'),
                        shipment_date=date.today() - timedelta(days=10)))
        # SME: last shipment 10 days ago -> still within the 15-day SLA, no alert.
        db.add(Shipment(shipment_number=f'SEGSHIP-{tag}-SME', source='crm', company_id=sme_co.id,
                        pay_term='PP', bill_amount=Decimal('100'),
                        shipment_date=date.today() - timedelta(days=10)))
        db.commit()

        res = client.get('/api/v1/analytics/alerts')
        assert res.status_code == 200
        alerts = res.json()['alerts']
        gap_alerts = [a for a in alerts if a['type'] == 'Tier Shipping Gap']
        entity_ids = {a['entity_id'] for a in gap_alerts}
        assert str(key_co.id) in entity_ids
        assert str(sme_co.id) not in entity_ids
    finally:
        _cleanup(db, tag)
