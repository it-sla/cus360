from datetime import date
import uuid
def test_queue_run_and_credentials_not_exposed(client):
    r=client.post('/api/v1/crm-sync/manifests',json={'date_from':'2026-07-14','date_to':'2026-07-15'});assert r.status_code==202;data=r.json();assert data['status']=='queued';assert 'password' not in str(data).lower();assert client.get(f"/api/v1/crm-sync/runs/{data['id']}").status_code==200
def test_bad_range_rejected(client):assert client.post('/api/v1/crm-sync/manifests',json={'date_from':'2026-07-15','date_to':'2026-07-14'}).status_code==422
def test_mawb_and_quality_apis(client):
    assert client.get('/api/v1/mawbs').status_code==200;assert client.get('/api/v1/data-quality/issues').status_code==200
def test_crm_status_is_boolean_only_and_secret_free(client):
    data=client.get('/api/v1/crm-sync/status').json();assert {'enabled','base_url_configured','login_url_configured','credentials_configured','export_list_configured','import_list_configured','http_connector_available'}<=data.keys();rendered=str(data).lower();assert 'password' not in rendered;assert 'username' not in rendered;assert 'http://' not in rendered;assert 'cookie' not in rendered
def test_crm_status_includes_safe_staff_readiness(client):
    data=client.get('/api/v1/crm-sync/status').json();assert isinstance(data['worker_running'],bool);assert data['import_live_enabled'] is True;assert isinstance(data['safe_causes'],list)
def test_single_export_reference_accepts_only_allowlisted_url(client,monkeypatch):
    from app import main
    monkeypatch.setattr(main.settings,'crm_allowed_hosts','crm.local');monkeypatch.setattr(main.settings,'crm_scraper_enabled',True);monkeypatch.setattr(main.settings,'crm_base_url','https://crm.local');monkeypatch.setattr(main.settings,'crm_login_url','https://crm.local/login');monkeypatch.setattr(main.settings,'crm_export_manifest_list_url','https://crm.local/list');monkeypatch.setattr(main.settings,'crm_export_manifest_detail_url_template','https://crm.local/detail?ID={id}');monkeypatch.setattr(main.settings,'crm_username',main.settings.crm_username.__class__('user'));monkeypatch.setattr(main.settings,'crm_password',main.settings.crm_password.__class__('pass'))
    response=client.post('/api/v1/crm-sync/export-record',json={'record_reference':'https://crm.local/S_MenifestPreviewImport.aspx?ID=338','dry_run':True});assert response.status_code==202;assert response.json()['requested_mawb']=='ID:338';assert response.json()['dry_run'] is True
    assert client.post('/api/v1/crm-sync/export-record',json={'record_reference':'https://evil.example/detail?ID=338','dry_run':True}).status_code==422
