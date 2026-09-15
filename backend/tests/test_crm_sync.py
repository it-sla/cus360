from datetime import date
from decimal import Decimal
from pathlib import Path
import uuid
from sqlalchemy import func,select
from app.crm_parser import parse_manifest_detail,parse_pnl_grid
from app.crm_sync import link_icris,upsert_detail,upsert_pnl
from app.db import SessionLocal
from app.models import Company,CrmSyncRun,MasterAirWaybill,Package,Shipment
from app.utils import normalize_name
FIX=Path(__file__).parent/'fixtures'/'crm_manifest_detail.html'
def test_detail_upsert_is_idempotent_and_creates_provisional_company():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];detail=parse_manifest_detail(FIX.read_text());detail.header['MAWB']=f'MAWB-{suffix}'
    for n,row in enumerate(detail.rows):
        row['raw']['Tracking No.']=f'CRM-{suffix}-{n}';row['raw']['Icrisno']=f'ICRIS-{suffix}' if n<2 else ''
    try:
        run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush();first=upsert_detail(db,run,detail,'https://crm.invalid/detail');db.commit()
        assert db.scalar(select(func.count()).select_from(MasterAirWaybill).where(MasterAirWaybill.id==first.id))==1
        assert db.scalar(select(func.count()).select_from(Shipment).where(Shipment.shipment_number.like(f'CRM-{suffix}-%')))==3
        company=db.scalar(select(Company).where(func.lower(Company.icris_number)==f'icris-{suffix}'));assert company and company.is_provisional
        linked=db.scalars(select(Shipment).where(Shipment.shipment_number.like(f'CRM-{suffix}-%')).order_by(Shipment.shipment_number)).all();assert linked[0].company_id==linked[1].company_id;assert linked[2].match_status=='icris_missing'
        run2=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run2);db.flush();upsert_detail(db,run2,detail,'https://crm.invalid/detail');db.commit()
        assert db.scalar(select(func.count()).select_from(MasterAirWaybill).where(MasterAirWaybill.mawb_number==f'MAWB-{suffix}'))==1
        assert db.scalar(select(func.count()).select_from(Shipment).where(Shipment.shipment_number.like(f'CRM-{suffix}-%')))==3
    finally:db.close()
def test_manual_link_is_preserved_by_icris_linking():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8]
    try:
        manual=Company(icris_number=f'MAN-{suffix}',company_name='Manual Company',normalized_name=normalize_name('Manual Company'),source='manual');other=Company(icris_number=f'OTHER-{suffix}',company_name='Other Company',normalized_name=normalize_name('Other Company'),source='manual');db.add_all([manual,other]);db.flush()
        shipment=Shipment(shipment_number=f'MANUAL-{suffix}',company_id=manual.id,manually_matched=True,is_manually_matched=True,match_status='manually_linked',matched_by_method='manual');db.add(shipment);db.flush();assert link_icris(db,shipment,other.icris_number,'Other Company')=='manual';assert shipment.company_id==manual.id;db.rollback()
    finally:db.close()
def test_manual_shipment_date_override_is_preserved_but_others_still_sync():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];detail=parse_manifest_detail(FIX.read_text());detail.header['MAWB']=f'DATE-MAWB-{suffix}';detail.rows=detail.rows[:2]
    for n,row in enumerate(detail.rows):row['raw']['Tracking No.']=f'DATE-AWB-{suffix}-{n}';row['raw']['Icrisno']=f'DATE-ICRIS-{suffix}'
    try:
        pinned=date(2020,1,1)
        locked=Shipment(shipment_number=f'DATE-AWB-{suffix}-0',source='crm',shipment_date=pinned,manual_override_fields=['shipment_date'])
        free=Shipment(shipment_number=f'DATE-AWB-{suffix}-1',source='crm',shipment_date=pinned)
        db.add_all([locked,free]);db.flush()
        run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush();upsert_detail(db,run,detail,'https://crm.invalid/detail');db.flush()
        assert locked.shipment_date==pinned,'manual shipment_date override must not be overwritten by CRM sync'
        assert free.shipment_date==detail.header['manifest_date'],'shipment_date must still sync when it is not manually overridden'
        assert locked.mawb_id and free.mawb_id
        db.rollback()
    finally:db.close()
def test_existing_excel_shipment_and_packages_are_enriched_not_duplicated():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];detail=parse_manifest_detail(FIX.read_text());detail.header['MAWB']=f'EXCEL-MAWB-{suffix}';detail.rows=detail.rows[:1];detail.rows[0]['raw']['Tracking No.']=f'EXCEL-AWB-{suffix}';detail.rows[0]['raw']['Icrisno']=f'EXCEL-ICRIS-{suffix}'
    try:
        shipment=Shipment(shipment_number=f'EXCEL-AWB-{suffix}',source='manifest');db.add(shipment);db.flush();db.add(Package(shipment_id=shipment.id,package_id=f'EXCEL-PKG-{suffix}',piece_number=1));run=CrmSyncRun(sync_type='manifest_single',status='running');db.add(run);db.flush();upsert_detail(db,run,detail);db.commit()
        refreshed=db.scalar(select(Shipment).where(Shipment.shipment_number==f'EXCEL-AWB-{suffix}'));assert refreshed.id==shipment.id;assert refreshed.mawb_id;assert db.scalar(select(func.count()).select_from(Package).where(Package.shipment_id==refreshed.id))==1
    finally:db.close()
