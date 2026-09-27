"""Admin password reset, self change-password, session revocation on password
change/reset/deactivation, and login lockout. See auth.py (revoke_sessions,
LOCKOUT_THRESHOLD/MINUTES, get_current_user's session_version check) and
main.py (auth_login, auth_change_password, admin_set_password, admin_unlock_user).
"""
import uuid
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import User
from app.auth import hash_password
from sqlalchemy import select

PASSWORD = 'orig-password-123'


def _make_user(role='user', password=PASSWORD) -> tuple[str, str]:
    """Creates a fresh user directly in the DB and returns (email, user_id)."""
    db = SessionLocal()
    email = f'test-sec-{uuid.uuid4().hex[:10]}@customer360.test'
    u = User(email=email, display_name='Security Test User', role=role,
             password_hash=hash_password(password), is_active=True)
    db.add(u); db.commit(); user_id = str(u.id); db.close()
    return email, user_id


def _login(email, password) -> TestClient:
    c = TestClient(app)
    r = c.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture()
def super_admin_client():
    email, _ = _make_user('super_admin')
    return _login(email, PASSWORD)


def test_admin_sets_password_kills_old_session_and_new_password_logs_in(super_admin_client):
    email, user_id = _make_user('user')
    old_session = _login(email, PASSWORD)
    assert old_session.get('/api/v1/auth/me').status_code == 200

    r = super_admin_client.post(f'/api/v1/admin/users/{user_id}/password', json={'password': 'new-password-456'})
    assert r.status_code == 200

    assert old_session.get('/api/v1/auth/me').status_code == 401
    assert _login(email, 'new-password-456').get('/api/v1/auth/me').status_code == 200
    fresh = TestClient(app)
    assert fresh.post('/api/v1/auth/login', json={'email': email, 'password': PASSWORD}).status_code == 401


def test_admin_set_password_requires_super_admin():
    admin_email, _ = _make_user('admin')
    admin_client = _login(admin_email, PASSWORD)
    _, target_id = _make_user('user')
    r = admin_client.post(f'/api/v1/admin/users/{target_id}/password', json={'password': 'whatever123'})
    assert r.status_code == 403


def test_self_change_password_wrong_current_is_400():
    email, _ = _make_user('user')
    client = _login(email, PASSWORD)
    r = client.post('/api/v1/auth/change-password', json={'current_password': 'nope', 'new_password': 'new-password-456'})
    assert r.status_code == 400


def test_self_change_password_revokes_other_sessions_but_keeps_caller_signed_in():
    email, _ = _make_user('user')
    session_a = _login(email, PASSWORD)
    session_b = _login(email, PASSWORD)
    assert session_a.get('/api/v1/auth/me').status_code == 200
    assert session_b.get('/api/v1/auth/me').status_code == 200

    r = session_a.post('/api/v1/auth/change-password', json={'current_password': PASSWORD, 'new_password': 'new-password-456'})
    assert r.status_code == 200

    # session_a's cookie was re-issued in the response, so it survives its own change...
    assert session_a.get('/api/v1/auth/me').status_code == 200
    # ...but session_b, issued before the change, is dead.
    assert session_b.get('/api/v1/auth/me').status_code == 401
    # and the new password is what logs in now.
    assert _login(email, 'new-password-456').get('/api/v1/auth/me').status_code == 200


def test_readonly_admin_can_change_own_password():
    email, _ = _make_user('admin')
    client = _login(email, PASSWORD)
    r = client.post('/api/v1/auth/change-password', json={'current_password': PASSWORD, 'new_password': 'new-password-456'})
    assert r.status_code == 200


def test_login_lockout_after_five_failures_then_unlock(super_admin_client):
    email, user_id = _make_user('user')
    c = TestClient(app)
    for _ in range(5):
        r = c.post('/api/v1/auth/login', json={'email': email, 'password': 'wrong'})
        assert r.status_code == 401
    # Locked now, even with the correct password.
    r = c.post('/api/v1/auth/login', json={'email': email, 'password': PASSWORD})
    assert r.status_code == 423

    unlock = super_admin_client.post(f'/api/v1/admin/users/{user_id}/unlock')
    assert unlock.status_code == 200
    r = c.post('/api/v1/auth/login', json={'email': email, 'password': PASSWORD})
    assert r.status_code == 200


def test_successful_login_sets_last_login_at(super_admin_client):
    email, user_id = _make_user('user')
    _login(email, PASSWORD)
    users = super_admin_client.get('/api/v1/admin/users', params={'q': email}).json()['items']
    assert len(users) == 1
    assert users[0]['last_login_at'] is not None
    assert users[0]['is_locked'] is False


def test_deactivating_user_kills_their_session(super_admin_client):
    email, user_id = _make_user('user')
    session = _login(email, PASSWORD)
    assert session.get('/api/v1/auth/me').status_code == 200

    r = super_admin_client.patch(f'/api/v1/admin/users/{user_id}', json={'is_active': False})
    assert r.status_code == 200
    assert session.get('/api/v1/auth/me').status_code == 401


def test_legacy_two_part_token_still_works():
    """Tokens signed before session_version existed (user_id:issued_at, no third
    field) must still authenticate — they're treated as session_version 0."""
    email, user_id = _make_user('user')
    from app.auth import _sign, AUTH_COOKIE_NAME
    from datetime import datetime, timezone
    legacy_token = _sign(f'{user_id}:{int(datetime.now(timezone.utc).timestamp())}')
    c = TestClient(app)
    c.cookies.set(AUTH_COOKIE_NAME, legacy_token)
    assert c.get('/api/v1/auth/me').status_code == 200
