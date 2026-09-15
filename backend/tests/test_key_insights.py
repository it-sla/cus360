import uuid
from datetime import date
from decimal import Decimal

from app.db import SessionLocal
from app.models import AccountExecutive, Company, DataQualityIssue, Shipment, UserNotificationState, User
from app.utils import normalize_name


def _mtd_vs_same_window_last_month_bounds():
    """Mirrors the day-matched window compute_alerts uses for Revenue Gainer/Decliner —
    tests need the exact same bounds to seed data that lands correctly on either side."""
    today = date.today()
    month_start = today.replace(day=1)
    if today.month == 1:
        prev_month_start = date(today.year - 1, 12, 1)
    else:
        prev_month_start = date(today.year, today.month - 1, 1)
    prev_month_end = prev_month_start + (today - month_start)
    return month_start, today, prev_month_start, prev_month_end


def test_revenue_decliner_compares_like_for_like_windows(client):
    """Regression: this alert used to compare month-to-date revenue against the *entire*
    previous month's total, so early in any month nearly every customer looked like a
    massive decline just from the accounting-period mismatch, not a real trend. It must
    compare the same number of days on both sides instead."""
    month_start, today, prev_month_start, prev_month_end = _mtd_vs_same_window_last_month_bounds()
    if (today - month_start).days < 3:
        return  # alert is intentionally skipped for the first few noisy days of a month

    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    # The alerts endpoint caps each (category, ae_code) group at 300 to keep one AE's huge
    # list from crowding out another's — the shared dev/test DB already has hundreds of
    # real ae_code-less dormant alerts, which would silently swallow this test's alert if
    # it landed in that same (unassigned) group. A unique ae_code keeps it in its own group.
    test_ae = f'T{tag[:7]}'
    try:
        db.add(AccountExecutive(ae_code=test_ae, display_name='Revenue Test AE'))

        # Steady company: same revenue in both matched windows -> must NOT fire a decline,
        # even though a full-prior-month total would dwarf a partial current-month total.
        steady = Company(icris_number=f'STD{tag}', company_name=f'Steady Co {tag}', normalized_name=normalize_name(f'Steady Co {tag}'), source='manual', name_source='manual', assigned_ae_code=test_ae)
        db.add(steady)
        db.flush()
        db.add(Shipment(shipment_number=f'RD-{uuid.uuid4().hex[:10].upper()}', source='manual', company_id=steady.id, bill_amount=Decimal('1000'), shipment_date=today, pay_term='PP'))
        db.add(Shipment(shipment_number=f'RD-{uuid.uuid4().hex[:10].upper()}', source='manual', company_id=steady.id, bill_amount=Decimal('1000'), shipment_date=prev_month_end, pay_term='PP'))

        # Real decliner: had revenue in the matched prior window, has none in the matched
        # current window -> must fire.
        dropped = Company(icris_number=f'DRP{tag}', company_name=f'Dropped Co {tag}', normalized_name=normalize_name(f'Dropped Co {tag}'), source='manual', name_source='manual', assigned_ae_code=test_ae)
        db.add(dropped)
        db.flush()
        db.add(Shipment(shipment_number=f'RD-{uuid.uuid4().hex[:10].upper()}', source='manual', company_id=dropped.id, bill_amount=Decimal('9000'), shipment_date=prev_month_end, pay_term='PP'))
        db.commit()

        res = client.get('/api/v1/analytics/alerts')
        assert res.status_code == 200
        titles = {a['entity_name']: a['type'] for a in res.json()['alerts'] if a['type'] in ('Revenue Gainer', 'Revenue Decliner')}
        assert titles.get(steady.company_name) is None
        assert titles.get(dropped.company_name) == 'Revenue Decliner'
    finally:
        db.rollback()
        db.close()


def test_key_insights_returns_only_high_severity(client):
    res = client.get('/api/v1/notifications/key-insights')
    assert res.status_code == 200
    data = res.json()
    assert 'items' in data and 'unread_count' in data
    assert all(i['severity'] == 'high' for i in data['items'])


def test_alert_ids_are_stable_across_requests(client):
    # Same underlying conditions must produce the same ids call to call, or
    # seen/unseen tracking has nothing stable to compare against.
    first = client.get('/api/v1/notifications/key-insights').json()['items']
    second = client.get('/api/v1/notifications/key-insights').json()['items']
    assert [i['id'] for i in first] == [i['id'] for i in second]


def test_date_pushed_alert_ids_are_unique_per_pipeline_item(client):
    """Regression: two open pipeline_date_pushed issues against the same company used to
    hash to the same id because the hash keyed off company_id (shared) instead of the
    issue's own id, so React saw duplicate keys and the notification bell couldn't tell
    the two rows apart."""
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        company = Company(icris_number=f'DPI{tag}', company_name=f'DatePushed Co {tag}', normalized_name=normalize_name(f'DatePushed Co {tag}'), source='manual', name_source='manual')
        db.add(company)
        db.flush()
        for i in range(2):
            db.add(DataQualityIssue(issue_type='pipeline_date_pushed', severity='medium', company_id=company.id, source_company_name=company.company_name, details_json={'days_pushed': 5 + i, 'old_expected_date': '2026-01-01', 'new_expected_date': '2026-01-06'}, status='open'))
        db.commit()

        res = client.get('/api/v1/analytics/alerts')
        assert res.status_code == 200
        ids = [a['id'] for a in res.json()['alerts'] if a['type'] == 'Date Pushed (No Follow-up)' and a['entity_name'] == company.company_name]
        assert len(ids) == 2
        assert len(set(ids)) == 2
    finally:
        db.rollback()
        db.close()