def test_pnl_matches_existing_mawb_by_number_and_updates_fields():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];mawb_number=f'PNL-{suffix}'
    try:
        mawb=MasterAirWaybill(mawb_number=mawb_number,manifest_date=date(2026,8,9));db.add(mawb);db.flush()
        html=(Path(__file__).parent/'fixtures'/'crm_pnl_grid.html').read_text().replace('16014396126',mawb_number)
        report=parse_pnl_grid(html)
        stats=upsert_pnl(db,report,source_url='https://crm.invalid/pnl');db.commit()
        assert stats['matched']==1;assert stats['unmatched']==1
        db.refresh(mawb)
        assert mawb.pnl_bill_amount==Decimal('964.89');assert mawb.pnl_ups_bill_amount==Decimal('496.22');assert mawb.pnl_profit_loss==Decimal('468.67')
        assert mawb.pnl_source_checksum==report.source_checksum and mawb.pnl_synced_at is not None
    finally:db.close()
def test_pnl_never_creates_a_mawb_for_an_unknown_number():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8]
    try:
        html=(Path(__file__).parent/'fixtures'/'crm_pnl_grid.html').read_text().replace('16014396126',f'GHOST-{suffix}').replace('16014396060',f'GHOST2-{suffix}')
        report=parse_pnl_grid(html)
        before=db.scalar(select(func.count()).select_from(MasterAirWaybill))
        stats=upsert_pnl(db,report,source_url='https://crm.invalid/pnl');db.commit()
        after=db.scalar(select(func.count()).select_from(MasterAirWaybill))
        assert stats['matched']==0;assert stats['unmatched']==2;assert before==after
    finally:db.close()
def test_pnl_ambiguous_mawb_number_across_two_manifest_dates_is_not_guessed():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];mawb_number=f'DUP-{suffix}'
    try:
        a=MasterAirWaybill(mawb_number=mawb_number,manifest_date=date(2025,1,1));b=MasterAirWaybill(mawb_number=mawb_number,manifest_date=date(2025,2,2));db.add_all([a,b]);db.flush()
        html=(Path(__file__).parent/'fixtures'/'crm_pnl_grid.html').read_text().replace('16014396126',mawb_number).replace('8/9/2026','9/9/2026')
        report=parse_pnl_grid(html)
        stats=upsert_pnl(db,report,source_url='https://crm.invalid/pnl');db.commit()
        assert stats['ambiguous']==1
        db.refresh(a);db.refresh(b)
        assert a.pnl_bill_amount is None and b.pnl_bill_amount is None
    finally:db.close()
def test_pnl_dry_run_writes_nothing():
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];mawb_number=f'DRY-{suffix}'
    try:
        mawb=MasterAirWaybill(mawb_number=mawb_number,manifest_date=date(2026,8,9));db.add(mawb);db.flush()
        html=(Path(__file__).parent/'fixtures'/'crm_pnl_grid.html').read_text().replace('16014396126',mawb_number)
        report=parse_pnl_grid(html)
        stats=upsert_pnl(db,report,source_url='https://crm.invalid/pnl',dry_run=True)
        assert stats['total_rows']==2
        db.refresh(mawb);assert mawb.pnl_bill_amount is None
    finally:db.rollback();db.close()
def test_ups_detail_writes_per_shipment_pnl_and_mawb_totals():
    from app.crm_parser import parse_ups_detail
    from app.crm_sync import upsert_ups_detail
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];mawb_number=f'UPS-{suffix}'
    try:
        mawb=MasterAirWaybill(mawb_number=mawb_number,manifest_date=date(2026,8,9));db.add(mawb);db.flush()
        html=(Path(__file__).parent/'fixtures'/'crm_ups_detail.html').read_text().replace('1ZSANITIZED0000000001',f'UPSAWB-{suffix}')
        detail=parse_ups_detail(html)
        shipment=Shipment(shipment_number=f'UPSAWB-{suffix}',source='crm');db.add(shipment);db.flush()
        stats=upsert_ups_detail(db,detail,mawb_number,date(2026,8,9),crm_record_id='2900');db.commit()
        assert stats['matched']==1 and stats['unmatched']==3 and stats['mawb_matched']==1
        db.refresh(shipment);db.refresh(mawb)
        assert shipment.pnl_bill_amount==Decimal('562.43')
        assert shipment.pnl_ups_discount_percent==Decimal('86.00')
        assert shipment.pnl_ups_bill_amount==Decimal('200.51')
        assert shipment.pnl_profit_loss==Decimal('361.92')
        assert shipment.pnl_bill_number=='615'
        assert shipment.pnl_synced_at is not None
        assert mawb.pnl_bill_amount==Decimal('588.78') and mawb.pnl_profit_loss==Decimal('368.16')
        assert mawb.ups_crm_record_id=='2900' and mawb.ups_detail_synced_at is not None
    finally:db.close()
