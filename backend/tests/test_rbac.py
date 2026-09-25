"""RBAC matrix: super_admin (full CRUD) / admin (read-only, everything) /
sales_lead (read-only, all AEs, no Profitability) / ae (own customers only, no
Profitability, no pipeline history). See ROLE.md for the target model and
auth.access_guard / auth.get_ae_scope for the enforcement mechanism.
"""
import uuid
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import AccountExecutive, Company, User
from app.auth import hash_password
from sqlalchemy import select


def _login_as(role: str, ae_code: str | None = None) -> TestClient:
    db = SessionLocal()
    email = f'test-{role}-{uuid.uuid4().hex[:8]}@customer360.test'
    user = User(email=email, display_name=f'Test {role}', role=role, ae_code=ae_code,
                password_hash=hash_password('test-password-not-real'), is_active=True)
    db.add(user); db.commit(); db.close()
    c = TestClient(app)
    resp = c.post('/api/v1/auth/login', json={'email': email, 'password': 'test-password-not-real'})
    assert resp.status_code == 200, resp.text
    return c


@pytest.fixture(scope='module')
def ae_code():
    db = SessionLocal()
    code = f'TST{uuid.uuid4().hex[:5].upper()}'
    db.add(AccountExecutive(ae_code=code, display_name='Test AE', is_active=True))
    db.commit(); db.close()
    return code


@pytest.fixture(scope='module')
def other_ae_code():
    db = SessionLocal()
    code = f'OTH{uuid.uuid4().hex[:5].upper()}'
    db.add(AccountExecutive(ae_code=code, display_name='Other AE', is_active=True))
    db.commit(); db.close()
    return code


@pytest.fixture(scope='module')
def owned_company(client, ae_code):
    """A company assigned to `ae_code`, created via the super_admin `client` fixture."""
    r = client.post('/api/v1/companies', json={'icris_number': f'RBAC-{uuid.uuid4().hex[:8]}', 'company_name': 'RBAC Owned Co'})
    assert r.status_code == 201, r.text
    comp = r.json()
    assign = client.post(f"/api/v1/companies/{comp['id']}/assign-ae", json={'ae_code': ae_code})
    assert assign.status_code == 200, assign.text
    return comp


@pytest.fixture(scope='module')
def other_company(client, other_ae_code):
    r = client.post('/api/v1/companies', json={'icris_number': f'RBAC-OTH-{uuid.uuid4().hex[:8]}', 'company_name': 'RBAC Other Co'})
    assert r.status_code == 201, r.text
    comp = r.json()
    assign = client.post(f"/api/v1/companies/{comp['id']}/assign-ae", json={'ae_code': other_ae_code})
    assert assign.status_code == 200, assign.text
    return comp


@pytest.fixture(scope='module')
def ae_client(ae_code):
    return _login_as('ae', ae_code)


@pytest.fixture(scope='module')
def admin_client():
    return _login_as('admin')


@pytest.fixture(scope='module')
def sales_lead_client():
    return _login_as('sales_lead')


# --- Anonymous: everything requires a session now ------------------------------------

@pytest.mark.parametrize('method,path', [
    ('get', '/api/v1/companies'),
    ('get', '/api/v1/shipments/stats'),
    ('get', '/api/v1/search?q=x'),
    ('get', '/api/v1/account-executives'),
    ('post', '/api/v1/companies'),
])
def test_anonymous_is_401(method, path):
    c = TestClient(app)
    resp = c.post(path, json={}) if method == 'post' else c.get(path)
    assert resp.status_code == 401


# --- admin is read-only everywhere -----------------------------------------------------

def test_admin_get_ok_but_write_forbidden(admin_client, owned_company):
    assert admin_client.get('/api/v1/companies').status_code == 200
    r = admin_client.patch(f"/api/v1/companies/{owned_company['id']}", json={'notes': 'nope'})
    assert r.status_code == 403
    r = admin_client.post('/api/v1/companies', json={'icris_number': f'X-{uuid.uuid4().hex[:6]}', 'company_name': 'X'})
    assert r.status_code == 403


def test_admin_own_notification_state_still_writable(admin_client):
    assert admin_client.post('/api/v1/notifications/mark-all-seen').status_code == 200


# --- Profitability: admin yes, sales_lead/ae no -----------------------------------------

