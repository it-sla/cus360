import hashlib,json,re,unicodedata
from decimal import Decimal
from sqlalchemy import func,select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from .core import settings
from .models import *
from .utils import normalize_icris,normalize_name,extract_icris_from_tracking
from .crm_parser import ManifestDetail,ROW_HEADERS

def normalized_tracking(value):return unicodedata.normalize('NFKC',str(value or '')).strip()
def valid_icris(value):return bool(value and len(value)<=128 and re.search(r'[A-Z0-9]',value) and not re.search(r'[\x00-\x1f\x7f]',value))
def invalid_icris_reason(raw_value,normalized_value):
    """Names which of valid_icris's checks actually failed, with the real value inline —
    overwhelmingly this is CRM staff typing a placeholder ('.', '-') into the Icrisno column
    instead of leaving it blank, which reads completely differently from a garbled real code
    and shouldn't be reported with the same generic message."""
    if not normalized_value:return 'ICRIS value is blank after trimming'
    if len(normalized_value)>128:return f'ICRIS value is {len(normalized_value)} characters — over the 128 limit'
    if re.search(r'[\x00-\x1f\x7f]',normalized_value):return f'ICRIS value "{raw_value}" contains unprintable/control characters'
    if not re.search(r'[A-Z0-9]',normalized_value):return f'CRM manifest has "{raw_value}" in the ICRIS field — a placeholder with no letters or digits, not a real ICRIS'
    return f'ICRIS value "{raw_value}" does not match the expected format'
def exact_company(db,icris):
    value=normalize_icris(icris)
    return db.scalar(select(Company).where(func.upper(func.trim(Company.icris_number))==value)) if value else None
def issue(db,kind,**values):
    # Dedup deliberately ignores sync_item_id (still recorded on the row below, just not
    # matched on) — it's unique per sync run, so matching on it meant every re-sync of a
    # still-broken shipment spawned a brand-new open issue instead of reusing the existing
    # one. That inflated open counts well past the number of actually-affected shipments
    # (crm_invalid_icris was 2x — 8,786 open rows for 4,381 shipments).
    existing=db.scalar(select(DataQualityIssue).where(DataQualityIssue.issue_type==kind,DataQualityIssue.status=='open',DataQualityIssue.shipment_id==values.get('shipment_id'),DataQualityIssue.mawb_id==values.get('mawb_id')))
    details=values.pop('details_json',{})
    if existing:existing.last_seen_at=now();existing.details_json=details or existing.details_json;return existing
    item=DataQualityIssue(issue_type=kind,severity=values.pop('severity','warning'),details_json=details,**values);db.add(item);return item
def _counter(target,name,amount=1):
    if target is not None:setattr(target,name,(getattr(target,name,0) or 0)+amount)
def _add_alias(db,company,name):
    text=(name or '').strip();normalized=normalize_name(text)
    if not text or not normalized or normalized==company.normalized_name:return
    exists=db.scalar(select(CompanyAlias).where(CompanyAlias.company_id==company.id,CompanyAlias.normalized_alias_name==normalized))
    if not exists:db.add(CompanyAlias(company_id=company.id,alias_name=text,normalized_alias_name=normalized,source='crm'));db.flush()
