from datetime import date
from decimal import Decimal
from pathlib import Path
import pytest
from app.crm_parser import parse_pnl_grid, CrmParseError, LoginRequired
FIX=Path(__file__).parent/'fixtures'
def read(name):return (FIX/name).read_text()

def test_grid_rows_and_total_parsed():
    r=parse_pnl_grid(read('crm_pnl_grid.html'))
    assert len(r.rows)==2
    assert r.rows[0]['mawb']=='16014396126'
    assert r.rows[0]['manifest_date']==date(2026,8,9)
    assert r.rows[0]['bill_amount']==Decimal('964.89')
    assert r.rows[0]['ups_bill_amount']==Decimal('496.22')
    assert r.rows[0]['profit_loss']==Decimal('468.67')
    assert r.rows[1]['bill_amount']==Decimal('11183.32')
    assert r.total=={'bill_amount':Decimal('12148.21'),'ups_bill_amount':Decimal('6805.57'),'profit_loss':Decimal('5342.64')}
    assert not r.warnings

def test_empty_range_is_not_an_error():
    r=parse_pnl_grid(read('crm_pnl_empty.html'))
    assert r.rows==[]
    assert r.total is None
    assert 'no rows' in r.warnings[0]

def test_changed_structure_raises():
    with pytest.raises(CrmParseError):
        parse_pnl_grid(read('crm_pnl_changed.html'))

def test_login_bounce_detected():
    with pytest.raises(LoginRequired):
        parse_pnl_grid(read('crm_login.html'))

def test_checksum_stable_for_identical_input_and_differs_on_change():
    r1=parse_pnl_grid(read('crm_pnl_grid.html'))
    r2=parse_pnl_grid(read('crm_pnl_grid.html'))
    assert r1.source_checksum==r2.source_checksum
    changed=read('crm_pnl_grid.html').replace('468.67','999.99')
    r3=parse_pnl_grid(changed)
    assert r3.source_checksum!=r1.source_checksum
