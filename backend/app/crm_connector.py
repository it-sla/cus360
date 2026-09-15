"""Allowlisted, read-only HTTP session manager for legacy ASP.NET CRM."""
import random,time
from dataclasses import dataclass
from urllib.parse import urljoin,urlparse
import httpx
from bs4 import BeautifulSoup
from .core import settings

HIDDEN_NAMES={'__VIEWSTATE','__VIEWSTATEGENERATOR','__EVENTVALIDATION','__EVENTTARGET','__EVENTARGUMENT'}
RETRYABLE_STATUS={429,500,502,503,504}
class ConnectorError(RuntimeError):code='crm_manifest_unavailable';retryable=False
class RetryableConnectorError(ConnectorError):retryable=True
class AuthenticationError(RetryableConnectorError):code='crm_login_failed'
class SessionExpired(AuthenticationError):code='crm_session_expired'
class UnexpectedRedirect(ConnectorError):code='crm_unexpected_redirect'
class LoginFormError(ConnectorError):
    code='crm_login_failed'
    def __init__(self,message,input_names=None):super().__init__(message);self.input_names=input_names or []
@dataclass
class LoginForm:
    action:str;hidden:dict[str,str];username_name:str;password_name:str;submit_name:str|None;submit_value:str|None

def parse_hidden_fields(html):
    soup=BeautifulSoup(html,'html.parser');return {x.get('name'):x.get('value','') for x in soup.select('input[type=hidden][name]')}
def webforms_payload(html,fields=None,event_target='',event_argument=''):
    payload=parse_hidden_fields(html);payload.update(fields or {})
    if event_target or '__EVENTTARGET' in payload:payload['__EVENTTARGET']=event_target
    if event_argument or '__EVENTARGUMENT' in payload:payload['__EVENTARGUMENT']=event_argument
    return payload
def _label_text(soup,input_node):
    ident=input_node.get('id');label=soup.find('label',attrs={'for':ident}) if ident else None
    return label.get_text(' ',strip=True).casefold() if label else ''
def parse_login_form(html,base_url):
    soup=BeautifulSoup(html,'html.parser');form=next((f for f in soup.select('form') if f.select_one('input[type=password]')),None)
    if not form:raise LoginFormError('Login form with password control was not found')
    inputs=form.select('input[name]');names=[x.get('name','') for x in inputs if x.get('type','').lower()!='hidden'];passwords=[x for x in inputs if x.get('type','').lower()=='password']
    if len(passwords)!=1:raise LoginFormError('Could not identify one password control',names)
    password=passwords[0];candidates=[]
    for node in inputs:
        typ=node.get('type','text').lower();identity=' '.join([node.get('name',''),node.get('id',''),node.get('placeholder',''),_label_text(soup,node)]).casefold()
        if node is password or typ in {'hidden','submit','button','checkbox','radio'}:continue
        score=3 if any(k in identity for k in ('user','login','email')) else 1 if typ in ('text','email') else 0
        if score:candidates.append((score,node))
    candidates.sort(key=lambda x:x[0],reverse=True)
    if not candidates or (len(candidates)>1 and candidates[0][0]==candidates[1][0]):raise LoginFormError('Could not safely identify one username control',names)
    submits=[x for x in inputs if x.get('type','').lower() in ('submit','button')]
    submit=submits[0] if len(submits)==1 else next((x for x in submits if any(k in ' '.join([x.get('name',''),x.get('id',''),x.get('value','')]).casefold() for k in ('login','sign in','submit'))),None)
    return LoginForm(urljoin(base_url,form.get('action') or base_url),parse_hidden_fields(str(form)),candidates[0][1]['name'],password['name'],submit.get('name') if submit else None,submit.get('value','') if submit else None)
def looks_like_login(html,url=''):
    soup=BeautifulSoup(html,'html.parser');return bool(soup.select_one('input[type=password]')) or ('login' in (urlparse(url).path or '').casefold() and not soup.select('table'))