def link_icris(db,shipment,icris,name,sync_run=None,sync_item=None,create_provisional=True):
    source_value=(icris or '').strip();normalized=normalize_icris(source_value);shipment.source_icris_number=source_value or None;shipment.source_customer_name=(name or '').strip() or None
    context={'sync_run_id':sync_run.id if sync_run else None,'sync_item_id':sync_item.id if sync_item else None,'shipment_id':shipment.id,'mawb_id':shipment.mawb_id,'source_company_name':shipment.source_customer_name}
    if shipment.manually_matched or shipment.is_manually_matched:
        issue(db,'crm_manual_link_preserved',severity='info',source_icris_number=source_value or None,details_json={'reason':'manual company link retained'},**context);return 'manual'
    if not normalized:
        shipment.company_id=None;shipment.match_status='icris_missing';shipment.match_confidence=None;shipment.matched_by_method='none';issue(db,'crm_blank_icris',details_json={'reason':'CRM Icrisno is blank'},**context);return 'missing'
    company=exact_company(db,normalized)
    if not valid_icris(normalized) and not company:
        shipment.company_id=None;shipment.match_status='invalid_icris';shipment.match_confidence=None;shipment.matched_by_method='none';issue(db,'crm_invalid_icris',source_icris_number=source_value,details_json={'reason':invalid_icris_reason(source_value,normalized)},**context);return 'invalid'
    created=False
    if not company and create_provisional:
        display=shipment.source_customer_name or f'Provisional {normalized}'
        company=Company(icris_number=normalized,company_name=display,normalized_name=normalize_name(display),source='crm_scrape',is_provisional=True,name_source='crm_manifest',crm_last_synced_at=now());db.add(company)
        try:
            with db.begin_nested():db.flush()
            created=True
        except IntegrityError:
            company=exact_company(db,normalized)
            if not company:raise
        # A well-formed ICRIS that simply isn't in the customer master yet — not bad data
        # like the two cases above, but still worth a distinct, reviewable flag rather than
        # silently spawning a provisional record with no trace. Resolves when
        # company_imports.py promotes this company out of provisional, not here — being
        # linked to a still-provisional company IS the flagged state, not a resolution of it.
        if created:issue(db,'crm_icris_not_in_master',severity='info',source_icris_number=source_value,company_id=company.id,details_json={'reason':f'ICRIS "{source_value}" is well-formed but not in the customer master list — created as a provisional record'},**context)
    if not company:return 'unmatched'
    shipment.company_id=company.id;shipment.match_status='matched';shipment.match_confidence=100;shipment.matched_by_method='exact_icris';company.crm_last_synced_at=now();_add_alias(db,company,shipment.source_customer_name)
    # A manually-assigned AE (Company.assigned_ae_code) always wins over whatever the CRM's
    # own "AE" column says on this manifest row — even for a shipment first created by this
    # sync. Applied here (after field_map already wrote the CRM value above) rather than
    # skipped there, since a brand-new shipment has no manual_override_fields yet to skip on.
    if company.assigned_ae_code:
        shipment.ae_code=company.assigned_ae_code
        shipment_overrides=set(shipment.manual_override_fields or []);shipment_overrides.add('ae_code');shipment.manual_override_fields=sorted(shipment_overrides)
    for oi in db.scalars(select(DataQualityIssue).where(DataQualityIssue.shipment_id==shipment.id,DataQualityIssue.issue_type.in_({'crm_blank_icris','crm_invalid_icris'}),DataQualityIssue.status=='open')).all():oi.status='resolved';oi.resolved_at=now();oi.resolved_by='crm_sync'
    if created:_counter(sync_run,'companies_created');_counter(sync_item,'created_company_count')
    _counter(sync_run,'matched_by_icris');_counter(sync_item,'linked_company_count')
    if shipment.source_customer_name and normalize_name(shipment.source_customer_name)!=company.normalized_name:
        shipment.name_mismatch=True;issue(db,'crm_customer_name_mismatch',company_id=company.id,source_icris_number=source_value,details_json={'official_name':company.company_name},**context)
    return 'matched'
def backfill_1z_icris_extraction(db:Session,cutoff_date):
    """Re-link existing shipments whose ICRIS lives in the tracking number (1Z-prefixed,
    manifests from cutoff_date on) but were synced before extraction was added — they're
    stuck as icris_missing/invalid_icris even though the ICRIS was there in the tracking
    number all along. Reuses link_icris so provisional creation, aliasing and issue
    resolution behave exactly like a live sync."""
    rows=db.scalars(select(Shipment).join(MasterAirWaybill).where(Shipment.shipment_number.ilike('1Z%'),MasterAirWaybill.manifest_date>=cutoff_date,Shipment.manually_matched.is_(False),Shipment.is_manually_matched.is_(False))).all()
    relinked=0
    for shipment in rows:
        extracted=extract_icris_from_tracking(shipment.shipment_number)
        if not extracted:continue
        before=shipment.match_status
        link_icris(db,shipment,extracted,shipment.source_customer_name)
        if shipment.match_status!=before:relinked+=1
    return {'checked':len(rows),'relinked':relinked}
