import uuid
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