class CrmSessionManager:
    def __init__(self,client=None):
        timeout=httpx.Timeout(settings.crm_read_timeout_ms/1000,connect=settings.crm_connect_timeout_ms/1000)
        self.client=client or httpx.Client(follow_redirects=True,timeout=timeout,headers={'User-Agent':'Customer360-ReadOnly-Sync/2.0','Accept':'text/html,application/xhtml+xml'})
        self.last_html='';self.authenticated=False;self._last_request_at=0.0
    def close(self):self.client.close()
    def _validate(self,url):
        host=(urlparse(str(url)).hostname or '').casefold()
        if not host or host not in settings.allowed_hosts:raise UnexpectedRedirect(f'CRM host is not allowlisted: {host or "missing"}')
    def _validate_response(self,response):
        for prior in response.history:self._validate(prior.url)
        self._validate(response.url)
    def _throttle(self):
        wait=settings.crm_request_delay_ms/1000-(time.monotonic()-self._last_request_at)
        if wait>0:time.sleep(wait+random.uniform(0,min(.25,wait*.2)))
    def _send(self,method,url,**kwargs):
        self._validate(url);last=None
        for attempt in range(3):
            self._throttle()
            try:
                response=self.client.request(method,url,**kwargs);self._last_request_at=time.monotonic();self._validate_response(response)
                if response.status_code in RETRYABLE_STATUS:
                    last=RetryableConnectorError(f'Temporary CRM HTTP {response.status_code}')
                else:
                    response.raise_for_status();return response
            except (httpx.TimeoutException,httpx.NetworkError,httpx.RemoteProtocolError) as exc:last=RetryableConnectorError('Temporary CRM network failure')
            except httpx.HTTPStatusError as exc:raise ConnectorError(f'CRM HTTP {exc.response.status_code}') from exc
            if attempt<2:time.sleep((.25*(2**attempt))+random.uniform(0,.15))
        raise last or RetryableConnectorError('Temporary CRM request failure')
    def login(self):
        if not settings.crm_scraper_enabled:raise ConnectorError('CRM scraper is disabled')
        if not settings.credentials_configured:raise AuthenticationError('CRM credentials are not configured')
        self._validate(settings.crm_login_url);self._validate(settings.crm_export_manifest_list_url)
        page=self._send('GET',settings.crm_login_url);form=parse_login_form(page.text,str(page.url));self._validate(form.action)
        payload=dict(form.hidden);payload[form.username_name]=settings.crm_username.get_secret_value();payload[form.password_name]=settings.crm_password.get_secret_value()
        if form.submit_name:payload[form.submit_name]=form.submit_value or ''
        self._send('POST',form.action,data=payload)
        listing=self._send('GET',settings.crm_export_manifest_list_url);self.last_html=listing.text
        if looks_like_login(listing.text,str(listing.url)):raise AuthenticationError('CRM login failed')
        self.authenticated=True;return True
    def invalidate(self):
        self.client.cookies.clear();self.authenticated=False
    def request(self,method,url,**kwargs):
        if not self.authenticated:self.login()
        response=self._send(method,url,**kwargs)
        if looks_like_login(response.text,str(response.url)):
            self.invalidate();self.login();response=self._send(method,url,**kwargs)
            if looks_like_login(response.text,str(response.url)):raise SessionExpired('CRM session renewal failed')
        self.last_html=response.text;return response
    def export_list(self):return self.request('GET',settings.crm_export_manifest_list_url).text
    def import_list(self):
        if not settings.crm_import_manifest_list_url:raise ConnectorError('CRM Import list URL is not configured')
        return self.request('GET',settings.crm_import_manifest_list_url).text
    def list_range(self,direction,date_from,date_to):
        if direction=='import':return self.import_list()
        url=settings.crm_export_manifest_list_url
        html=self.export_list()
        fields={'ctl00$MainContent$txt_dateFrom':f'{date_from.month}/{date_from.day}/{date_from.year}','ctl00$MainContent$txt_DateTo':f'{date_to.month}/{date_to.day}/{date_to.year}','ctl00$MainContent$btn_Preview':'Show'}
        payload=webforms_payload(html,fields)
        response_text=self.request('POST',url,data=payload).text
        self._snapshot_list(direction,response_text)
        return response_text
    def pnl_list(self,date_from,date_to):
        if not settings.crm_pnl_url:raise ConnectorError('CRM Profit/Loss URL is not configured')
        url=settings.crm_pnl_url
        self._validate(url)
        html=self.request('GET',url).text
        fields={'ctl00$MainContent$txt_dateFrom':f'{date_from.month}/{date_from.day}/{date_from.year}','ctl00$MainContent$txt_DateTo':f'{date_to.month}/{date_to.day}/{date_to.year}','ctl00$MainContent$btn_Preview':'Show'}
        payload=webforms_payload(html,fields)
        response_text=self.request('POST',url,data=payload).text
        self._snapshot_list('pnl',response_text)
        return response_text
    def ups_list(self,date_from,date_to):
        if not settings.crm_ups_list_url:raise ConnectorError('CRM UPS list URL is not configured')
        url=settings.crm_ups_list_url
        self._validate(url)
        html=self.request('GET',url).text
        fields={'ctl00$MainContent$txt_dateFrom':f'{date_from.month}/{date_from.day}/{date_from.year}','ctl00$MainContent$txt_DateTo':f'{date_to.month}/{date_to.day}/{date_to.year}','ctl00$MainContent$btn_Preview':'Show'}
        payload=webforms_payload(html,fields)
        response_text=self.request('POST',url,data=payload).text
        self._snapshot_list('ups',response_text)
        return response_text
    def active_pipeline_list(self,date_from,date_to):
        """CRM_Activepipeline.aspx detail grid (Expected Date, Company Name, Acc No, ...).

        The page's ASP.NET control names are unverified (no login access at build time), so
        fields are auto-detected the same way parse_login_form detects username/password
        controls: two text inputs with 'date' in their name/id (from/to, in DOM order) and a
        submit control whose value reads 'Show'. If the CRM changes this markup the lookup
        raises ConnectorError rather than silently posting to the wrong field."""
        if not settings.crm_active_pipeline_url:raise ConnectorError('CRM Active Pipeline URL is not configured')
        url=settings.crm_active_pipeline_url
        self._validate(url)
        html=self.request('GET',url).text
        soup=BeautifulSoup(html,'html.parser')
        date_inputs=[x for x in soup.select('input[type=text]') if 'date' in (x.get('name','')+x.get('id','')).casefold()]
        if len(date_inputs)<2:raise ConnectorError('CRM Active Pipeline date fields were not found')
        show=next((x for x in soup.select('input[type=submit],input[type=button]') if 'show' in x.get('value','').casefold()),None)
        if not show or not show.get('name'):raise ConnectorError('CRM Active Pipeline Show button was not found')
        fields={date_inputs[0]['name']:f'{date_from.month}/{date_from.day}/{date_from.year}',date_inputs[1]['name']:f'{date_to.month}/{date_to.day}/{date_to.year}',show['name']:show.get('value','Show')}
        payload=webforms_payload(html,fields)
        response_text=self.request('POST',url,data=payload).text
        self._snapshot_list('active_pipeline',response_text)
        return response_text
    def daily_call_logs(self,date_from,date_to):
        """CRM_DairyAEList.aspx ('Daily Call Logs'). Uses the same MainContent date-field
        control names as pnl_list/ups_list (confirmed directly from a fetched page), so no
        auto-detection is needed here unlike active_pipeline_list."""
        if not settings.crm_daily_call_logs_url:raise ConnectorError('CRM Daily Call Logs URL is not configured')
        url=settings.crm_daily_call_logs_url
        self._validate(url)
        html=self.request('GET',url).text
        fields={'ctl00$MainContent$txt_dateFrom':f'{date_from.month}/{date_from.day}/{date_from.year}','ctl00$MainContent$txt_DateTo':f'{date_to.month}/{date_to.day}/{date_to.year}','ctl00$MainContent$btn_Preview':'Show'}
        payload=webforms_payload(html,fields)
        response_text=self.request('POST',url,data=payload).text
        self._snapshot_list('daily_call_logs',response_text)
        return response_text
    def ups_detail(self,record_id):
        template=settings.crm_ups_detail_url_template
        if not template:raise ConnectorError('CRM UPS detail URL is not configured')
        target=template.format(id=str(record_id))
        response=self.request('GET',target);return response.text,str(response.url)
    def _snapshot_list(self,direction,html):
        from pathlib import Path
        import datetime
        try:
            snap_dir=Path(settings.crm_snapshot_storage_path)
            if not snap_dir.exists():return
            ts=datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
            path=snap_dir/f'list_{direction}_{ts}.html'
            path.write_text(html,encoding='utf-8')
            cutoff=datetime.datetime.now()-datetime.timedelta(hours=1)
            for old in snap_dir.glob('list_*.html'):
                try:
                    if datetime.datetime.fromtimestamp(old.stat().st_mtime)<cutoff:old.unlink()
                except OSError:pass
        except Exception:pass
    def detail(self,direction,record_id,url=None):
        template=settings.crm_export_manifest_detail_url_template if direction=='export' else settings.crm_import_manifest_detail_url_template
        target=(template.format(id=str(record_id)) if template else '') or url or ''
        if not target:raise ConnectorError(f'CRM {direction} detail URL is not configured')
        response=self.request('GET',target);return response.text,str(response.url)
    def export_detail(self,record_id):return self.detail('export',record_id)
    def import_detail(self,record_id):return self.detail('import',record_id)
    def postback(self,url,html,event_target,event_argument='',fields=None):
        payload=webforms_payload(html,fields,event_target,event_argument);return self.request('POST',url,data=payload).text

CrmConnector=CrmSessionManager