def _prediction(db,detail):
    tracking=[normalized_tracking(r['raw']['Tracking No.']) for r in detail.rows];existing=set(db.scalars(select(Shipment.shipment_number).where(Shipment.shipment_number.in_(tracking))).all())
    icris=[normalize_icris(r['raw']['Icrisno']) for r in detail.rows if normalize_icris(r['raw']['Icrisno'])];known=set(db.scalars(select(func.upper(func.trim(Company.icris_number))).where(func.upper(func.trim(Company.icris_number)).in_(icris))).all()) if icris else set()
    return {'predicted_shipment_creates':sum(x not in existing for x in tracking),'predicted_shipment_updates':sum(x in existing for x in tracking),'predicted_company_creates':len(set(icris)-known),'predicted_links':sum(bool(x) for x in icris),'blank_icris_count':sum(not normalize_icris(r['raw']['Icrisno']) for r in detail.rows)}
def _reconciliation(detail):
    pieces=sum((r['parsed']['Pcs'] or Decimal(0)) for r in detail.rows);weight=sum((r['parsed']['Act wt'] or Decimal(0)) for r in detail.rows)
    displayed_pieces=sum((detail.totals.get(f'{x}_pieces') or Decimal(0)) for x in ('pp','fc','fd'));displayed_weight=sum((detail.totals.get(f'{x}_weight') or Decimal(0)) for x in ('pp','fc','fd'))
    mismatch=[]
    if displayed_pieces and pieces!=displayed_pieces:mismatch.append('pieces')
    if displayed_weight and abs(weight-displayed_weight)>Decimal(str(settings.crm_reconciliation_weight_tolerance)):mismatch.append('weight')
    return {'shipment_pieces_total':str(pieces),'shipment_actual_weight_total':str(weight),'manifest_pieces_total':str(displayed_pieces),'manifest_weight_total':str(displayed_weight),'mismatches':mismatch}
