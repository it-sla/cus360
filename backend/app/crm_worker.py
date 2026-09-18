import json,logging,os,random,signal,socket,time,uuid
from datetime import datetime,timedelta
from sqlalchemy import func,or_,select
from sqlalchemy.exc import DBAPIError,OperationalError
from .core import settings
from .db import SessionLocal
from .models import CrmBackfillChunk,CrmBackfillRun,CrmSyncItem,CrmSyncRun,CrmSyncState,DataQualityIssue,now
from .crm_backfills import activate_next_chunk,create_incremental,update_from_completed_run,watermark_state
from .crm_connector import AuthenticationError,ConnectorError,CrmSessionManager,RetryableConnectorError
from .crm_parser import CrmParseError,DuplicateTrackingConflict,EmptyManifestError,PartialManifestError,parse_manifest_detail,parse_manifest_list
from .crm_sync import upsert_detail,sync_active_pipeline
from .email_notifications import send_tier_alert_digests, send_immediate_tier_breach_emails, send_weekly_report

log=logging.getLogger('crm-worker');logging.basicConfig(level=logging.INFO,format='%(message)s');logging.getLogger('httpx').setLevel(logging.WARNING)
stopping=False;WORKER_ID=f'{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}'
ACTIVE={'pending','claimed','fetching','parsing','validating','importing','retry_scheduled'}
FINAL={'succeeded','succeeded_with_warnings','quarantined','cancelled'}
BACKOFF=(30,120,600,1800,7200)

def emit(event,**context):
    safe={k:v for k,v in context.items() if v is not None};safe['event']=event;log.info(json.dumps(safe,default=str,sort_keys=True))
def stop(*_):
    global stopping;stopping=True
def retry_delay(attempt):return BACKOFF[min(max(attempt-1,0),len(BACKOFF)-1)]+random.randint(0,10)
def _summary(exc):
    text=' '.join(str(exc).split())[:300]
    for token in ('password','cookie','viewstate','eventvalidation'):
        if token in text.casefold():return 'Sensitive authentication detail was redacted'
    return text or type(exc).__name__
def classify(exc):
    if isinstance(exc,DuplicateTrackingConflict):return exc.code,False
    if isinstance(exc,(PartialManifestError,EmptyManifestError)):return exc.code,True
    if isinstance(exc,CrmParseError):return getattr(exc,'code','crm_header_mismatch'),False
    if isinstance(exc,AuthenticationError):return exc.code,True
    if isinstance(exc,RetryableConnectorError):return getattr(exc,'code','crm_manifest_unavailable'),True
    if isinstance(exc,ConnectorError):return getattr(exc,'code','crm_manifest_unavailable'),False
    if isinstance(exc,(OperationalError,DBAPIError)):return 'temporary_database_failure',True
    return 'unexpected_worker_error',False
def heartbeat(item_id=None,stage=None):
    db=SessionLocal()
    try:
        stamp=now()
        if item_id:
            item=db.get(CrmSyncItem,item_id)
            if item and item.claimed_by==WORKER_ID:item.heartbeat_at=stamp;item.lease_expires_at=stamp+timedelta(seconds=settings.crm_sync_lease_seconds);item.status=stage or item.status
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='worker'))
        payload={'worker_id':WORKER_ID,'heartbeat_at':stamp.isoformat(),'sync_item_id':str(item_id) if item_id else None,'stage':stage,'queue_depth':db.scalar(select(func.count()).select_from(CrmSyncItem).where(CrmSyncItem.status.in_(ACTIVE)))}
        if not state:state=CrmSyncState(entity_type='worker',cursor_json=payload);db.add(state)
        else:state.cursor_json=payload;state.updated_at=stamp
        db.commit()
    finally:db.close()
def recover_stale(db=None):
    own=db is None;db=db or SessionLocal();stamp=now()
    try:
        items=db.scalars(select(CrmSyncItem).where(CrmSyncItem.status.in_({'claimed','fetching','parsing','validating','importing'}),CrmSyncItem.lease_expires_at<stamp).with_for_update(skip_locked=True)).all()
        for item in items:
            item.status='retry_scheduled';item.next_retry_at=stamp;item.claimed_by=None;item.claimed_at=None;item.lease_expires_at=None;item.last_error_code='worker_lease_expired';item.last_error_summary='Worker lease expired; item recovered'
        if own:db.commit()
        return len(items)
    finally:
        if own:db.close()
