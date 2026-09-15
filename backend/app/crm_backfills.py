"""Rolling historical CRM backfills and incremental watermarks."""
from datetime import date,timedelta
from sqlalchemy import func,select
from sqlalchemy.orm import Session
from .models import CompanyImportBatch,CrmBackfillChunk,CrmBackfillRun,CrmSyncItem,CrmSyncRun,CrmSyncState,now

TERMINAL_ITEMS={'succeeded','succeeded_with_warnings','quarantined','cancelled'}
def chunk_ranges(start:date,end:date,size:int):
    cursor=start
    while cursor<=end:
        stop=min(end,cursor+timedelta(days=size-1));yield cursor,stop;cursor=stop+timedelta(days=1)
def earliest_state(db:Session,direction:str):return db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type==f'earliest:{direction}'))
def watermark_state(db:Session,direction:str):return db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type==f'watermark:{direction}'))
def customer_master_ready(db:Session):return bool(db.scalar(select(func.count()).select_from(CompanyImportBatch).where(CompanyImportBatch.status.like('completed%'))))
def resolve_start(db:Session,direction:str,requested:date|None):
    if requested:return requested,'administrator_confirmed'
    directions=('export','import') if direction=='both' else (direction,);values=[]
    for item in directions:
        state=earliest_state(db,item)
        if not state or not state.last_successful_date:raise ValueError(f'Confirm the earliest available {item.title()} CRM manifest date before starting')
        values.append(state.last_successful_date)
    return min(values),'stored_verified_date'
def record_earliest_date(db:Session,direction:str,value:date,source='administrator_confirmed'):
    state=earliest_state(db,direction)
    if not state:state=CrmSyncState(entity_type=f'earliest:{direction}');db.add(state)
    state.last_successful_date=value;state.last_successful_sync_at=now();state.cursor_json={'earliest_date_source':source,'earliest_date_verified_at':now().isoformat()};return state
def create_backfill(db:Session,direction:str,start:date|None,end:date,chunk_size:int,mode:str,confirm_start=False):
    if direction not in {'export','import','both'}:raise ValueError('Direction must be Export, Import, or Both')
    if chunk_size not in {1,7,14,30}:raise ValueError('Chunk size must be 1, 7, 14, or 30 days')
    if end>date.today():raise ValueError('Historical import end date cannot be in the future')
    resolved,source=resolve_start(db,direction,start)
    if resolved>end:raise ValueError('Historical start date must be before or the same as end date')
    if start and confirm_start:
        for item in (('export','import') if direction=='both' else (direction,)):record_earliest_date(db,item,start)
    backfill=CrmBackfillRun(direction=direction,requested_start_date=start,requested_end_date=end,resolved_start_date=resolved,resolved_end_date=end,chunk_size_days=chunk_size,mode=mode,status='previewing' if mode=='preview' else 'running',started_at=now(),last_heartbeat_at=now());db.add(backfill);db.flush();sequence=0
    for chunk_direction in (('export','import') if direction=='both' else (direction,)):
        for begin,finish in chunk_ranges(resolved,end,chunk_size):sequence+=1;db.add(CrmBackfillChunk(backfill_id=backfill.id,direction=chunk_direction,date_from=begin,date_to=finish,sequence_number=sequence))
    backfill.total_chunks=sequence;db.flush();activate_next_chunk(db,backfill);return backfill
def activate_next_chunk(db:Session,backfill:CrmBackfillRun):
    if backfill.status not in {'running','previewing'}:return None
    active=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))
    if active:return active
    chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='pending').order_by(CrmBackfillChunk.sequence_number).with_for_update(skip_locked=True))
    if not chunk:
        backfill.completed_at=now();backfill.status='needs_attention' if backfill.failed_chunks else ('completed_with_warnings' if backfill.quarantined_manifests or backfill.warning_manifests else 'completed');return None
    run=CrmSyncRun(sync_type='historical_chunk',status='queued',requested_from_date=chunk.date_from,requested_to_date=chunk.date_to,direction=chunk.direction,dry_run=backfill.mode=='preview');db.add(run);db.flush();chunk.sync_run_id=run.id;chunk.status='active';chunk.attempt_count+=1;chunk.started_at=now();backfill.current_chunk_start=chunk.date_from;backfill.current_chunk_end=chunk.date_to;backfill.last_heartbeat_at=now();return chunk
