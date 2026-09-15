import pytest


def _mk_mawb(db, tag, suffix, pnl_bill_amount, pnl_profit_loss, days_ago=0):
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.models import MasterAirWaybill
    m = MasterAirWaybill(mawb_number=f'PNLSORT-{tag}-{suffix}', manifest_date=date.today() - timedelta(days=days_ago),
                         pnl_bill_amount=Decimal(str(pnl_bill_amount)), pnl_ups_bill_amount=Decimal('0'),
                         pnl_profit_loss=Decimal(str(pnl_profit_loss)), pnl_synced_at=date.today())
    db.add(m); db.flush()
    return m


def _cleanup(db, tag):
    from sqlalchemy import text
    db.rollback()
    db.execute(text("DELETE FROM master_air_waybills WHERE mawb_number LIKE :p"), {'p': f'PNLSORT-{tag}-%'})
    db.commit()
    db.close()


def test_mawbs_sort_by_margin_orders_across_full_result_set_not_just_one_page(client):
    """Regression: the frontend used to only re-sort the current (date-ordered) page of
    results client-side, so the true best/worst-margin MAWBs on later pages never
    surfaced. The backend must now do the ordering itself, against everything matching
    the filter, independent of manifest_date."""
    import uuid
    from app.db import SessionLocal
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        # Deliberately dated so date-order and margin-order disagree: the highest-margin
        # MAWB is the OLDEST (would be last on a date-desc page), and vice versa.
        _mk_mawb(db, tag, 'LOWMARGIN', pnl_bill_amount=1000, pnl_profit_loss=10, days_ago=0)    # 1% margin, newest
        _mk_mawb(db, tag, 'HIGHMARGIN', pnl_bill_amount=1000, pnl_profit_loss=900, days_ago=10)  # 90% margin, oldest
        _mk_mawb(db, tag, 'MIDMARGIN', pnl_bill_amount=1000, pnl_profit_loss=300, days_ago=5)    # 30% margin
        db.commit()

        res = client.get('/api/v1/mawbs', params={'q': f'PNLSORT-{tag}', 'sort': 'margin', 'limit': 10})
        assert res.status_code == 200
        items = res.json()['items']
        numbers = [i['mawb_number'] for i in items]
        assert numbers == [f'PNLSORT-{tag}-HIGHMARGIN', f'PNLSORT-{tag}-MIDMARGIN', f'PNLSORT-{tag}-LOWMARGIN']

        # Default (manifest_date) sort must be unaffected -- newest first.
        res2 = client.get('/api/v1/mawbs', params={'q': f'PNLSORT-{tag}', 'limit': 10})
        numbers2 = [i['mawb_number'] for i in res2.json()['items']]
        assert numbers2 == [f'PNLSORT-{tag}-LOWMARGIN', f'PNLSORT-{tag}-MIDMARGIN', f'PNLSORT-{tag}-HIGHMARGIN']
    finally:
        _cleanup(db, tag)


def test_mawbs_sort_by_margin_does_not_error_on_zero_bill_amount(client):
    """A MAWB with pnl_bill_amount=0 must not blow up the ORDER BY with a SQL
    division-by-zero error -- it should just sort last."""
    import uuid
    from app.db import SessionLocal
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        _mk_mawb(db, tag, 'ZERO', pnl_bill_amount=0, pnl_profit_loss=0)
        _mk_mawb(db, tag, 'NORMAL', pnl_bill_amount=1000, pnl_profit_loss=100)
        db.commit()

        res = client.get('/api/v1/mawbs', params={'q': f'PNLSORT-{tag}', 'sort': 'margin', 'limit': 10})
        assert res.status_code == 200
        numbers = [i['mawb_number'] for i in res.json()['items']]
        assert numbers[0] == f'PNLSORT-{tag}-NORMAL'
    finally:
        _cleanup(db, tag)


def test_mawbs_sort_rejects_invalid_value(client):
    res = client.get('/api/v1/mawbs', params={'sort': 'not_a_real_sort'})
    assert res.status_code == 422