def claim_discovery():
    db=SessionLocal()
    try:
        run=db.scalar(select(CrmSyncRun).where(CrmSyncRun.status=='queued').order_by(CrmSyncRun.created_at).with_for_update(skip_locked=True))
        if not run:return None
        run.status='discovering';run.started_at=run.started_at or now();run.worker_id=WORKER_ID;run.last_heartbeat_at=now();db.commit();return run.id
    finally:db.close()
def _safe_detail_url(direction,manifest_id,found):
    template=settings.crm_export_manifest_detail_url_template if direction=='export' else settings.crm_import_manifest_detail_url_template
    return (template.format(id=manifest_id) if template and manifest_id else None) or found
def discover_run(run_id):
    started=time.monotonic();connector=CrmSessionManager();db=SessionLocal()
    try:
        run=db.get(CrmSyncRun,run_id);directions=['export','import'] if run.direction=='both' else [run.direction];connector.login();seen={};created=0
        for direction in directions:
            html=connector.list_range(direction,run.requested_from_date,run.requested_to_date) if run.requested_from_date and run.requested_to_date else (connector.export_list() if direction=='export' else connector.import_list());run.list_pages_read+=1
            rows=parse_manifest_list(html,settings.crm_base_url)
            emit('discovery_list_parsed',run_id=run.id,stage='discovery',direction=direction,rows_parsed=len(rows),html_size=len(html))
            for row in rows:
                if run.requested_from_date and row['manifest_date']<run.requested_from_date:continue
                if run.requested_to_date and row['manifest_date']>run.requested_to_date:continue
                manifest_id=row['crm_manifest_id'];identity=(direction,manifest_id)
                metadata={'displayed_date':row['Date'],'displayed_mawb':row['MAWB'],'displayed_flight':row['FLIGHT'],'displayed_origin':row['FROM'],'displayed_destination':row['TO'],'discovered_at':now().isoformat()}
                if not manifest_id:
                    db.add(DataQualityIssue(issue_type='crm_manifest_unavailable',severity='error',sync_run_id=run.id,details_json={'direction':direction,'reason':'detail href has no CRM manifest ID'},status='open'));run.failed_count+=1;continue
                if identity in seen and seen[identity]!=metadata:
                    db.add(CrmSyncItem(run_id=run.id,manifest_direction=direction,crm_manifest_id=manifest_id,source_manifest_date=row['manifest_date'],source_mawb_number=row['MAWB'],source_detail_url=_safe_detail_url(direction,manifest_id,row['detail_ref']),discovery_metadata=metadata,status='quarantined',last_error_code='crm_discovery_identity_conflict',last_error_summary='Duplicate CRM manifest ID has conflicting list metadata',completed_at=now()));continue
                seen[identity]=metadata
                existing=db.scalar(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.manifest_direction==direction,CrmSyncItem.crm_manifest_id==manifest_id))
                if existing:continue
                db.add(CrmSyncItem(run_id=run.id,manifest_direction=direction,crm_manifest_id=manifest_id,source_detail_url=_safe_detail_url(direction,manifest_id,row['detail_ref']),source_manifest_date=row['manifest_date'],source_mawb_number=row['MAWB'],discovery_metadata=metadata,status='pending',maximum_attempts=settings.crm_sync_max_attempts));created+=1
                run.discovery_checkpoint={'direction':direction,'current_date':row['manifest_date'].isoformat(),'current_page':1,'last_discovered_manifest_id':manifest_id}
                if run.maximum_manifests and created>=run.maximum_manifests:break
            if run.maximum_manifests and created>=run.maximum_manifests:break
        backfill_chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.sync_run_id==run.id));parent=db.get(CrmBackfillRun,backfill_chunk.backfill_id) if backfill_chunk else None
        run.mawbs_found=created;run.status=('paused' if created and parent and parent.status=='paused' else ('running' if created else 'completed'));run.completed_at=None if created else now()
        if not created:
            if run.list_pages_read and run.requested_from_date and run.requested_to_date:
                span=(run.requested_to_date-run.requested_from_date).days
                if span>1:run.warnings_count=run.warnings_count or 0;run.warnings_count+=1;emit('discovery_zero_rows_suspicious',run_id=run.id,stage='discovery',result='zero_rows',date_range_days=span,list_pages_read=run.list_pages_read)
            update_from_completed_run(db,run)
        db.commit();emit('discovery_completed',run_id=run.id,stage='discovery',result=run.status,items=created,duration_ms=int((time.monotonic()-started)*1000))
    except Exception as exc:
        db.rollback();run=db.get(CrmSyncRun,run_id);code,retryable=classify(exc);chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.sync_run_id==run.id))
        if chunk and retryable:chunk.attempt_count+=1;retryable=chunk.attempt_count<settings.crm_sync_max_attempts
        run.status='queued' if retryable else 'completed_with_errors';run.error_message=_summary(exc);run.failed_count+=1
        if not retryable:
            if chunk:chunk.last_error_code=code;chunk.last_error_summary=run.error_message
            update_from_completed_run(db,run)
        db.commit();emit('discovery_failed',run_id=run_id,stage='discovery',result=code,duration_ms=int((time.monotonic()-started)*1000))
    finally:connector.close();db.close()
