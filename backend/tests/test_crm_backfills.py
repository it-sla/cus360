from datetime import date,timedelta
import uuid
import pytest
from sqlalchemy import func,select
from app.crm_backfills import cancel_backfill,chunk_ranges,create_backfill,create_incremental,incremental_range,pause_backfill,record_earliest_date,resume_backfill,update_from_completed_run
from app.db import SessionLocal
from app.models import CrmBackfillChunk,CrmSyncItem,CrmSyncRun,CrmSyncState

def test_seven_day_chunks_have_no_gaps_overlaps_and_partial_end():
    chunks=list(chunk_ranges(date(2020,1,1),date(2020,1,17),7));assert chunks==[(date(2020,1,1),date(2020,1,7)),(date(2020,1,8),date(2020,1,14)),(date(2020,1,15),date(2020,1,17))]
    for previous,current in zip(chunks,chunks[1:]):assert previous[1]+timedelta(days=1)==current[0]

def test_historical_backfill_is_rolling_and_checkpointed():
    db=SessionLocal()
    try:
        backfill=create_backfill(db,'export',date(2020,2,1),date(2020,2,20),7,'preview',True);db.commit();chunks=db.scalars(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id).order_by(CrmBackfillChunk.sequence_number)).all()
        assert backfill.total_chunks==3;assert sum(x.status=='active' for x in chunks)==1;assert sum(x.sync_run_id is not None for x in chunks)==1;assert chunks[-1].date_to==date(2020,2,20)
        run=db.get(CrmSyncRun,chunks[0].sync_run_id);run.status='completed';item=CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id='BF-'+uuid.uuid4().hex,status='succeeded',unchanged=True);db.add(item);db.flush();update_from_completed_run(db,run);db.commit();db.refresh(backfill)
        assert backfill.completed_chunks==1;assert backfill.skipped_unchanged_manifests==1;assert db.scalar(select(func.count()).select_from(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id,CrmBackfillChunk.status=='active'))==1
    finally:db.close()

def test_pause_resume_and_cancel_preserve_completed_work():
    db=SessionLocal()
    try:
        item=create_backfill(db,'export',date(2020,3,1),date(2020,3,15),7,'preview',True);db.commit();pause_backfill(db,item);db.commit();assert item.status=='paused';resume_backfill(db,item);db.commit();assert item.status=='previewing';cancel_backfill(db,item);db.commit();assert item.status=='cancelled';assert db.scalar(select(func.count()).select_from(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==item.id,CrmBackfillChunk.status=='cancelled'))>=1
    finally:db.close()

def test_earliest_date_must_be_confirmed_and_export_import_are_separate():
    db=SessionLocal()
    try:
        for key in ('earliest:export','earliest:import'):
            existing=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type==key))
            if existing:db.delete(existing)
        db.commit()
        with pytest.raises(ValueError,match='Confirm the earliest'):create_backfill(db,'export',None,date(2018,1,5),7,'preview')
        db.rollback();record_earliest_date(db,'export',date(2018,1,1));record_earliest_date(db,'import',date(2019,1,1));db.commit();item=create_backfill(db,'export',None,date(2018,1,5),7,'preview');db.commit();assert item.resolved_start_date==date(2018,1,1)
    finally:db.close()

def test_live_import_backfill_now_allowed():
    db=SessionLocal()
    try:
        backfill=create_backfill(db,'import',date(2020,4,1),date(2020,4,2),7,'import',True)
        assert backfill.direction=='import';assert backfill.mode=='import';assert backfill.total_chunks>=1
    finally:db.close()

def test_incremental_watermark_uses_three_day_overlap_and_is_separate():
    db=SessionLocal()
    try:
        export=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='watermark:export')) or CrmSyncState(entity_type='watermark:export');imp=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='watermark:import')) or CrmSyncState(entity_type='watermark:import');export.last_successful_date=date(2026,7,16);imp.last_successful_date=date(2026,7,10);db.add_all([export,imp]);db.commit();assert incremental_range(db,'export',3)[0]==date(2026,7,14);assert incremental_range(db,'import',3)[0]==date(2026,7,8)
        run=create_incremental(db,'export','preview',3);db.commit();assert run.requested_from_date==date(2026,7,14) and run.dry_run
        imp_run=create_incremental(db,'import','import',3);db.commit();assert imp_run.direction=='import' and not imp_run.dry_run
    finally:db.close()

def test_backfill_api_contains_no_secrets(client):
    response=client.post('/api/v1/crm-sync/backfills/preview',json={'direction':'export','start_date':'2017-01-01','end_date':'2017-01-10','chunk_size_days':7,'confirm_start_date':True});assert response.status_code==202;rendered=str(response.json()).casefold();assert all(secret not in rendered for secret in ('password','cookie','viewstate','eventvalidation'))
