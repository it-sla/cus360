from pydantic import SecretStr
from app.core import Settings
def configured(**extra):
    values={'crm_scraper_enabled':True,'crm_base_url':'http://crm.local/','crm_login_url':'http://crm.local/login','crm_export_manifest_list_url':'http://crm.local/export','crm_export_manifest_detail_url_template':'http://crm.local/export?id={id}','crm_import_manifest_list_url':'http://crm.local/import','crm_import_manifest_detail_url_template':'','crm_username':'service-user','crm_password':'private-password','crm_allowed_hosts':' crm.local, CRM2.local ','crm_headless':'true','crm_request_delay_ms':'800','crm_sync_max_concurrency':'1'};values.update(extra);return Settings(_env_file=None,**values)
def test_enabled_settings_types_and_blank_import_detail():
    s=configured();assert s.crm_scraper_enabled is True;assert s.crm_headless is True;assert s.crm_request_delay_ms==800;assert s.crm_sync_max_concurrency==1;assert s.crm_import_manifest_detail_url_template==''
def test_allowed_hosts_are_trimmed_and_casefolded():assert configured().allowed_hosts=={'crm.local','crm2.local'}
def test_secret_fields_are_hidden_from_repr():
    s=configured();rendered=repr(s);assert 'service-user' not in rendered;assert 'private-password' not in rendered;assert isinstance(s.crm_password,SecretStr)
def test_disabled_state():assert Settings(_env_file=None,crm_scraper_enabled=False).crm_scraper_enabled is False