def update_from_completed_run(db:Session,run:CrmSyncRun):
    chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.sync_run_id==run.id))
    if not chunk:return
    backfill=db.get(CrmBackfillRun,chunk.backfill_id);counts=dict(db.execute(select(CrmSyncItem.status,func.count()).where(CrmSyncItem.run_id==run.id).group_by(CrmSyncItem.status)).all());chunk.manifest_count=sum(counts.values());chunk.completed_manifest_count=sum(counts.get(x,0) for x in TERMINAL_ITEMS);chunk.warning_count=counts.get('succeeded_with_warnings',0);chunk.quarantined_count=counts.get('quarantined',0);chunk.checkpoint_json={'completed_at':now().isoformat(),'terminal_counts':counts};chunk.completed_at=now();chunk.status='needs_attention' if run.status=='completed_with_errors' else 'completed';backfill.completed_chunks+=1;backfill.failed_chunks+=int(chunk.status=='needs_attention');backfill.total_manifests_discovered+=chunk.manifest_count;backfill.total_manifests_processed+=chunk.completed_manifest_count;backfill.succeeded_manifests+=counts.get('succeeded',0);backfill.warning_manifests+=chunk.warning_count;backfill.quarantined_manifests+=chunk.quarantined_count;backfill.skipped_unchanged_manifests+=db.scalar(select(func.count()).select_from(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.unchanged.is_(True))) or 0;backfill.last_heartbeat_at=now()
    db.flush();activate_next_chunk(db,backfill)
def pause_backfill(db:Session,backfill:CrmBackfillRun):
    if backfill.status not in {'running','previewing'}:raise ValueError('Only an active historical import can be paused')
    backfill.status='paused';backfill.paused_at=now();chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))
    if chunk and chunk.sync_run_id:
        run=db.get(CrmSyncRun,chunk.sync_run_id)
        if run and run.status in {'queued','discovering','running'}:run.status='paused'
def resume_backfill(db:Session,backfill:CrmBackfillRun):
    if backfill.status not in {'paused','needs_attention','completed_with_warnings'}:raise ValueError('This historical import is not paused')
    backfill.status='previewing' if backfill.mode=='preview' else 'running';backfill.paused_at=None;chunk=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))
    if chunk and chunk.sync_run_id:
        run=db.get(CrmSyncRun,chunk.sync_run_id)
        if run and run.status=='paused':run.status='running' if db.scalar(select(func.count()).select_from(CrmSyncItem).where(CrmSyncItem.run_id==run.id)) else 'queued'
    else:activate_next_chunk(db,backfill)
def cancel_backfill(db:Session,backfill:CrmBackfillRun):
    for chunk in db.scalars(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='pending')).all():chunk.status='cancelled';chunk.completed_at=now()
    active=db.scalar(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))
    if active and active.sync_run_id:
        run=db.get(CrmSyncRun,active.sync_run_id)
        for item in db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.status.in_({'pending','retry_scheduled'}))).all():item.status='cancelled';item.completed_at=now()
        run.status='cancelled'
    backfill.status='cancelled';backfill.completed_at=now()
def incremental_range(db:Session,direction:str,overlap_days=3):
    state=watermark_state(db,direction);end=date.today();start=(state.last_successful_date-timedelta(days=overlap_days-1)) if state and state.last_successful_date else end-timedelta(days=6);return start,end
def create_incremental(db:Session,direction:str,mode:str,overlap_days=3,force=False):
    start,end=incremental_range(db,direction,overlap_days);run=CrmSyncRun(sync_type='incremental_update',status='queued',requested_from_date=start,requested_to_date=end,direction=direction,dry_run=mode=='preview',force_reparse=force,discovery_checkpoint={'overlap_days':overlap_days});db.add(run);db.flush();return run