def upsert_detail(db:Session,run:CrmSyncRun,detail:ManifestDetail,source_url='',item:CrmSyncItem|None=None,direction='export',manifest_id=None,dry_run=False):
    manifest_id=str(manifest_id or (item.crm_manifest_id if item else '') or '') or None;direction=direction or 'export';prediction=_prediction(db,detail);reconciliation=_reconciliation(detail)
    if dry_run:
        if item:
            item.parsed_row_count=len(detail.rows);item.imported_row_count=0;item.warning_count=len(detail.warnings)+len(reconciliation['mismatches']);item.blank_icris_count=prediction['blank_icris_count'];item.duplicate_row_count=detail.duplicate_row_count;item.source_checksum=detail.source_checksum;item.parser_version=detail.parser_version;item.metrics_json={**prediction,'reconciliation':reconciliation}
        return prediction
    h=detail.header;mawb=None
    if manifest_id:mawb=db.scalar(select(MasterAirWaybill).where(MasterAirWaybill.manifest_direction==direction,MasterAirWaybill.crm_manifest_id==manifest_id))
    if not mawb:mawb=db.scalar(select(MasterAirWaybill).where(MasterAirWaybill.mawb_number==h['MAWB'].strip(),MasterAirWaybill.manifest_date==h['manifest_date']))
    created=not mawb
    if not mawb:mawb=MasterAirWaybill(mawb_number=h['MAWB'].strip(),manifest_date=h['manifest_date']);db.add(mawb);db.flush();_counter(run,'mawbs_created');_counter(item,'created_mawb_count')
    else:_counter(run,'mawbs_updated');_counter(item,'updated_mawb_count')
    if mawb.source_checksum==detail.source_checksum and mawb.parser_version==detail.parser_version and not run.force_reparse:
        if item:item.unchanged=True;item.source_checksum=detail.source_checksum;item.parser_version=detail.parser_version;item.parsed_row_count=len(detail.rows);item.imported_row_count=len(detail.rows);item.metrics_json={'unchanged':True,'reconciliation':reconciliation}
        return mawb
    for src,target in {'Flight No':'flight_number','From':'origin','TO':'destination'}.items():
        if h.get(src):setattr(mawb,target,h[src].strip())
    from .crm_parser import number
    for src,target in [('Exchange Rate','exchange_rate'),('Fuel Surcharge','fuel_surcharge')]:
        parsed=number(h.get(src,''),src)
        if parsed.value is not None:setattr(mawb,target,parsed.value)
    for key,value in detail.totals.items():setattr(mawb,key,value)
    mawb.source_url=source_url;mawb.last_synced_at=now();mawb.source_checksum=detail.source_checksum;mawb.source_key=manifest_id;mawb.manifest_direction=direction;mawb.crm_manifest_id=manifest_id;mawb.parser_version=detail.parser_version
    db.add(CrmRawManifestHeader(sync_run_id=run.id,sync_item_id=item.id if item else None,master_air_waybill_id=mawb.id,crm_manifest_id=manifest_id,parser_version=detail.parser_version,mawb_number=mawb.mawb_number,manifest_date=mawb.manifest_date,source_url=source_url,source_headers_json={'shipment':detail.original_row_headers},raw_values_json={k:str(v) if v is not None else '' for k,v in h.items()},source_checksum=detail.source_checksum,processing_status='imported' if created else 'updated',warning_messages=detail.warnings or None))
    _counter(run,'shipments_found',len(detail.rows));seen=set();field_map={'Bill Type':'bill_type','Shipper':'shipper_name','Consignee':'importer_name','Dest.':'import_country','Pay Term':'pay_term','Bill no.':'bill_number','AE':'ae_code','Delivery':'delivery_code'};num_map={'Act wt':'actual_weight','Pcs':'pieces','Dim wt':'dimensional_weight','Bill amt':'bill_amount','Gross amt':'gross_amount','Tarriff Rate':'tariff_rate'}
    for row in detail.rows:
        raw=row['raw'];tracking=normalized_tracking(raw['Tracking No.']);checksum=hashlib.sha256(json.dumps(raw,ensure_ascii=False,sort_keys=True).encode()).hexdigest();shipment=db.scalar(select(Shipment).where(Shipment.shipment_number==tracking));seen.add(tracking)
        if not shipment:shipment=Shipment(shipment_number=tracking,source='crm',mawb_id=mawb.id);db.add(shipment);db.flush();_counter(run,'shipments_created');_counter(item,'created_shipment_count')
        else:_counter(run,'shipments_updated');_counter(item,'updated_shipment_count')
        overrides=set(shipment.manual_override_fields or []);provenance=dict(shipment.crm_field_provenance or {})
        shipment.mawb_id=mawb.id;shipment.crm_source_url=source_url;shipment.crm_last_synced_at=now();shipment.crm_manifest_id=manifest_id;shipment.crm_manifest_direction=direction;shipment.crm_parser_version=detail.parser_version
        if 'shipment_date' not in overrides:shipment.shipment_date=mawb.manifest_date
        for src,target in field_map.items():
            if raw[src].strip() and target not in overrides:setattr(shipment,target,raw[src].strip());provenance[target]={'source':'crm','manifest_id':manifest_id,'updated_at':now().isoformat()}
        # Bill Type classifies shipment content (Document vs Non-Doc vs Letter) — unlike Pay
        # Term there's no safe inference for a blank value, so this only flags it. It falls
        # into the 'unclassified' bucket on /analytics/document-type until someone corrects
        # it in the CRM or via the Fix action here.
        if shipment.bill_type:
            for oi in db.scalars(select(DataQualityIssue).where(DataQualityIssue.shipment_id==shipment.id,DataQualityIssue.issue_type=='crm_missing_bill_type',DataQualityIssue.status=='open')).all():oi.status='resolved';oi.resolved_at=now();oi.resolved_by='crm_sync'
        else:
            issue(db,'crm_missing_bill_type',severity='warning',shipment_id=shipment.id,mawb_id=mawb.id,sync_run_id=run.id,sync_item_id=item.id if item else None,details_json={'tracking_number':tracking,'reason':'CRM Bill Type is blank — cannot classify as Document or Non-Document; counted in the unclassified bucket on document-type analytics'})
        for src,target in num_map.items():
            if row['parsed'][src] is not None:
                if target not in overrides:setattr(shipment,target,int(row['parsed'][src]) if target=='pieces' else row['parsed'][src]);provenance[target]={'source':'crm','manifest_id':manifest_id,'updated_at':now().isoformat()}
            elif raw[src].strip():issue(db,'crm_numeric_parse_error',shipment_id=shipment.id,mawb_id=mawb.id,sync_run_id=run.id,sync_item_id=item.id if item else None,details_json={'field':src})
        shipment.crm_field_provenance=provenance
        # Pay Term drives the revenue basis: only PP/FC/FD are billable. When the CRM leaves
        # Pay Term blank we infer it from Bill amt: a bill amount present means the shipment
        # was actually billed prepaid (PP); no bill amount means it wasn't billed (FC). This
        # is still flagged for review since it's an inference, not a CRM-supplied value.
        # See docs/03-data-rules.md §6b.
        if not raw['Pay Term'].strip() and 'pay_term' not in overrides:
            inferred='PP' if shipment.bill_amount else 'FC'
            shipment.pay_term=inferred;provenance['pay_term']={'source':'crm_inferred','manifest_id':manifest_id,'updated_at':now().isoformat()}
            shipment.crm_field_provenance=provenance
            issue(db,'crm_missing_pay_term',severity='warning',shipment_id=shipment.id,mawb_id=mawb.id,sync_run_id=run.id,sync_item_id=item.id if item else None,details_json={'tracking_number':tracking,'bill_amount':str(shipment.bill_amount or 0),'inferred_pay_term':inferred,'reason':f'CRM Pay Term is blank; inferred as {inferred} from bill amount presence and counted as revenue accordingly'})
        icris_value=extract_icris_from_tracking(tracking) or raw['Icrisno']
        result=link_icris(db,shipment,icris_value,raw['Shipper'],run,item)
        if result=='missing':_counter(run,'missing_icris');_counter(item,'blank_icris_count')
        db.add(CrmRawManifestRow(sync_run_id=run.id,sync_item_id=item.id if item else None,master_air_waybill_id=mawb.id,shipment_id=shipment.id,crm_manifest_id=manifest_id,parser_version=detail.parser_version,source_row_number=row['source_row_number'],tracking_number=tracking,source_icris_number=raw['Icrisno'].strip() or None,source_headers_json=detail.original_row_headers,raw_values_json=raw,source_checksum=checksum,processing_status='warning' if row['warnings'] else 'imported',warning_messages=row['warnings'] or None))
    if reconciliation['mismatches']:issue(db,'crm_manifest_total_mismatch',mawb_id=mawb.id,sync_run_id=run.id,sync_item_id=item.id if item else None,details_json=reconciliation)
    _counter(run,'warnings_count',len(detail.warnings)+len(reconciliation['mismatches']))
    if item:item.parsed_row_count=len(detail.rows);item.imported_row_count=len(detail.rows);item.warning_count=len(detail.warnings)+len(reconciliation['mismatches']);item.duplicate_row_count=detail.duplicate_row_count;item.source_checksum=detail.source_checksum;item.parser_version=detail.parser_version;item.metrics_json={'reconciliation':reconciliation}
    return mawb
