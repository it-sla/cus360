"""Self-service registration → pending → super admin approves (picks role) or rejects
(deletes). See main.py auth_register, admin_approve_user, admin_reject_registration."""
import uuid
from fastapi.testclient import TestClient
from app.main import app
from tests.test_user_security import PASSWORD, _make_user, _login, super_admin_client  # noqa: F401

REG_PASSWORD = 'reg-password-123'


def _register() -> str:
    email = f'test-reg-{uuid.uuid4().hex[:10]}@customer360.test'
    r = TestClient(app).post('/api/v1/auth/register', json={'email': email, 'display_name': 'Reg Test', 'password': REG_PASSWORD})
    assert r.status_code == 201, r.text
    return email


def _pending_id(admin: TestClient, email: str) -> str:
    items = admin.get('/api/v1/admin/users', params={'pending': True, 'q': email}).json()['items']
    assert len(items) == 1 and items[0]['pending_approval'] is True
    return items[0]['id']


def test_pending_user_cannot_log_in_and_register_sets_no_session():
    email = _register()
    c = TestClient(app)
    r = c.post('/api/v1/auth/login', json={'email': email, 'password': REG_PASSWORD})
    assert r.status_code == 403 and 'awaiting' in r.json()['detail']
    assert c.get('/api/v1/auth/me').status_code == 401
    # Wrong password must not reveal the pending state.
    assert TestClient(app).post('/api/v1/auth/login', json={'email': email, 'password': 'wrong-pass-1'}).status_code == 401


def test_duplicate_and_short_password_rejected():
    email = _register()
    assert TestClient(app).post('/api/v1/auth/register', json={'email': email.upper(), 'display_name': 'X', 'password': REG_PASSWORD}).status_code == 409
    assert TestClient(app).post('/api/v1/auth/register', json={'email': 'short@customer360.test', 'display_name': 'X', 'password': 'short'}).status_code == 422


def test_approve_sets_role_and_allows_login(super_admin_client):
    email = _register()
    uid = _pending_id(super_admin_client, email)
    assert super_admin_client.post(f'/api/v1/admin/users/{uid}/approve', json={'role': 'ae', 'ae_code': 'NOPE-XYZ'}).status_code == 422
    r = super_admin_client.post(f'/api/v1/admin/users/{uid}/approve', json={'role': 'sales_lead'})
    assert r.status_code == 200 and r.json()['role'] == 'sales_lead' and r.json()['is_active'] and not r.json()['pending_approval']
    assert _login(email, REG_PASSWORD).get('/api/v1/auth/me').json()['role'] == 'sales_lead'
    assert super_admin_client.post(f'/api/v1/admin/users/{uid}/approve', json={'role': 'user'}).status_code == 404


def test_reject_deletes_and_email_can_register_again(super_admin_client):
    email = _register()
    uid = _pending_id(super_admin_client, email)
    assert super_admin_client.delete(f'/api/v1/admin/users/{uid}/registration').status_code == 200
    assert super_admin_client.get('/api/v1/admin/users', params={'q': email}).json()['total'] == 0
    assert TestClient(app).post('/api/v1/auth/register', json={'email': email, 'display_name': 'Again', 'password': REG_PASSWORD}).status_code == 201


def test_reactivate_cannot_bypass_approval(super_admin_client):
    uid = _pending_id(super_admin_client, _register())
    assert super_admin_client.patch(f'/api/v1/admin/users/{uid}', json={'is_active': True}).status_code == 422


def test_approve_and_reject_require_super_admin(super_admin_client):
    uid = _pending_id(super_admin_client, _register())
    admin_email, _ = _make_user('admin')
    admin = _login(admin_email, PASSWORD)
    assert admin.post(f'/api/v1/admin/users/{uid}/approve', json={'role': 'user'}).status_code == 403
    assert admin.delete(f'/api/v1/admin/users/{uid}/registration').status_code == 403


def test_rejecting_an_active_user_is_404(super_admin_client):
    _, uid = _make_user('user')
    assert super_admin_client.delete(f'/api/v1/admin/users/{uid}/registration').status_code == 404
