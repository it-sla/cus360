from io import BytesIO
from openpyxl import Workbook
from sqlalchemy import select
from app.ae_targets import extract_ae_code, import_ae_targets, parse_month, parse_workbook
from app.db import SessionLocal
from app.models import AccountExecutive, AeTarget

FLAT_HEADERS = ('Year', 'AE', 'MONTH', 'Weight', 'Piece', 'Revenue', 'Weight_Imp', 'Piece_Imp', 'Revenue_Imp')

def workbook(rows, sheet_title='All_AE_Flat'):
    book = Workbook(); ws = book.active; ws.title = sheet_title; ws.append(FLAT_HEADERS)
    for row in rows: ws.append(row)
    out = BytesIO(); book.save(out); return out.getvalue()

def ensure_ae(db, code):
    if not db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code == code)):
        db.add(AccountExecutive(ae_code=code, is_active=True)); db.commit()

def test_extract_ae_code_takes_last_token():
    known = {'AS', 'PR'}
    assert extract_ae_code('Ankit Shrestha AS', known) == ('AS', 'Ankit Shrestha AS')
    assert extract_ae_code('Prakash Regmi PR', known) == ('PR', 'Prakash Regmi PR')
    assert extract_ae_code('Someone ZZ', known) == (None, 'Someone ZZ')
    assert extract_ae_code('', known) == (None, '')

def test_parse_month_accepts_name_and_number():
    assert parse_month('January') == 1
    assert parse_month('Dec') == 12
    assert parse_month('7') == 7
    assert parse_month('Nonsense') is None
    assert parse_month('13') is None

def test_parse_workbook_reads_flat_sheet():
    data = workbook([(2026, 'Ankit Shrestha AS', 'January', 4032, 275, 42000, 0, 0, 0)])
    parsed = parse_workbook(data, 'AE_Targets_2026.xlsx')
    assert parsed['worksheet_name'] == 'All_AE_Flat'
    assert len(parsed['rows']) == 1
    row = parsed['rows'][0]
    assert row['ae_raw'] == 'Ankit Shrestha AS'; assert row['weight'] == 4032; assert row['revenue'] == 42000

def test_import_creates_then_updates_idempotently():
    db = SessionLocal()
    try:
        ensure_ae(db, 'AS')
        # Use a far-future year so this never collides with a real AS/2026 target row —
        # this test intentionally does NOT commit (see finally) so it can't leak either way.
        stale = db.scalar(select(AeTarget).where(AeTarget.ae_code == 'AS', AeTarget.year == 2099, AeTarget.month == 1))
        if stale: db.delete(stale); db.flush()
        data = workbook([(2099, 'Ankit Shrestha AS', 'January', 4032, 275, 42000, 0, 0, 0)])
        first = import_ae_targets(db, data, 'AE_Targets_2026.xlsx')
        db.flush()
        assert first['created'] == 1 and first['updated'] == 0 and first['unknown_ae_count'] == 0
        target = db.scalar(select(AeTarget).where(AeTarget.ae_code == 'AS', AeTarget.year == 2099, AeTarget.month == 1))
        assert target and target.weight_target == 4032 and target.revenue_target == 42000 and target.source == 'import'

        data2 = workbook([(2099, 'Ankit Shrestha AS', 'January', 5000, 300, 50000, 0, 0, 0)])
        second = import_ae_targets(db, data2, 'AE_Targets_2026.xlsx')
        assert second['created'] == 0 and second['updated'] == 1
        db.flush(); assert target.weight_target == 5000 and target.revenue_target == 50000
    finally:
        db.rollback(); db.close()

def test_import_flags_unknown_ae_without_creating_row():
    db = SessionLocal()
    try:
        data = workbook([(2026, 'Some Person ZZ', 'January', 100, 10, 1000, 0, 0, 0)])
        stats = import_ae_targets(db, data, 'AE_Targets_2026.xlsx')
        assert stats['created'] == 0 and stats['unknown_ae_count'] == 1
        assert stats['unknown_ae_values'] == ['Some Person ZZ']
    finally:
        db.rollback(); db.close()

def test_import_flags_invalid_month():
    db = SessionLocal()
    try:
        ensure_ae(db, 'AS')
        data = workbook([(2026, 'Ankit Shrestha AS', 'Not A Month', 100, 10, 1000, 0, 0, 0)])
        stats = import_ae_targets(db, data, 'AE_Targets_2026.xlsx')
        assert stats['created'] == 0 and stats['invalid_row_count'] == 1
    finally:
        db.rollback(); db.close()