def upsert_pnl(db:Session,report,source_url='',dry_run=False):
    """Match each P&L row onto an existing MasterAirWaybill by mawb_number (never creates
    MAWBs — manifests remain the sole source of MAWB existence, per docs/03-data-rules.md).
    Returns counters; writes nothing when dry_run."""
    stats={'matched':0,'unmatched':0,'ambiguous':0,'total_rows':len(report.rows)}
    if dry_run:return stats
    for row in report.rows:
        mawb_number=row['mawb'].strip()
        candidates=db.scalars(select(MasterAirWaybill).where(MasterAirWaybill.mawb_number==mawb_number)).all()
        target=None
        if len(candidates)==1:target=candidates[0]
        elif len(candidates)>1:
            same_date=[c for c in candidates if row['manifest_date'] and c.manifest_date==row['manifest_date']]
            if len(same_date)==1:target=same_date[0]
        if not target:
            stats['ambiguous' if candidates else 'unmatched']+=1;continue
        target.pnl_bill_amount=row['bill_amount'];target.pnl_ups_bill_amount=row['ups_bill_amount'];target.pnl_profit_loss=row['profit_loss']
        target.pnl_source_checksum=report.source_checksum;target.pnl_synced_at=now()
        stats['matched']+=1
    return stats
def _detect_pushed_followups(old_items,new_rows,today):
    """Flags deals that were overdue and unresolved in the previous snapshot but reappear in
    the new one with a later Expected Date and still no Win/Loss recorded — i.e. the date got
    pushed out instead of the deal actually being followed up and closed. Matched by (company
    name, AE, country) since the CRM page has no stable row ID; a key that matches more than
    one old row is ambiguous and skipped rather than guessed at, since a false accusation here
    is worse than a missed one."""
    from collections import defaultdict
    old_by_key=defaultdict(list)
    for item in old_items:
        if item.expected_date<today and not (item.win_loss or '').strip():
            key=(item.company_name.strip().casefold(),item.ae_code or '',(item.country or '').strip().casefold())
            old_by_key[key].append(item)
    if not old_by_key:return []
    pushes=[];seen_keys=set()
    for row in new_rows:
        key=(row['Company Name'].strip().casefold(),(row['AE'] or '').strip(),(row['Country'] or '').strip().casefold())
        candidates=old_by_key.get(key)
        if not candidates or len(candidates)!=1 or key in seen_keys:continue
        old=candidates[0]
        if (row['Win/Loss'] or '').strip():continue  # actually resolved, not pushed — not what we're flagging
        if row['expected_date']<=old.expected_date:continue  # not pushed later
        seen_keys.add(key)
        pushes.append({'company_name':old.company_name,'ae_code':old.ae_code,'old_expected_date':old.expected_date,'new_expected_date':row['expected_date'],'revenue_usd':row['revenue_usd'] or old.revenue_usd,'icris_number':(row['Acc No'] or '').strip() or old.icris_number})
    return pushes

