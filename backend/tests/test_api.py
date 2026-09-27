import uuid
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import AccountExecutive, User
from app.auth import hash_password
def test_health(client): assert client.get('/health').json()=={'status':'ok'}
def test_create_company_and_duplicate(client):
    value=uuid.uuid4().hex[:8];payload={'icris_number':f'  test-{value}  ','company_name':'  Test Cargo Co.  '}
    r=client.post('/api/v1/companies',json=payload);assert r.status_code==201;data=r.json();assert data['icris_number']==f'TEST-{value.upper()}';assert data['company_name']=='Test Cargo Co.'
    assert client.post('/api/v1/companies',json=payload).status_code==409
def test_create_unmatched_shipment_and_package(client):
    suffix=uuid.uuid4().hex[:8];r=client.post('/api/v1/shipments',json={'shipment_number':f'TEST-AWB-{suffix}'});assert r.status_code==201;s=r.json();assert s['shipment_date'] is None and s['match_status']=='unmatched'
    p=client.post(f"/api/v1/shipments/{s['id']}/packages",json={'package_id':f'TEST-PKG-{suffix}','piece_number':1});assert p.status_code==201;assert p.json()['package_weight'] is None
    detail=client.get(f"/api/v1/shipments/{s['id']}").json();assert len(detail['packages'])==1
    byid=client.get(f"/api/v1/packages/by-package-id/TEST-PKG-{suffix}");assert byid.status_code==200;assert byid.json()['shipment']['id']==s['id']
def test_search_exact_icris(client):
    suffix=uuid.uuid4().hex[:8];client.post('/api/v1/companies',json={'icris_number':f'SEARCH-{suffix}','company_name':'Searchable Cargo'})
    data=client.get('/api/v1/search',params={'q':f'SEARCH-{suffix}'}).json()['items'];assert data[0]['result_type']=='company'
def test_analytics_are_unit_safe(client):
    assert client.get('/api/v1/analytics/weights-by-unit').status_code==200
    assert client.get('/api/v1/analytics/values-by-currency').status_code==200
    # removed: it ignored AE scope, so an 'ae' login could download every customer
    assert client.get('/api/v1/analytics/customers/export.csv').status_code==404
def test_business_dashboard_is_decision_ready(client):
    response=client.get('/api/v1/analytics/dashboard');assert response.status_code==200;data=response.json()
    assert {'overview','shipment_trend','top_customers','destinations','bill_types','quality_issues','match_status','recent_mawbs'}<=data.keys()
    assert {'company_match_rate','open_quality_issues','last_crm_sync'}<=data['overview'].keys()

def test_company_picker_search_matches_master_list_only(client):
    """Backs the CompanyPicker used in Revenue Analytics and Data Quality: a name search
    with status=official must return the company master (no shipments required), and
    must exclude provisional companies — those are only reachable with status=provisional."""
    suffix=uuid.uuid4().hex[:8]
    official=client.post('/api/v1/companies',json={'icris_number':f'PICK-OFF-{suffix}','company_name':f'Picker Official {suffix}'})
    assert official.status_code==201

    db=SessionLocal()
    try:
        from app.utils import normalize_icris,normalize_name
        from app.models import Company
        icris=f'PICK-PROV-{suffix}'
        prov=Company(icris_number=normalize_icris(icris),company_name=f'Picker Provisional {suffix}',
                     normalized_name=normalize_name(f'Picker Provisional {suffix}'),is_provisional=True,source='crm_sync')
        db.add(prov);db.commit()
    finally:
        db.close()

    r=client.get('/api/v1/companies',params={'q':f'Picker','status':'official'})
    assert r.status_code==200
    names={i['company_name'] for i in r.json()['items']}
    assert f'Picker Official {suffix}' in names
    assert f'Picker Provisional {suffix}' not in names

def test_company_picker_is_ae_scoped():
    """An 'ae' login only gets suggestions for their own customers — same scoping as
    every other company-facing endpoint (auth.get_ae_scope)."""
    db=SessionLocal()
    try:
        suffix=uuid.uuid4().hex[:8]
        own_code=f'PIK{suffix[:5].upper()}';other_code=f'OTH{suffix[:5].upper()}'
        db.add(AccountExecutive(ae_code=own_code,display_name='Picker AE',is_active=True))
        db.add(AccountExecutive(ae_code=other_code,display_name='Other AE',is_active=True))
        db.commit()

        from app.utils import normalize_icris,normalize_name
        from app.models import Company
        own_name=f'Scoped Own {suffix}';other_name=f'Scoped Other {suffix}'
        db.add(Company(icris_number=normalize_icris(f'SCOPE-OWN-{suffix}'),company_name=own_name,
                        normalized_name=normalize_name(own_name),assigned_ae_code=own_code))
        db.add(Company(icris_number=normalize_icris(f'SCOPE-OTHER-{suffix}'),company_name=other_name,
                        normalized_name=normalize_name(other_name),assigned_ae_code=other_code))
        db.commit()

        email=f'test-picker-ae-{suffix}@customer360.test'
        db.add(User(email=email,display_name='Picker AE User',role='ae',ae_code=own_code,
                     password_hash=hash_password('test-password-not-real'),is_active=True))
        db.commit()
    finally:
        db.close()

    ae_client=TestClient(app)
    login=ae_client.post('/api/v1/auth/login',json={'email':email,'password':'test-password-not-real'})
    assert login.status_code==200

    r=ae_client.get('/api/v1/companies',params={'q':'Scoped','status':'official'})
    assert r.status_code==200
    names={i['company_name'] for i in r.json()['items']}
    assert own_name in names
    assert other_name not in names
