from datetime import date
from decimal import Decimal
import uuid

from app.db import SessionLocal
from app.models import AccountExecutive, DailyCallLog, Shipment, User


def _seed_ae_shipment(db, ae_code, revenue, weight, shipment_date=None, pay_term='PP'):
    db.add(Shipment(
        shipment_number=f'LB-{uuid.uuid4().hex[:10].upper()}', source='crm', ae_code=ae_code,
        pay_term=pay_term, bill_amount=Decimal(str(revenue)), shipment_weight=weight,
        shipment_date=shipment_date or date.today(),
    ))


def _seed_call_log(db, ae_code, stage, call_date=None):
    db.add(DailyCallLog(
        call_date=call_date or date.today(), company_name=f'Test Co {uuid.uuid4().hex[:6]}',
        ae_code=ae_code, stage=stage, source_row_hash=uuid.uuid4().hex,
    ))


def test_leaderboard_ranks_by_revenue_shipments_and_weight(client):
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae_hi, ae_lo = f'HI{tag}', f'LO{tag}'
        db.add_all([
            AccountExecutive(ae_code=ae_hi, display_name='High Roller'),
            AccountExecutive(ae_code=ae_lo, display_name='Low Key'),
        ])
        # ae_hi: bigger revenue. ae_lo: more shipments and more weight — different winners per metric.
        _seed_ae_shipment(db, ae_hi, 1000, 5)
        _seed_ae_shipment(db, ae_lo, 100, 50)
        _seed_ae_shipment(db, ae_lo, 100, 50)
        db.commit()

        res = client.get('/api/v1/leaderboard')
        assert res.status_code == 200
        data = res.json()
        assert 'period' in data and 'leaderboards' in data
        boards = data['leaderboards']
        assert set(boards.keys()) == {'revenue', 'shipments', 'weight', 'wins'}

        # Ranks are compared relatively, not as absolute 1/2/3 — the full suite seeds other
        # AE-coded shipments dated "today" elsewhere, so this pair isn't necessarily alone
        # on the board.
        by_code = {e['ae_code']: e for e in boards['revenue']}
        assert by_code[ae_hi]['rank'] < by_code[ae_lo]['rank']  # ae_hi earns more revenue
        assert by_code[ae_hi]['display_name'] == 'High Roller'

        shipments_by_code = {e['ae_code']: e for e in boards['shipments']}
        assert shipments_by_code[ae_lo]['rank'] < shipments_by_code[ae_hi]['rank']  # ae_lo has more shipments

        weight_by_code = {e['ae_code']: e for e in boards['weight']}
        assert weight_by_code[ae_lo]['rank'] < weight_by_code[ae_hi]['rank']  # ae_lo has more weight

        # Every entry carries its rank across all three metrics, not just the board it's listed under.
        assert by_code[ae_hi]['ranks']['revenue'] == by_code[ae_hi]['rank']
        assert by_code[ae_hi]['ranks']['shipments'] == shipments_by_code[ae_hi]['rank']
    finally:
        db.rollback()
        db.close()


def test_leaderboard_excludes_unassigned_shipments(client):
    db = SessionLocal()
    try:
        _seed_ae_shipment(db, None, 500, 10)
        _seed_ae_shipment(db, '', 500, 10)
        db.commit()

        res = client.get('/api/v1/leaderboard')
        assert res.status_code == 200
        codes = {e['ae_code'] for e in res.json()['leaderboards']['revenue']}
        assert 'UNASSIGNED' not in codes
    finally:
        db.rollback()
        db.close()


def test_leaderboard_ignores_shipments_outside_current_month(client):
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae = f'OLD{tag}'
        db.add(AccountExecutive(ae_code=ae, display_name='Ancient History'))
        _seed_ae_shipment(db, ae, 999999, 999, shipment_date=date(2020, 1, 15))
        db.commit()

        res = client.get('/api/v1/leaderboard')
        codes = {e['ae_code'] for e in res.json()['leaderboards']['revenue']}
        assert ae not in codes
    finally:
        db.rollback()
        db.close()