PIPELINE_SNAPSHOT_MIN_RATIO=0.4  # ponytail: heuristic collapse threshold, tune if it false-positives on a real quiet week
def run_active_pipeline_sync(db:Session,html,source_url='',dry_run=False,worker_id=None):
    """Run-tracked wrapper around sync_active_pipeline — the single path both the manual sync
    route and the scheduled worker call, so every Active Pipeline sync attempt (success or
    failure) leaves a CrmSyncRun behind and is visible in /crm-sync/runs like every other sync,
    instead of being invisible fire-and-forget.
    """
    from .crm_connector import looks_like_login,SessionExpired
    from .crm_parser import parse_active_pipeline_list,CrmParseError,PIPELINE_PARSER_VERSION
    run=CrmSyncRun(sync_type='pipeline',status='running',direction='pipeline',dry_run=dry_run,started_at=now(),worker_id=worker_id,discovery_checkpoint={'parser_version':PIPELINE_PARSER_VERSION})
    db.add(run);db.flush()
    # The failure branches below commit the run record before raising — the exception is about
    # to unwind through a caller that will roll back the rest of the transaction, and the whole
    # point of tracking this run is that the failure itself stays visible in /crm-sync/runs.
    if looks_like_login(html,source_url):
        run.status='failed';run.completed_at=now();run.error_message='CRM session expired — Active Pipeline page returned a login form instead of data'
        db.commit();raise SessionExpired(run.error_message)
    try:
        rows=parse_active_pipeline_list(html,source_url)
    except CrmParseError as exc:
        run.status='failed';run.completed_at=now();run.error_message=str(exc)[:500]
        db.commit();raise
    old_count=db.scalar(select(func.count()).select_from(PipelineItem)) or 0
    # A drastic row-count collapse (most of a populated pipeline vanishing between two scrapes,
    # a few minutes apart) reads the same as a partially-rendered page as an empty one does —
    # sync_active_pipeline only refuses a fully-empty snapshot, so this catches the case where a
    # damaged page still yields a handful of real-looking rows and would otherwise sail through.
    if rows and old_count>=5 and len(rows)<old_count*PIPELINE_SNAPSHOT_MIN_RATIO:
        run.status='completed_with_errors';run.completed_at=now();run.warnings_count=1
        run.error_message=f'suspicious snapshot: {len(rows)} rows vs {old_count} previously on file — not applied, existing rows retained'
        return run
    stats=sync_active_pipeline(db,rows,dry_run=dry_run)
    run.shipments_found=stats['total_rows']
    if stats.get('skipped_empty'):
        run.status='completed_with_errors';run.warnings_count=1
        run.error_message=f"empty snapshot — {stats['retained_rows']} existing rows retained"
    else:
        run.status='completed'
        if stats.get('date_pushed_count'):run.warnings_count=stats['date_pushed_count']
    run.completed_at=now()
    return run