def test_ups_detail_never_creates_shipments_or_mawbs():
    from app.crm_parser import parse_ups_detail
    from app.crm_sync import upsert_ups_detail
    db=SessionLocal();suffix=uuid.uuid4().hex[:8]
    try:
        before_s=db.scalar(select(func.count()).select_from(Shipment));before_m=db.scalar(select(func.count()).select_from(MasterAirWaybill))
        detail=parse_ups_detail((Path(__file__).parent/'fixtures'/'crm_ups_detail.html').read_text())
        stats=upsert_ups_detail(db,detail,f'GHOST-{suffix}',date(2026,8,9));db.commit()
        assert stats['mawb_unmatched']==1 and stats['matched']==0 and stats['unmatched']==4
        assert db.scalar(select(func.count()).select_from(Shipment))==before_s
        assert db.scalar(select(func.count()).select_from(MasterAirWaybill))==before_m
    finally:db.close()
def test_ups_detail_respects_manual_override_and_never_zeroes_blank_costs():
    from app.crm_parser import parse_ups_detail
    from app.crm_sync import upsert_ups_detail
    db=SessionLocal();suffix=uuid.uuid4().hex[:8]
    try:
        html=(Path(__file__).parent/'fixtures'/'crm_ups_detail.html').read_text().replace('1ZSANITIZED0000000001',f'OVR-{suffix}').replace('VSANITIZED0003',f'BLANK-{suffix}')
        detail=parse_ups_detail(html)
        pinned=Decimal('11.11')
        locked=Shipment(shipment_number=f'OVR-{suffix}',source='crm',pnl_bill_amount=pinned,manual_override_fields=['pnl_bill_amount'])
        blank=Shipment(shipment_number=f'BLANK-{suffix}',source='crm',pnl_ups_bill_amount=Decimal('7.77'))
        db.add_all([locked,blank]);db.flush()
        upsert_ups_detail(db,detail,f'NOMAWB-{suffix}',date(2026,8,9));db.flush()
        assert locked.pnl_bill_amount==pinned,'manual override must survive UPS sync'
        assert locked.pnl_ups_bill_amount==Decimal('200.51'),'non-overridden fields must still sync'
        assert blank.pnl_ups_bill_amount==Decimal('7.77'),'blank source cell must not erase an existing value'
        db.rollback()
    finally:db.close()

def test_well_formed_icris_not_in_master_creates_a_flagged_issue():
    """A well-formed ICRIS with no matching company creates a provisional record — that
    part is by design. What's new: it must also raise a distinct, reviewable
    crm_icris_not_in_master issue instead of doing this silently."""
    from app.models import DataQualityIssue
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];icris=f'NEWCO{suffix}'
    try:
        shipment=Shipment(shipment_number=f'NIM-{suffix}',source='crm');db.add(shipment);db.flush()
        result=link_icris(db,shipment,icris,'New Customer Co');db.flush()
        assert result not in ('missing','invalid'),'a well-formed ICRIS must not be flagged as blank/invalid'
        assert shipment.company_id is not None
        company=db.get(Company,shipment.company_id)
        assert company.is_provisional is True
        found=db.scalar(select(DataQualityIssue).where(DataQualityIssue.issue_type=='crm_icris_not_in_master',DataQualityIssue.company_id==company.id,DataQualityIssue.status=='open'))
        assert found is not None,'expected an open crm_icris_not_in_master issue for the new provisional company'
        db.rollback()
    finally:db.close()

def test_icris_not_in_master_issue_not_raised_when_company_already_exists():
    """The issue is specifically about newly-created provisional companies — matching an
    ICRIS that already has a real (or even pre-existing provisional) company record must
    not raise it again."""
    from app.models import DataQualityIssue
    db=SessionLocal();suffix=uuid.uuid4().hex[:8];icris=f'EXIST{suffix}'
    try:
        existing=Company(icris_number=icris,company_name='Existing Co',normalized_name=normalize_name('Existing Co'),source='manual');db.add(existing);db.flush()
        shipment=Shipment(shipment_number=f'EX-{suffix}',source='crm');db.add(shipment);db.flush()
        link_icris(db,shipment,icris,'Existing Co');db.flush()
        assert shipment.company_id==existing.id
        found=db.scalar(select(DataQualityIssue).where(DataQualityIssue.issue_type=='crm_icris_not_in_master',DataQualityIssue.company_id==existing.id))
        assert found is None
        db.rollback()
    finally:db.close()
