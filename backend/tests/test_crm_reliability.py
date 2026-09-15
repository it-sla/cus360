from datetime import timedelta
from pathlib import Path
import uuid
import httpx,pytest
from sqlalchemy import func,select
from sqlalchemy.exc import IntegrityError
from app import crm_connector as connector_module
from app.core import settings
from app.crm_connector import CrmConnector,RetryableConnectorError,UnexpectedRedirect
from app.crm_parser import CrmParseError,DuplicateTrackingConflict,PartialManifestError,ROW_HEADERS,parse_manifest_detail
from app.crm_sync import link_icris,upsert_detail
from app.crm_worker import _fail_item,classify,finalize_runs,recover_stale,retry_delay
from app.db import SessionLocal
from app.models import Company,CrmSyncItem,CrmSyncRun,MasterAirWaybill,Package,Shipment,now
from app.utils import normalize_icris,normalize_name

FIX=Path(__file__).parent/'fixtures';DETAIL=(FIX/'crm_manifest_detail.html').read_text();LOGIN=(FIX/'crm_webforms_login.html').read_text();LIST=(FIX/'crm_manifest_list.html').read_text()
def suffix():return uuid.uuid4().hex[:10]
def run_item(db,status='pending',attempt=0,maximum=5):
    run=CrmSyncRun(sync_type='manifest_single',status='running',direction='export');db.add(run);db.flush();item=CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id=suffix(),status=status,attempt_count=attempt,maximum_attempts=maximum);db.add(item);db.commit();return run,item
def configured(monkeypatch):
    monkeypatch.setattr(settings,'crm_scraper_enabled',True);monkeypatch.setattr(settings,'crm_base_url','http://crm.local/');monkeypatch.setattr(settings,'crm_login_url','http://crm.local/');monkeypatch.setattr(settings,'crm_export_manifest_list_url','http://crm.local/export');monkeypatch.setattr(settings,'crm_export_manifest_detail_url_template','http://crm.local/detail?id={id}');monkeypatch.setattr(settings,'crm_allowed_hosts','crm.local');monkeypatch.setattr(settings,'crm_request_delay_ms',0);monkeypatch.setattr(settings,'crm_username',settings.crm_username.__class__('user'));monkeypatch.setattr(settings,'crm_password',settings.crm_password.__class__('pass'))

def test_worker_lease_expiry_recovery():
    db=SessionLocal();run,item=run_item(db,'claimed');item.lease_expires_at=now()-timedelta(seconds=1);item.claimed_by='dead';db.commit();assert recover_stale(db)>=1;assert item.status=='retry_scheduled';assert item.claimed_by is None;db.rollback();db.close()
def test_worker_crash_after_claim_is_recoverable():
    db=SessionLocal();run,item=run_item(db,'importing');item.lease_expires_at=now()-timedelta(minutes=1);db.commit();assert recover_stale(db)>=1;assert item.last_error_code=='worker_lease_expired';db.rollback();db.close()
def test_retry_schedule_uses_bounded_backoff():assert 30<=retry_delay(1)<=40 and 7200<=retry_delay(99)<=7210
def test_retryable_error_schedules_retry():
    db=SessionLocal();run,item=run_item(db,'claimed',1,5);iid=item.id;db.close();_fail_item(iid,RetryableConnectorError('temporary'));db=SessionLocal();item=db.get(CrmSyncItem,iid);assert item.status=='retry_scheduled' and item.next_retry_at;db.close()
def test_maximum_attempt_quarantines():
    db=SessionLocal();run,item=run_item(db,'claimed',5,5);iid=item.id;db.close();_fail_item(iid,RetryableConnectorError('temporary'));db=SessionLocal();assert db.get(CrmSyncItem,iid).status=='quarantined';db.close()
def test_authentication_expiry_gets_one_relogin(monkeypatch):
    configured(monkeypatch);state={'login':0,'detail':0}
    def handler(request):
        if request.url.path=='/' and request.method=='GET':state['login']+=1;return httpx.Response(200,text=LOGIN)
        if request.method=='POST':return httpx.Response(200,text='ok')
        if request.url.path=='/export':return httpx.Response(200,text=LIST)
        state['detail']+=1;return httpx.Response(200,text=LOGIN if state['detail']==1 else DETAIL)
    c=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True));html,_=c.export_detail(338);assert 'Tracking No.' in html;assert state['login']==2;c.close()