def sync_active_pipeline(db:Session,rows,dry_run=False):
    """Replace the pipeline_items table with the current CRM Active Pipeline snapshot.

    Whole-table replace, not an upsert: the source page has no stable per-row identifier
    (a row is identified only by its position in the grid) and it represents "current state"
    rather than a history log, so truncate-and-reinsert is both simpler and correct here.

    Before truncating, this diffs the outgoing snapshot against the incoming one to catch a
    deal whose Expected Date was overdue and unresolved, then reappears with a *later* date
    and still no Win/Loss — i.e. quietly pushed out rather than actually followed up. That
    evidence only exists for the instant between fetch and delete, so it's captured here as a
    persistent DataQualityIssue rather than left to the (stateless, replace-only) pipeline
    table to lose on the next sync.
    """
    stats={'total_rows':len(rows)}
    old_items=db.scalars(select(PipelineItem)).all()
    # Robustness guard: this is a truncate-and-replace against a scraped source. A broken or
    # partially-rendered CRM page (or a timed-out session that still parses to a valid header
    # with zero data rows) would otherwise silently wipe the whole pipeline AND destroy the
    # baseline the date-pushed detector needs on the next run. Refuse to replace existing rows
    # with an empty snapshot; report it as a skip so the caller can surface it.
    if not rows and old_items:
        stats['skipped_empty']=True;stats['retained_rows']=len(old_items);return stats
    if dry_run:return stats
    today=date.today()
    pushes=_detect_pushed_followups(old_items,rows,today)
    stamp=now();db.query(PipelineItem).delete()
    for row in rows:
        db.add(PipelineItem(expected_date=row['expected_date'],company_name=row['Company Name'].strip(),icris_number=row['Acc No'].strip() or None,country=row['Country'].strip() or None,weight_kg=row['weight_kg'],revenue_usd=row['revenue_usd'],pieces=row['pieces'],category=row['Category'].strip() or None,ae_code=row['AE'].strip() or None,win_loss=row['Win/Loss'].strip() or None,remarks=row['Remarks'].strip() or None,source_detail_ref=row.get('detail_ref') or None,scraped_at=stamp))
    for p in pushes:
        days_pushed=(p['new_expected_date']-p['old_expected_date']).days
        company=exact_company(db,p['icris_number']) if p['icris_number'] else None
        severity='high' if days_pushed>14 or (p['revenue_usd'] or 0)>1000 else 'medium'
        db.add(DataQualityIssue(issue_type='pipeline_date_pushed',severity=severity,company_id=company.id if company else None,source_icris_number=p['icris_number'],source_company_name=p['company_name'],details_json={'ae_code':p['ae_code'],'old_expected_date':p['old_expected_date'].isoformat(),'new_expected_date':p['new_expected_date'].isoformat(),'days_pushed':days_pushed,'revenue_usd':float(p['revenue_usd']) if p['revenue_usd'] else None}))
    stats['date_pushed_count']=len(pushes)
    return stats

def _call_log_hash(row):
    key='|'.join([row['crm_customer_id'] or '',row['call_date'].isoformat(),row['AE'].strip(),row['Call Type'].strip(),row['Contact Person'].strip(),row['Remarks'].strip()])
    return hashlib.sha256(key.encode()).hexdigest()