def enqueue_direct(run_id,direction,manifest_id):
    db=SessionLocal()
    try:
        run=db.get(CrmSyncRun,run_id);item=CrmSyncItem(run_id=run.id,manifest_direction=direction,crm_manifest_id=str(manifest_id),source_detail_url=_safe_detail_url(direction,str(manifest_id),None),status='pending',maximum_attempts=settings.crm_sync_max_attempts);db.add(item);run.status='running';run.started_at=run.started_at or now();db.commit();return item.id
    finally:db.close()
def claim_item():
    db=SessionLocal();stamp=now()
    try:
        item=db.scalar(select(CrmSyncItem).join(CrmSyncRun).where(CrmSyncRun.status.in_({'running','interrupted'}),CrmSyncItem.status.in_({'pending','retry_scheduled'}),or_(CrmSyncItem.next_retry_at.is_(None),CrmSyncItem.next_retry_at<=stamp)).order_by(CrmSyncItem.created_at).with_for_update(skip_locked=True))
        if not item:return None
        item.status='claimed';item.attempt_count+=1;item.claimed_at=stamp;item.claimed_by=WORKER_ID;item.lease_expires_at=stamp+timedelta(seconds=settings.crm_sync_lease_seconds);item.heartbeat_at=stamp;item.started_at=item.started_at or stamp;item.next_retry_at=None;db.commit();return item.id
    finally:db.close()
def _fail_item(item_id,exc):
    db=SessionLocal()
    try:
        item=db.get(CrmSyncItem,item_id);code,retryable=classify(exc);item.last_error_code=code;item.last_error_summary=_summary(exc);item.claimed_by=None;item.lease_expires_at=None;item.heartbeat_at=now()
        if retryable and item.attempt_count<item.maximum_attempts:item.status='retry_scheduled';item.next_retry_at=now()+timedelta(seconds=retry_delay(item.attempt_count))
        else:item.status='quarantined';item.completed_at=now();item.next_retry_at=None
        db.add(DataQualityIssue(issue_type=code,severity='error',sync_run_id=item.run_id,sync_item_id=item.id,details_json={'summary':item.last_error_summary,'attempt':item.attempt_count},status='open'));db.commit();emit('manifest_failed',run_id=item.run_id,sync_item_id=item.id,direction=item.manifest_direction,crm_manifest_id=item.crm_manifest_id,stage=item.status,attempt=item.attempt_count,result=code)
    finally:db.close()