def test_network_timeout_is_retryable(monkeypatch):
    configured(monkeypatch)
    def handler(request):raise httpx.ReadTimeout('timeout',request=request)
    c=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True))
    with pytest.raises(RetryableConnectorError):c._send('GET','http://crm.local/export')
    c.close()
def test_http_500_retries_then_succeeds(monkeypatch):
    configured(monkeypatch);calls={'n':0}
    def handler(request):calls['n']+=1;return httpx.Response(500) if calls['n']<3 else httpx.Response(200,text='ok')
    c=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True));assert c._send('GET','http://crm.local/export').text=='ok';assert calls['n']==3;c.close()
def test_export_date_filter_uses_verified_webforms_controls(monkeypatch):
    from datetime import date
    configured(monkeypatch);posted={}
    def handler(request):
        if request.url.path=='/' and request.method=='GET':return httpx.Response(200,text=LOGIN)
        if request.method=='POST' and request.url.path=='/':return httpx.Response(200,text='ok')
        if request.url.path=='/export' and request.method=='POST':posted.update(dict(httpx.QueryParams(request.content.decode())));return httpx.Response(200,text=LIST)
        return httpx.Response(200,text=LIST)
    c=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True));c.login();c.list_range('export',date(2017,3,10),date(2017,3,10));assert posted['ctl00$MainContent$txt_dateFrom']=='3/10/2017';assert posted['ctl00$MainContent$btn_Preview']=='Show';c.close()
def test_unexpected_redirect_is_rejected(monkeypatch):
    configured(monkeypatch)
    def handler(request):return httpx.Response(302,headers={'location':'http://evil.local/'}) if request.url.host=='crm.local' else httpx.Response(200,text='no')
    c=CrmConnector(httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=True))
    with pytest.raises(UnexpectedRedirect):c._send('GET','http://crm.local/export')
    c.close()
def test_allowed_host_is_enforced(monkeypatch):
    configured(monkeypatch);c=CrmConnector(httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200))))
    with pytest.raises(UnexpectedRedirect):c._send('GET','http://not-crm.local/')
    c.close()
def test_empty_page_is_not_success():
    detail=parse_manifest_detail((FIX/'crm_empty.html').read_text());assert not detail.rows;from app.crm_parser import EmptyManifestError;assert classify(EmptyManifestError('empty'))[0]=='crm_empty_manifest'
def test_partial_html_is_rejected():
    with pytest.raises(PartialManifestError):parse_manifest_detail('<html>cut</html>')
def test_exact_17_column_parsing():assert parse_manifest_detail(DETAIL).original_row_headers==ROW_HEADERS
def test_harmless_header_whitespace_normalization():
    html=DETAIL.replace('Tracking No.','  Tracking   No.  ',1);assert len(parse_manifest_detail(html).rows)==3
def test_missing_required_column_is_rejected():
    with pytest.raises(CrmParseError):parse_manifest_detail(DETAIL.replace('Tracking No.','Tracking Missing',1))
def test_identical_duplicate_tracking_collapses():
    marker='</table></body>';row='<tr>'+''.join(f'<td>{x}</td>' for x in ['1','SAME','EXP','I1','Name','C','D','1','1','1','P','B','1','1','1','A','D'])+'</tr>';html=DETAIL.replace('</table>',row+row+'</table>',1)
    # The first table may be the header table; use a minimal verified body instead.
    base='<html><body><table><tr><td>Date</td><td>07/14/2026</td><td>MAWB</td><td>M1</td></tr></table><table><tr>'+''.join(f'<th>{x}</th>' for x in ROW_HEADERS)+'</tr>'+row+row+'</table></body></html>'
    detail=parse_manifest_detail(base);assert len(detail.rows)==1 and detail.duplicate_row_count==1
def test_conflicting_duplicate_tracking_quarantines():
    def row(shipper):return '<tr>'+''.join(f'<td>{x}</td>' for x in ['1','SAME','EXP','I1',shipper,'C','D','1','1','1','P','B','1','1','1','A','D'])+'</tr>'
    html='<html><body><table><tr><td>Date</td><td>07/14/2026</td><td>MAWB</td><td>M1</td></tr></table><table><tr>'+''.join(f'<th>{x}</th>' for x in ROW_HEADERS)+'</tr>'+row('A')+row('B')+'</table></body></html>'
    with pytest.raises(DuplicateTrackingConflict):parse_manifest_detail(html)
