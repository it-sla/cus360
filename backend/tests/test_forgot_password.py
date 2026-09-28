"""Self-service password reset. Always the same generic response, regardless of
whether the email exists, is pending approval, or is deactivated — see
main.py auth_forgot_password. Reuses the same one-time setup-token link an admin
can issue by hand (issue_setup_link), delivered by email instead of copy/paste."""
from urllib.parse import urlparse, parse_qs
from fastapi.testclient import TestClient
import app.main as main
from app.db import SessionLocal
from app.models import User
from tests.test_user_security import PASSWORD, _make_user, _login  # noqa: F401


def _forgot_password(email: str) -> dict:
    r = TestClient(main.app).post('/api/v1/auth/forgot-password', json={'email': email})
    assert r.status_code == 200
    return r.json()


def test_response_is_always_generic(monkeypatch):
    sent = []
    monkeypatch.setattr(main, 'send_password_reset_email', lambda to, link: sent.append((to, link)))

    email, _ = _make_user('user')
    assert _forgot_password(email) == {'status': 'ok'}
    assert _forgot_password('no-such-user@customer360.test') == {'status': 'ok'}
    assert len(sent) == 1 and sent[0][0] == email


def test_link_actually_resets_the_password(monkeypatch):
    sent = []
    monkeypatch.setattr(main, 'send_password_reset_email', lambda to, link: sent.append((to, link)))

    email, user_id = _make_user('user')
    _forgot_password(email)
    token = parse_qs(urlparse(sent[0][1]).query)['token'][0]

    r = TestClient(main.app).post('/api/v1/auth/set-password', json={'token': token, 'password': 'brand-new-pass-1'})
    assert r.status_code == 200

    assert TestClient(main.app).post('/api/v1/auth/login', json={'email': email, 'password': PASSWORD}).status_code == 401
    assert _login(email, 'brand-new-pass-1').get('/api/v1/auth/me').status_code == 200


def test_pending_and_inactive_accounts_get_no_link(monkeypatch):
    sent = []
    monkeypatch.setattr(main, 'send_password_reset_email', lambda to, link: sent.append((to, link)))

    db = SessionLocal()
    pending_email, _ = _make_user('user')
    u = db.scalar(main.select(User).where(User.email == pending_email))
    u.pending_approval = True
    db.commit()

    inactive_email, inactive_id = _make_user('user')
    u2 = db.get(User, inactive_id)
    u2.is_active = False
    db.commit()
    db.close()

    _forgot_password(pending_email)
    _forgot_password(inactive_email)
    assert sent == []