def process_item(item_id):
    total=time.monotonic();connector=CrmSessionManager()
    try:
        heartbeat(item_id,'fetching');db=SessionLocal();item=db.get(CrmSyncItem,item_id);direction=item.manifest_direction;manifest_id=item.crm_manifest_id;url=item.source_detail_url;run_id=item.run_id;db.close()
        fetch=time.monotonic();html,actual_url=connector.detail(direction,manifest_id,url);fetch_ms=int((time.monotonic()-fetch)*1000);heartbeat(item_id,'parsing')
        parsed=time.monotonic();detail=parse_manifest_detail(html,manifest_id);parse_ms=int((time.monotonic()-parsed)*1000);heartbeat(item_id,'validating')
        if not detail.rows:raise EmptyManifestError('Manifest contains no valid shipment rows')
        if detail.source_data_row_count!=len(detail.rows)+detail.duplicate_row_count:raise PartialManifestError('Parsed row count does not match nonblank source rows')
        if direction=='import':detail.warnings.append('Import customer party role is unverified; business linking is disabled')
        heartbeat(item_id,'importing');db=SessionLocal()
        try:
            item=db.get(CrmSyncItem,item_id);run=db.get(CrmSyncRun,item.run_id);write=time.monotonic()
            effective_dry=run.dry_run or direction=='import';upsert_detail(db,run,detail,actual_url,item,direction,manifest_id,effective_dry)
            item.status='succeeded_with_warnings' if item.warning_count or detail.warnings else 'succeeded';item.completed_at=now();item.claimed_by=None;item.lease_expires_at=None;item.heartbeat_at=now();item.metrics_json={**(item.metrics_json or {}),'detail_fetch_ms':fetch_ms,'parse_ms':parse_ms,'database_write_ms':int((time.monotonic()-write)*1000),'total_ms':int((time.monotonic()-total)*1000),'dry_run':effective_dry};run.detail_pages_read+=1;run.last_heartbeat_at=now();db.commit()
            emit('manifest_completed',run_id=run.id,sync_item_id=item.id,direction=direction,crm_manifest_id=manifest_id,mawb=item.source_mawb_number,stage='completed',attempt=item.attempt_count,duration_ms=int((time.monotonic()-total)*1000),result=item.status)
        except Exception:db.rollback();raise
        finally:db.close()
    except Exception as exc:_fail_item(item_id,exc)
    finally:connector.close()
def finalize_runs():
    db=SessionLocal()
    try:
        runs=db.scalars(select(CrmSyncRun).where(CrmSyncRun.status.in_({'running','interrupted'}))).all()
        for run in runs:
            counts=dict(db.execute(select(CrmSyncItem.status,func.count()).where(CrmSyncItem.run_id==run.id).group_by(CrmSyncItem.status)).all())
            if any(counts.get(x,0) for x in ACTIVE):continue
            run.completed_at=now();run.status='completed_with_errors' if counts.get('quarantined',0) else 'completed';run.failed_count=counts.get('quarantined',0);run.warnings_count=counts.get('succeeded_with_warnings',0)
            if counts.get('succeeded',0) or counts.get('succeeded_with_warnings',0):
                state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='manifest'))
                if not state:state=CrmSyncState(entity_type='manifest');db.add(state);db.flush()
                state.last_successful_sync_at=now();state.last_sync_run_id=run.id
                backfill_chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.sync_run_id==run.id));has_historical_gap=bool(backfill_chunk and db.scalar(select(func.count()).select_from(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill_chunk.backfill_id,CrmBackfillChunk.status=='needs_attention')))
                if run.status=='completed' and not run.dry_run and run.requested_to_date and not has_historical_gap:
                    watermark=watermark_state(db,run.direction)
                    if not watermark:watermark=CrmSyncState(entity_type=f'watermark:{run.direction}');db.add(watermark)
                    watermark.last_successful_date=run.requested_to_date;watermark.last_successful_sync_at=now();watermark.last_sync_run_id=run.id;watermark.cursor_json={'unfinished_critical_items':0,'overlap_days':(run.discovery_checkpoint or {}).get('overlap_days',3)}
            update_from_completed_run(db,run)
        db.commit()
    finally:db.close()