def test_key_insights_sorted_by_occurred_at_descending(client):
    items = client.get('/api/v1/notifications/key-insights').json()['items']
    dates = [i['occurred_at'] for i in items]
    assert dates == sorted(dates, reverse=True)


def test_key_insights_category_filter(client):
    unfiltered = client.get('/api/v1/notifications/key-insights').json()
    if not unfiltered['categories']:
        return  # no high-severity insights in this environment's data
    cat = unfiltered['categories'][0]
    filtered = client.get(f'/api/v1/notifications/key-insights?category={cat}').json()
    assert all(i['category'] == cat for i in filtered['items'])


def test_mark_seen_reduces_unread_count():
    db = SessionLocal()
    try:
        db.query(UserNotificationState).delete()
        db.commit()
    finally:
        db.close()

    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth import hash_password
    c = TestClient(app)
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == 'test-admin@customer360.test').first()
        assert user is not None
        login = c.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})
        assert login.status_code == 200

        before = c.get('/api/v1/notifications/key-insights').json()
        if before['unread_count'] == 0:
            return  # nothing to mark seen in this environment's data — not this test's concern
        ids = [i['id'] for i in before['items']]

        mark = c.post('/api/v1/notifications/mark-seen', json={'ids': ids})
        assert mark.status_code == 200

        # Marked every currently-returned id seen, and nothing new appeared in between
        # (static test data) — unread should drop to exactly zero.
        after = c.get('/api/v1/notifications/key-insights').json()
        assert after['unread_count'] == 0
        assert all(i['seen'] for i in after['items'])
    finally:
        db.close()


def test_prune_notification_state_drops_stale_ids_allowing_recurrence():
    """A seen/snoozed id that's no longer among the live high-severity alerts must be
    dropped -- otherwise a resolved-then-recurring condition (same stable id) stays
    silently "seen"/snoozed forever and never re-badges."""
    from app.main import _prune_notification_state
    from app.models import UserNotificationState
    state = UserNotificationState(seen_alert_ids=['stale-1', 'live-1'], snoozed={'stale-2': '2020-01-01', 'live-2': '2099-01-01'})
    changed = _prune_notification_state(state, live_ids={'live-1', 'live-2'})
    assert changed is True
    assert state.seen_alert_ids == ['live-1']
    assert state.snoozed == {'live-2': '2099-01-01'}
    # Nothing stale left -> re-running against the same live set is a no-op.
    assert _prune_notification_state(state, live_ids={'live-1', 'live-2'}) is False


def test_snooze_hides_item_and_expiry_resurfaces_it():
    db = SessionLocal()
    try:
        db.query(UserNotificationState).delete()
        db.commit()
    finally:
        db.close()

    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    login = c.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})
    assert login.status_code == 200

    before = c.get('/api/v1/notifications/key-insights').json()
    if not before['items']:
        return  # nothing to snooze in this environment's data — not this test's concern
    target_id = before['items'][0]['id']
    initial_unread = before['unread_count']
    was_unread = not before['items'][0]['seen']

    snooze = c.post('/api/v1/notifications/snooze', json={'id': target_id, 'days': 7})
    assert snooze.status_code == 200

    after_snooze = c.get('/api/v1/notifications/key-insights').json()
    assert target_id not in {i['id'] for i in after_snooze['items']}
    if was_unread:
        assert after_snooze['unread_count'] == initial_unread - 1

    # Force the snooze into the past (as if it had expired) and confirm it resurfaces.
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == 'test-admin@customer360.test').first()
        state = db.get(UserNotificationState, user.id)
        state.snoozed = {**state.snoozed, target_id: '2020-01-01'}
        db.commit()
    finally:
        db.close()

    after_expiry = c.get('/api/v1/notifications/key-insights').json()
    assert target_id in {i['id'] for i in after_expiry['items']}


def test_snooze_permanent_dismiss_removes_item_and_stays_removed():
    db = SessionLocal()
    try:
        db.query(UserNotificationState).delete()
        db.commit()
    finally:
        db.close()

    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    login = c.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})
    assert login.status_code == 200

    before = c.get('/api/v1/notifications/key-insights').json()
    if not before['items']:
        return  # nothing to dismiss in this environment's data — not this test's concern
    target_id = before['items'][0]['id']

    dismiss = c.post('/api/v1/notifications/snooze', json={'id': target_id, 'days': None})
    assert dismiss.status_code == 200
    assert dismiss.json()['snoozed_until'] == '9999-12-31'

    after = c.get('/api/v1/notifications/key-insights').json()
    assert target_id not in {i['id'] for i in after['items']}


def test_mark_all_seen_clears_unread_regardless_of_page_size():
    """mark-all-seen must clear every current high-severity insight, not just whatever
    subset the client happened to have fetched (e.g. the bell dropdown's top 8)."""
    db = SessionLocal()
    try:
        db.query(UserNotificationState).delete()
        db.commit()
    finally:
        db.close()

    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    login = c.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})
    assert login.status_code == 200

    before = c.get('/api/v1/notifications/key-insights').json()
    if before['unread_count'] == 0:
        return  # nothing to mark seen in this environment's data — not this test's concern

    res = c.post('/api/v1/notifications/mark-all-seen')
    assert res.status_code == 200
    assert res.json()['marked'] == len(before['items'])

    after = c.get('/api/v1/notifications/key-insights').json()
    assert after['unread_count'] == 0
