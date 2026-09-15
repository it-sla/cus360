from pathlib import Path
import httpx,pytest
from app.crm_connector import *
FIX=Path(__file__).parent/'fixtures'
LOGIN=(FIX/'crm_webforms_login.html').read_text()
def test_login_form_and_hidden_fields():
    form=parse_login_form(LOGIN,'http://crm.local/');assert form.action=='http://crm.local/Account/Login.aspx';assert form.username_name=='ctl00$Main$txtUser';assert form.password_name=='ctl00$Main$txtPass';assert set(form.hidden)>={'__VIEWSTATE','__VIEWSTATEGENERATOR','__EVENTVALIDATION'}
def test_postback_payload_refreshes_hidden_fields():
    data=webforms_payload(LOGIN,{'date':'07/15/2026'},'ctl00$Main$Show');assert data['__EVENTTARGET']=='ctl00$Main$Show';assert data['date']=='07/15/2026';assert '__VIEWSTATE' in data
def test_ambiguous_login_form_stops_safely():
    html='<form><input name="a"><input name="b"><input type="password" name="p"></form>'
    with pytest.raises(LoginFormError) as error:parse_login_form(html,'http://crm.local/')
    assert set(error.value.input_names)=={'a','b','p'}
def test_login_page_and_session_expiry_detection():assert looks_like_login(LOGIN,'http://crm.local/');assert not looks_like_login((FIX/'crm_manifest_list.html').read_text(),'http://crm.local/list')
def test_http_login_success_and_failure(monkeypatch):
    from app import crm_connector as module
    monkeypatch.setattr(module.settings,'crm_scraper_enabled',True);monkeypatch.setattr(module.settings,'crm_base_url','http://crm.local/');monkeypatch.setattr(module.settings,'crm_login_url','http://crm.local/');monkeypatch.setattr(module.settings,'crm_export_manifest_list_url','http://crm.local/export');monkeypatch.setattr(module.settings,'crm_allowed_hosts','crm.local');monkeypatch.setattr(module.settings,'crm_username',module.settings.crm_username.__class__('user'));monkeypatch.setattr(module.settings,'crm_password',module.settings.crm_password.__class__('pass'))
    listing=(FIX/'crm_manifest_list.html').read_text()
    def handler(request):
        if request.method=='GET' and request.url.path=='/':return httpx.Response(200,text=LOGIN)
        if request.method=='POST':return httpx.Response(302,headers={'location':'/export'})
        return httpx.Response(200,text=listing)
    connector=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True));assert connector.login() is True;connector.close()
    def failure(request):return httpx.Response(200,text=LOGIN)
    connector=CrmConnector(httpx.Client(transport=httpx.MockTransport(failure),follow_redirects=True))
    with pytest.raises(ConnectorError,match='login failed'):connector.login()
    connector.close()