def run_once():
    recovered=recover_stale()
    if recovered:emit('stale_items_recovered',stage='recovery',result='recovered',items=recovered)
    run_id=claim_discovery()
    if run_id:discover_run(run_id);return True
    item_id=claim_item()
    if item_id:process_item(item_id);finalize_runs();return True
    finalize_runs();recover_backfill_orchestration();check_auto_schedule();check_pipeline_auto_schedule();check_pnl_auto_schedule();check_daily_call_logs_auto_schedule();check_tier_alert_email_schedule();check_immediate_tier_breach_schedule();check_weekly_report_schedule();heartbeat();return False
def recover_backfill_orchestration():
    db=SessionLocal()
    try:
        for backfill in db.scalars(select(CrmBackfillRun).where(CrmBackfillRun.status.in_({'running','previewing'}))).all():
            chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))
            if chunk and chunk.sync_run_id:
                run=db.get(CrmSyncRun,chunk.sync_run_id)
                if run and run.status=='discovering':run.status='queued'
                elif run and run.status=='paused':run.status='running' if db.scalar(select(func.count()).select_from(CrmSyncItem).where(CrmSyncItem.run_id==run.id)) else 'queued'
            activate_next_chunk(db,backfill)
        db.commit()
    finally:db.close()
def _cron_field_matches(value,field_spec):
    if field_spec=='*':return True
    if field_spec.startswith('*/'):
        step=int(field_spec[2:]);return value%step==0
    return str(value) in field_spec.split(',')
def _cron_matches(now_dt,spec):
    parts=spec.split()
    if len(parts)!=5:return False
    minute,hour,dom,month,dow=parts
    return (_cron_field_matches(now_dt.minute,minute) and _cron_field_matches(now_dt.hour,hour) and _cron_field_matches(now_dt.day,dom) and _cron_field_matches(now_dt.month,month) and _cron_field_matches(now_dt.isoweekday()%7,dow))