def test_leaderboard_wins_counts_win_stage_only(client):
    """Wins come from Daily Call Log stage, not pipeline_items.win_loss — that field
    is always blank in practice since pipeline_items only ever holds the CRM's
    still-open (never-closed) pipeline. 'Win' must match exactly; other stages don't count."""
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae = f'WIN{tag}'
        db.add(AccountExecutive(ae_code=ae, display_name='Closer'))
        _seed_call_log(db, ae, 'Win')          # counts
        _seed_call_log(db, ae, 'Win')          # counts
        _seed_call_log(db, ae, 'Loss')         # does not count
        _seed_call_log(db, ae, 'Prospect')     # does not count
        _seed_call_log(db, ae, None)           # does not count
        db.commit()

        res = client.get('/api/v1/leaderboard')
        assert res.status_code == 200
        by_code = {e['ae_code']: e for e in res.json()['leaderboards']['wins']}
        assert by_code[ae]['wins'] == 2
    finally:
        db.rollback()
        db.close()


def test_leaderboard_wins_ignores_call_logs_outside_current_month(client):
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae = f'OLDWIN{tag}'
        db.add(AccountExecutive(ae_code=ae, display_name='Old News'))
        _seed_call_log(db, ae, 'Win', call_date=date(2020, 1, 15))
        db.commit()

        res = client.get('/api/v1/leaderboard')
        codes = {e['ae_code'] for e in res.json()['leaderboards']['wins']}
        assert ae not in codes
    finally:
        db.rollback()
        db.close()


def test_leaderboard_includes_ae_with_wins_but_no_shipments_this_month(client):
    """An AE who closed a deal but hasn't shipped anything yet this month must still
    appear on the board (with 0 revenue/shipments/weight) — otherwise a real win
    silently vanishes because the shipment-side query never produced a row for them."""
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae = f'PUREWIN{tag}'
        db.add(AccountExecutive(ae_code=ae, display_name='Deal Closer'))
        _seed_call_log(db, ae, 'Win')
        db.commit()

        res = client.get('/api/v1/leaderboard')
        by_code = {e['ae_code']: e for e in res.json()['leaderboards']['revenue']}
        assert ae in by_code
        assert by_code[ae]['wins'] == 1
        assert by_code[ae]['revenue'] == 0.0
        assert by_code[ae]['shipments'] == 0
    finally:
        db.rollback()
        db.close()


def test_leaderboard_reachable_by_every_authenticated_role(client):
    # client fixture is pre-authenticated as super_admin; the real point of this test is
    # that the route exists and returns 200 with no role dependency in its signature
    # (unlike every other AE-facing endpoint, which is admin/sales_lead/ae-scoped).
    res = client.get('/api/v1/leaderboard')
    assert res.status_code == 200


def test_leaderboard_timeframe_lets_admin_view_a_past_month(client):
    # Reuses the same timeframe/date_from/date_to shape as the rest of the analytics
    # suite (get_timeframe_bounds), via a literal custom range rather than a preset —
    # avoids the test depending on which calendar year happens to be "this year".
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:6].upper()
        ae = f'PAST{tag}'
        db.add(AccountExecutive(ae_code=ae, display_name='Time Traveler'))
        _seed_ae_shipment(db, ae, 500, 10, shipment_date=date(2024, 3, 15))
        db.commit()

        res = client.get('/api/v1/leaderboard?date_from=2024-03-01&date_to=2024-03-31')
        assert res.status_code == 200
        data = res.json()
        assert data['period']['label'] == 'March 2024'
        codes = {e['ae_code'] for e in data['leaderboards']['revenue']}
        assert ae in codes
    finally:
        db.rollback()
        db.close()


def test_leaderboard_timeframe_ignored_for_non_admin_tier():
    """A role outside admin/super_admin can't use timeframe/date_from/date_to to look
    outside the current month — the shared `client` fixture is super_admin, so this
    boundary needs its own lesser-role login."""
    from fastapi.testclient import TestClient
    from app.auth import hash_password
    from app.main import app
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    email = f'lb-plain-user-{tag.lower()}@customer360.test'
    try:
        db.add(User(email=email, display_name='Plain User', role='user', password_hash=hash_password('test-password-not-real'), is_active=True))
        db.commit()

        plain_client = TestClient(app)
        login = plain_client.post('/api/v1/auth/login', json={'email': email, 'password': 'test-password-not-real'})
        assert login.status_code == 200

        res = plain_client.get('/api/v1/leaderboard?date_from=2024-03-01&date_to=2024-03-31')
        assert res.status_code == 200
        assert res.json()['period']['label'] != 'March 2024'
    finally:
        db.query(User).filter(User.email == email).delete()
        db.commit()
        db.close()