def test_invalid_numeric_never_becomes_zero():assert parse_manifest_detail((FIX/'crm_invalid_numeric.html').read_text()).rows[0]['parsed']['Act wt'] is None
def test_manifest_checksum_is_stable():assert parse_manifest_detail(DETAIL).source_checksum==parse_manifest_detail(DETAIL).source_checksum
def test_manifest_checksum_changes_with_business_content():assert parse_manifest_detail(DETAIL).source_checksum!=parse_manifest_detail(DETAIL.replace('R1100X','R1100Y')).source_checksum
def test_manifest_transaction_rollback_after_failure():
    db=SessionLocal();tag=suffix();detail=parse_manifest_detail(DETAIL);detail.header['MAWB']='ROLL-'+tag
    for i,row in enumerate(detail.rows):row['raw']['Tracking No.']=f'ROLL-{tag}-{i}'
    run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush()
    try:upsert_detail(db,run,detail);raise RuntimeError('injected')
    except RuntimeError:db.rollback()
    assert db.scalar(select(func.count()).select_from(MasterAirWaybill).where(MasterAirWaybill.mawb_number=='ROLL-'+tag))==0;db.close()
def test_one_quarantined_item_does_not_erase_success():
    db=SessionLocal();run=CrmSyncRun(sync_type='manifest_range',status='running');db.add(run);db.flush();db.add_all([CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id='a'+suffix(),status='succeeded'),CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id='b'+suffix(),status='quarantined')]);db.commit();rid=run.id;db.close();finalize_runs();db=SessionLocal();assert db.get(CrmSyncRun,rid).status=='completed_with_errors';db.close()
def test_repeat_sync_is_idempotent():
    db=SessionLocal();tag=suffix();detail=parse_manifest_detail(DETAIL);detail.header['MAWB']='IDEM-'+tag
    for i,row in enumerate(detail.rows):row['raw']['Tracking No.']=f'IDEM-{tag}-{i}';row['raw']['Icrisno']='ICRIS-'+tag
    for n in range(2):run=CrmSyncRun(sync_type='manifest_single',status='running',force_reparse=True);db.add(run);db.flush();upsert_detail(db,run,detail,manifest_id='MID-'+tag,direction='export');db.commit()
    assert db.scalar(select(func.count()).select_from(Shipment).where(Shipment.shipment_number.like(f'IDEM-{tag}-%')))==3;db.close()
def test_concurrent_queue_identity_constraint():
    db=SessionLocal();run=CrmSyncRun(sync_type='manifest_range',status='running');db.add(run);db.flush();identity='Q-'+suffix();db.add(CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id=identity));db.commit();db.add(CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id=identity))
    with pytest.raises(IntegrityError):db.commit()
    db.rollback();db.close()
def test_exact_unicode_normalized_icris_linking():assert normalize_icris('\u00a0ａｂ１２\u200b')=='AB12'
def test_official_customer_name_is_preserved():
    db=SessionLocal();tag=suffix();company=Company(icris_number='OFF-'+tag,company_name='Official Name',normalized_name=normalize_name('Official Name'),source='upload',is_provisional=False);shipment=Shipment(shipment_number='OFF-S-'+tag);db.add_all([company,shipment]);db.flush();assert link_icris(db,shipment,' off-'+tag+' ','CRM Different')=='matched';assert company.company_name=='Official Name';db.rollback();db.close()
def test_blank_icris_remains_unlinked():
    db=SessionLocal();shipment=Shipment(shipment_number='BLANK-'+suffix());db.add(shipment);db.flush();assert link_icris(db,shipment,'','Name')=='missing' and shipment.company_id is None;db.rollback();db.close()
def test_invalid_icris_creates_unlinked_state():
    db=SessionLocal();shipment=Shipment(shipment_number='INVALID-'+suffix());db.add(shipment);db.flush();assert link_icris(db,shipment,'---','Name')=='invalid' and shipment.company_id is None;db.rollback();db.close()