def check_auto_schedule():
    if not settings.crm_schedule_enabled or not settings.crm_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='auto_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.crm_schedule_cron):return
        existing=db.scalar(select(CrmSyncRun).where(CrmSyncRun.status.in_({'queued','discovering','running'})))
        if existing:return
        try:
            run=create_incremental(db,'both','incremental',overlap_days=settings.crm_schedule_overlap_days,force=False)
            db.commit()
            if not state:state=CrmSyncState(entity_type='auto_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),'run_id':str(run.id) if run else None};state.updated_at=now()
            db.commit()
            emit('auto_sync_scheduled',stage='schedule',result='created',run_id=str(run.id) if run else None)
        except Exception as exc:
            db.rollback()
            emit('auto_sync_failed',stage='schedule',result=type(exc).__name__,error=str(exc)[:200])
    finally:db.close()
def check_pipeline_auto_schedule():
    """Periodic Active Pipeline refresh — a whole-table snapshot pull, not part of the
    manifest CrmSyncRun/CrmSyncItem queue, since there's nothing to reconcile per-item."""
    if not settings.crm_scraper_enabled or not settings.crm_active_pipeline_url or not settings.crm_pipeline_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='pipeline_auto_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.crm_pipeline_schedule_cron):return
        from datetime import date,timedelta as td
        from .crm_connector import CrmSessionManager,ConnectorError,SessionExpired
        from .crm_parser import CrmParseError
        from .crm_sync import run_active_pipeline_sync
        connector=CrmSessionManager()
        try:
            date_from=date.today();date_to=date_from+td(days=settings.crm_pipeline_lookahead_days)
            html=connector.active_pipeline_list(date_from,date_to)
            run=run_active_pipeline_sync(db,html,settings.crm_active_pipeline_url,worker_id='pipeline-scheduler')
            db.commit()
            if not state:state=CrmSyncState(entity_type='pipeline_auto_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),'rows':run.shipments_found};state.updated_at=now()
            db.commit()
            emit('pipeline_sync_scheduled',stage='pipeline_schedule',result=run.status,rows=run.shipments_found,run_id=str(run.id))
        except (ConnectorError,SessionExpired,CrmParseError) as exc:
            db.rollback();emit('pipeline_sync_failed',stage='pipeline_schedule',result=type(exc).__name__,error=str(exc)[:200])
        finally:connector.close()
    finally:db.close()
def check_tier_alert_email_schedule():
    """Daily Resend digest for Tier Shipping Gap alerts (docs/customer-segmentation-rules.md).
    Same shape as check_pipeline_auto_schedule, but send_tier_alert_digests itself is a
    no-op unless tier_alert_email_enabled and RESEND_API_KEY are both set — this check
    still runs every schedule tick regardless, so flipping that flag on doesn't need a
    worker restart to take effect at the next scheduled minute."""
    if not settings.tier_alert_email_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='tier_alert_email_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.tier_alert_email_schedule_cron):return
        try:
            result=send_tier_alert_digests(db)
            if not state:state=CrmSyncState(entity_type='tier_alert_email_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),**result};state.updated_at=now()
            db.commit()
            emit('tier_alert_emails_scheduled',stage='tier_alert_schedule',result='sent',**result)
        except Exception as exc:
            db.rollback();emit('tier_alert_emails_failed',stage='tier_alert_schedule',result=type(exc).__name__,error=str(exc)[:200])
    finally:db.close()
def check_immediate_tier_breach_schedule():
    """Urgent one-off email the first time a Key Account/Reseller crosses its 7-day SLA
    (docs/customer-segmentation-rules.md) -- checked once daily at 3 PM NPT (9:15 UTC).
    send_immediate_tier_breach_emails tracks its own already-notified state (a separate
    CrmSyncState row), so this schedule-check row only tracks when this function last ran."""
    if not settings.tier_breach_immediate_check_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='tier_breach_immediate_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        # Skip if the daily digest ran within the last 60 minutes — those breaches were already included.
        digest_state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='tier_alert_email_schedule'))
        digest_last_run=(digest_state.cursor_json or {}).get('last_run_at') if digest_state else None
        if digest_last_run:
            try:
                digest_dt=datetime.fromisoformat(digest_last_run)
                if (now_dt-digest_dt).total_seconds()<3600:return
            except(ValueError,TypeError):pass
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.tier_breach_immediate_check_cron):return
        try:
            result=send_immediate_tier_breach_emails(db)
            if not state:state=CrmSyncState(entity_type='tier_breach_immediate_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),**result};state.updated_at=now()
            db.commit()
            emit('tier_breach_immediate_emails_scheduled',stage='tier_breach_immediate_schedule',result='sent',**result)
        except Exception as exc:
            db.rollback();emit('tier_breach_immediate_emails_failed',stage='tier_breach_immediate_schedule',result=type(exc).__name__,error=str(exc)[:200])
    finally:db.close()
def check_weekly_report_schedule():
    """Weekly comprehensive report email — Monday 10:00 AM NPT (04:15 UTC by default).
    Same shape as check_tier_alert_email_schedule; send_weekly_report is a no-op unless
    weekly_report_email_enabled and SMTP are both configured."""
    if not settings.weekly_report_email_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='weekly_report_email_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.weekly_report_email_schedule_cron):return
        try:
            result=send_weekly_report(db)
            if not state:state=CrmSyncState(entity_type='weekly_report_email_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),**result};state.updated_at=now()
            db.commit()
            emit('weekly_report_emails_scheduled',stage='weekly_report_schedule',result='sent',**result)
        except Exception as exc:
            db.rollback();emit('weekly_report_emails_failed',stage='weekly_report_schedule',result=type(exc).__name__,error=str(exc)[:200])
    finally:db.close()
def check_pnl_auto_schedule():
    """Periodic Profit/Loss refresh (Profitability page's 'Sync from CRM'), same shape as
    check_pipeline_auto_schedule — no CrmSyncRun/CrmSyncItem queue, since upsert_pnl only
    matches onto MAWBs that already exist and never creates them. Pulls a fixed trailing
    window (crm_pnl_schedule_lookback_days, capped well under the CRM report's ~31-day
    timeout) rather than tracking a watermark, since re-syncing the same recent window is
    cheap and self-healing if a run is missed."""
    if not settings.crm_scraper_enabled or not settings.crm_pnl_url or not settings.crm_pnl_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='pnl_auto_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.crm_pnl_schedule_cron):return
        from datetime import date,timedelta as td
        from .crm_connector import CrmSessionManager,ConnectorError
        from .crm_parser import parse_pnl_grid,CrmParseError
        from .crm_sync import upsert_pnl
        connector=CrmSessionManager()
        try:
            date_to=date.today();date_from=date_to-td(days=settings.crm_pnl_schedule_lookback_days)
            html=connector.pnl_list(date_from,date_to)
            report=parse_pnl_grid(html)
            stats=upsert_pnl(db,report,source_url=settings.crm_pnl_url)
            db.commit()
            if not state:state=CrmSyncState(entity_type='pnl_auto_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),'matched':stats['matched']};state.updated_at=now()
            db.commit()
            emit('pnl_sync_scheduled',stage='pnl_schedule',result='synced',matched=stats['matched'],unmatched=stats['unmatched'])
        except (ConnectorError,CrmParseError) as exc:
            db.rollback();emit('pnl_sync_failed',stage='pnl_schedule',result=type(exc).__name__,error=str(exc)[:200])
        finally:connector.close()
    finally:db.close()
def check_daily_call_logs_auto_schedule():
    """Periodic Daily Call Logs refresh, same shape as check_pnl_auto_schedule — an
    append-only log rather than a per-item queue, so this pulls a fixed trailing window
    (crm_daily_call_logs_schedule_lookback_days) each run; sync_daily_call_logs dedups
    the overlap by content hash rather than tracking a watermark."""
    if not settings.crm_scraper_enabled or not settings.crm_daily_call_logs_url or not settings.crm_daily_call_logs_schedule_cron:return
    db=SessionLocal()
    try:
        state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='daily_call_logs_auto_schedule'))
        last_run=(state.cursor_json or {}).get('last_run_at') if state else None
        now_dt=datetime.utcnow()
        if last_run:
            try:last_dt=datetime.fromisoformat(last_run)
            except(ValueError,TypeError):last_dt=None
            if last_dt and (now_dt-last_dt).total_seconds()<300:return
        if not _cron_matches(now_dt,settings.crm_daily_call_logs_schedule_cron):return
        from datetime import date,timedelta as td
        from .crm_connector import CrmSessionManager,ConnectorError
        from .crm_parser import parse_daily_call_logs,CrmParseError
        from .crm_sync import sync_daily_call_logs
        connector=CrmSessionManager()
        try:
            date_to=date.today();date_from=date_to-td(days=settings.crm_daily_call_logs_schedule_lookback_days)
            html=connector.daily_call_logs(date_from,date_to)
            rows=parse_daily_call_logs(html,settings.crm_daily_call_logs_url)
            stats=sync_daily_call_logs(db,rows)
            db.commit()
            if not state:state=CrmSyncState(entity_type='daily_call_logs_auto_schedule',cursor_json={});db.add(state)
            state.cursor_json={'last_run_at':now_dt.isoformat(),'inserted':stats['inserted_count']};state.updated_at=now()
            db.commit()
            emit('daily_call_logs_sync_scheduled',stage='daily_call_logs_schedule',result='synced',inserted=stats['inserted_count'],total_rows=stats['total_rows'])
        except (ConnectorError,CrmParseError) as exc:
            db.rollback();emit('daily_call_logs_sync_failed',stage='daily_call_logs_schedule',result=type(exc).__name__,error=str(exc)[:200])
        finally:connector.close()
    finally:db.close()
def main():
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop);recovered=recover_stale();emit('worker_started',stage='startup',result='ready',worker_id=WORKER_ID,recovered=recovered)
    while not stopping:
        if not run_once():
            for _ in range(max(1,settings.crm_sync_poll_seconds*2)):
                if stopping:break
                time.sleep(.5)
    emit('worker_stopped',stage='shutdown',result='stopped',worker_id=WORKER_ID)
if __name__=='__main__':main()