def sync_daily_call_logs(db:Session,rows,dry_run=False):
    """Insert new CRM_DairyAEList ('Daily Call Logs') rows, skipping ones already stored.

    Unlike sync_active_pipeline this is an append-only log, not a current-state snapshot —
    each row is a distinct call event, and the scheduled fetch re-pulls an overlapping
    trailing window each run (nothing on the source page identifies a row uniquely), so
    dedup is by a content hash rather than truncate-and-reinsert.
    """
    stats={'total_rows':len(rows)}
    if dry_run:return stats
    hashes=[_call_log_hash(row) for row in rows]
    existing=set(db.scalars(select(DailyCallLog.source_row_hash).where(DailyCallLog.source_row_hash.in_(hashes))))
    stamp=now();inserted=0
    for row,h in zip(rows,hashes):
        if h in existing:continue
        company_name=row['Company Name'].strip()
        db.add(DailyCallLog(call_date=row['call_date'],company_name=company_name,normalized_company_name=normalize_name(company_name),crm_customer_id=row['crm_customer_id'] or None,stage=row['Stage'].strip() or None,category=row['Category'].strip() or None,contact_person=row['Contact Person'].strip() or None,phone=row['Phone No'].strip() or None,call_type=row['Call Type'].strip() or None,ae_code=row['AE'].strip() or None,remarks=row['Remarks'].strip() or None,supervisor_comment=row['Supervisor Comment'].strip() or None,follow_up_date=row['follow_up_date'],source_row_hash=h,scraped_at=stamp))
        existing.add(h);inserted+=1
    stats['inserted_count']=inserted
    return stats

UPS_FIELD_MAP={'Bill Amount':'pnl_bill_amount','UPS Discount%':'pnl_ups_discount_percent','UPS BillAmt':'pnl_ups_bill_amount','Profit/Loss':'pnl_profit_loss'}
def upsert_ups_detail(db:Session,detail,mawb_number,manifest_date,crm_record_id=None,dry_run=False):
    """Write per-shipment UPS profit/loss from S_MenifestPrevUPS onto existing shipments.

    Matches shipments by exact trimmed tracking number and MAWBs by (number, date) — it never
    creates either, since the manifest sync remains the sole source of their existence
    (docs/03-data-rules.md rules 7 and 7b). Blank source cells are left as NULL rather than
    written as zero, and manual field overrides are respected.
    """
    stats={'total_rows':len(detail.rows),'matched':0,'unmatched':0,'mawb_matched':0,'mawb_unmatched':0}
    if dry_run:return stats
    mawb=db.scalar(select(MasterAirWaybill).where(MasterAirWaybill.mawb_number==str(mawb_number).strip(),MasterAirWaybill.manifest_date==manifest_date))
    if mawb:
        stats['mawb_matched']=1
        if detail.total:
            for key,column in (('bill_amount','pnl_bill_amount'),('ups_bill_amount','pnl_ups_bill_amount'),('profit_loss','pnl_profit_loss')):
                if detail.total.get(key) is not None:setattr(mawb,column,detail.total[key])
            mawb.pnl_source_checksum=detail.source_checksum;mawb.pnl_synced_at=now()
        mawb.ups_crm_record_id=str(crm_record_id) if crm_record_id else mawb.ups_crm_record_id
        mawb.ups_detail_synced_at=now()
    else:
        stats['mawb_unmatched']=1
    for row in detail.rows:
        tracking=normalized_tracking(row['tracking_number'])
        shipment=db.scalar(select(Shipment).where(Shipment.shipment_number==tracking))
        if not shipment:
            stats['unmatched']+=1;continue
        overrides=set(shipment.manual_override_fields or [])
        for source,column in UPS_FIELD_MAP.items():
            value=row['parsed'].get(source)
            if value is not None and column not in overrides:setattr(shipment,column,value)
        bill_number=(row['raw'].get('Bill Number') or '').strip()
        if bill_number and bill_number!='0' and 'pnl_bill_number' not in overrides:shipment.pnl_bill_number=bill_number
        shipment.pnl_synced_at=now()
        stats['matched']+=1
    return stats
def rematch(db):
    result={'matched':0,'missing':0,'manual_preserved':0,'companies_created':0}
    for shipment in db.scalars(select(Shipment).where(Shipment.source_icris_number.is_not(None))).all():
        if shipment.manually_matched or shipment.is_manually_matched:result['manual_preserved']+=1;continue
        before=db.scalar(select(func.count()).select_from(Company));out=link_icris(db,shipment,shipment.source_icris_number,shipment.source_customer_name or shipment.shipper_name);after=db.scalar(select(func.count()).select_from(Company));result['companies_created']+=after-before;result['matched' if out=='matched' else 'missing']+=1
    return result