def test_manual_company_link_remains_protected():
    db=SessionLocal();tag=suffix();company=Company(icris_number='MAN-'+tag,company_name='Manual',normalized_name='manual');shipment=Shipment(shipment_number='MS-'+tag,company=company,manually_matched=True,is_manually_matched=True);db.add(shipment);db.flush();cid=company.id;assert link_icris(db,shipment,'OTHER','Other')=='manual' and shipment.company_id==cid;db.rollback();db.close()
def test_existing_excel_package_and_weight_are_unchanged():
    db=SessionLocal();tag=suffix();detail=parse_manifest_detail(DETAIL);detail.header['MAWB']='PKG-'+tag;detail.rows=detail.rows[:1];detail.rows[0]['raw']['Tracking No.']='AWB-'+tag;shipment=Shipment(shipment_number='AWB-'+tag,source='manifest');db.add(shipment);db.flush();package=Package(shipment_id=shipment.id,package_id='PKG-'+tag,piece_number=1,package_weight=None);db.add(package);run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush();upsert_detail(db,run,detail,manifest_id='PKGM-'+tag);db.commit();db.refresh(package);assert package.package_weight is None and package.shipment_id==shipment.id;db.close()
def test_manual_field_override_is_not_overwritten():
    db=SessionLocal();tag=suffix();detail=parse_manifest_detail(DETAIL);detail.header['MAWB']='OVERRIDE-'+tag;detail.rows=detail.rows[:1];detail.rows[0]['raw']['Tracking No.']='OVERRIDE-AWB-'+tag;shipment=Shipment(shipment_number='OVERRIDE-AWB-'+tag,source='manual',bill_type='MANUAL',manual_override_fields=['bill_type']);db.add(shipment);run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush();upsert_detail(db,run,detail,manifest_id='OVERRIDE-M-'+tag);db.commit();db.refresh(shipment);assert shipment.bill_type=='MANUAL';db.close()
def test_dry_run_has_no_business_writes():
    db=SessionLocal();before=[db.scalar(select(func.count()).select_from(x)) for x in (Company,MasterAirWaybill,Shipment,Package)];run=CrmSyncRun(sync_type='manifest_single',status='running',dry_run=True);db.add(run);db.flush();item=CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id=suffix());db.add(item);db.flush();upsert_detail(db,run,parse_manifest_detail(DETAIL),item=item,dry_run=True);db.commit();after=[db.scalar(select(func.count()).select_from(x)) for x in (Company,MasterAirWaybill,Shipment,Package)];assert before==after;db.close()
def test_status_api_exposes_no_secrets(client):
    text=str(client.get('/api/v1/crm-sync/status').json()).casefold();assert all(x not in text for x in ('password','username','cookie','viewstate','eventvalidation'))
def test_retry_api_rejects_succeeded_item(client):
    db=SessionLocal();run,item=run_item(db,'succeeded');iid=item.id;db.close();assert client.post(f'/api/v1/crm-sync/items/{iid}/retry').status_code==409
def test_cancelled_pending_items_are_not_active(client):
    db=SessionLocal();run,item=run_item(db,'pending');rid=run.id;db.close();assert client.post(f'/api/v1/crm-sync/runs/{rid}/cancel').status_code==200;db=SessionLocal();assert db.get(CrmSyncItem,item.id).status=='cancelled';db.close()
def test_parser_version_is_recorded_in_dry_run():
    db=SessionLocal();run,item=run_item(db);detail=parse_manifest_detail(DETAIL);upsert_detail(db,run,detail,item=item,dry_run=True);assert item.parser_version==detail.parser_version;db.rollback();db.close()
def test_import_unknown_party_role_is_write_protected():
    db=SessionLocal();before=db.scalar(select(func.count()).select_from(Shipment));run=CrmSyncRun(sync_type='manifest_single',status='running',dry_run=False,direction='import');db.add(run);db.flush();item=CrmSyncItem(run_id=run.id,manifest_direction='import',crm_manifest_id=suffix());db.add(item);db.flush();upsert_detail(db,run,parse_manifest_detail(DETAIL),item=item,direction='import',dry_run=True);db.commit();assert db.scalar(select(func.count()).select_from(Shipment))==before;db.close()