@pytest.mark.parametrize('path', [
    '/api/v1/analytics/customer-profitability',
    '/api/v1/mawbs/pnl-summary?manifest_date_from=2026-01-01&manifest_date_to=2026-12-31',
])
def test_profitability_role_matrix(admin_client, sales_lead_client, ae_client, path):
    assert admin_client.get(path).status_code == 200
    assert sales_lead_client.get(path).status_code == 403
    assert ae_client.get(path).status_code == 403


def test_mawbs_list_strips_pnl_fields_for_non_profit_roles(sales_lead_client, admin_client):
    sl = sales_lead_client.get('/api/v1/mawbs').json()
    for item in sl['items']:
        assert not any(k.startswith('pnl_') for k in item)
    ad = admin_client.get('/api/v1/mawbs').json()
    if ad['items']:
        assert any(k.startswith('pnl_') for k in ad['items'][0])


# --- Pipeline history / date-events: admin + sales_lead yes, ae no ----------------------

@pytest.mark.parametrize('path', ['/api/v1/pipeline/history', '/api/v1/pipeline/date-events'])
def test_pipeline_history_role_matrix(admin_client, sales_lead_client, ae_client, path):
    assert admin_client.get(path).status_code == 200
    assert sales_lead_client.get(path).status_code == 200
    assert ae_client.get(path).status_code == 403


# --- ae scoping: own company visible, another AE's company is 404, not 403 -------------

def test_ae_sees_own_company_not_others(ae_client, owned_company, other_company):
    assert ae_client.get(f"/api/v1/companies/{owned_company['id']}").status_code == 200
    assert ae_client.get(f"/api/v1/companies/{other_company['id']}").status_code == 404


def test_ae_company_list_excludes_other_ae_rows(ae_client, owned_company, other_company):
    ids = {c['company_id'] for c in ae_client.get('/api/v1/companies', params={'limit': 200}).json()['items']}
    assert owned_company['id'] in ids
    assert other_company['id'] not in ids


# --- ae write scope: can edit own company's contact info, not another's, not status ----

def test_ae_can_edit_own_company_contact_fields(ae_client, owned_company):
    r = ae_client.patch(f"/api/v1/companies/{owned_company['id']}", json={'phone': '111-222-3333'})
    assert r.status_code == 200
    assert r.json()['phone'] == '111-222-3333'


def test_ae_cannot_edit_other_ae_company(ae_client, other_company):
    r = ae_client.patch(f"/api/v1/companies/{other_company['id']}", json={'phone': '000'})
    assert r.status_code == 404


def test_ae_cannot_change_own_company_status(ae_client, owned_company):
    r = ae_client.patch(f"/api/v1/companies/{owned_company['id']}", json={'status': 'archived'})
    assert r.status_code == 403


def test_sales_lead_can_edit_any_company(sales_lead_client, owned_company):
    r = sales_lead_client.patch(f"/api/v1/companies/{owned_company['id']}", json={'notes': 'sales lead edit'})
    assert r.status_code == 200


# --- super_admin-only writes: account-executives CRUD, assign-ae -----------------------

def test_ae_roster_crud_is_super_admin_only(admin_client, sales_lead_client, ae_client):
    body = {'ae_code': f'NEW{uuid.uuid4().hex[:5].upper()}', 'display_name': 'Nope'}
    assert admin_client.post('/api/v1/account-executives', json=body).status_code == 403
    assert sales_lead_client.post('/api/v1/account-executives', json=body).status_code == 403
    assert ae_client.post('/api/v1/account-executives', json=body).status_code == 403


def test_assign_ae_is_super_admin_only(admin_client, sales_lead_client, owned_company, ae_code):
    body = {'ae_code': ae_code}
    assert admin_client.post(f"/api/v1/companies/{owned_company['id']}/assign-ae", json=body).status_code == 403
    assert sales_lead_client.post(f"/api/v1/companies/{owned_company['id']}/assign-ae", json=body).status_code == 403


# --- Leaderboard: ae is always forced to this_month, but sees the full board -----------

def test_ae_leaderboard_ignores_requested_timeframe(ae_client):
    r = ae_client.get('/api/v1/leaderboard', params={'timeframe': 'last_month'})
    assert r.status_code == 200
    body = r.json()
    from datetime import date
    today = date.today()
    assert body['period']['start'].startswith(f'{today.year:04d}-{today.month:02d}')


def test_sales_lead_leaderboard_can_pick_timeframe(sales_lead_client):
    r = sales_lead_client.get('/api/v1/leaderboard', params={'timeframe': 'last_month'})
    assert r.status_code == 200
