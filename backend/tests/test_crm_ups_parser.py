from datetime import date
from decimal import Decimal
from pathlib import Path
import pytest
from app.crm_parser import parse_ups_detail, parse_ups_list, UPS_ROW_HEADERS, CrmParseError, LoginRequired
FIX = Path(__file__).parent / 'fixtures'
def read(name): return (FIX / name).read_text()


def test_detail_rows_totals_and_exact_source_headers():
    d = parse_ups_detail(read('crm_ups_detail.html'))
    assert len(d.rows) == 4
    assert d.original_row_headers == UPS_ROW_HEADERS
    first = d.rows[0]
    assert first['tracking_number'] == '1ZSANITIZED0000000001'
    assert first['parsed']['Bill Amount'] == Decimal('562.43')
    assert first['parsed']['UPS Discount%'] == Decimal('86.00')
    assert first['parsed']['UPS BillAmt'] == Decimal('200.51')
    assert first['parsed']['Profit/Loss'] == Decimal('361.92')
    assert first['raw']['Icris No'] == '9E2926'
    assert d.total == {'bill_amount': Decimal('588.78'), 'ups_bill_amount': Decimal('235.66'), 'profit_loss': Decimal('368.16')}


def test_blank_cost_cells_parse_as_none_not_zero():
    """An unbilled shipment must not be recorded as $0 cost/profit — that would understate
    UPS cost and overstate margin. Blank stays NULL (docs/03-data-rules.md rule 5)."""
    d = parse_ups_detail(read('crm_ups_detail.html'))
    unbilled = next(r for r in d.rows if r['tracking_number'] == 'VSANITIZED0003')
    assert unbilled['parsed']['UPS BillAmt'] is None
    assert unbilled['parsed']['Profit/Loss'] is None
    assert unbilled['parsed']['UPS Discount%'] is None
    assert unbilled['parsed']['Bill Amount'] == Decimal('0.00')


def test_partially_costed_row_keeps_known_values_and_nulls_the_rest():
    d = parse_ups_detail(read('crm_ups_detail.html'))
    partial = next(r for r in d.rows if r['tracking_number'] == 'YSANITIZED0004')
    assert partial['parsed']['UPS Discount%'] == Decimal('87.70')
    assert partial['parsed']['UPS BillAmt'] == Decimal('15.04')
    assert partial['parsed']['Profit/Loss'] is None


def test_total_row_is_never_a_shipment():
    d = parse_ups_detail(read('crm_ups_detail.html'))
    assert all(not r['tracking_number'].lower().startswith('total') for r in d.rows)


def test_changed_structure_raises():
    with pytest.raises(CrmParseError):
        parse_ups_detail(read('crm_ups_changed.html'))


def test_login_bounce_detected():
    with pytest.raises(LoginRequired):
        parse_ups_detail(read('crm_login.html'))


def test_checksum_is_stable_and_change_sensitive():
    a = parse_ups_detail(read('crm_ups_detail.html'))
    b = parse_ups_detail(read('crm_ups_detail.html'))
    assert a.source_checksum == b.source_checksum
    changed = parse_ups_detail(read('crm_ups_detail.html').replace('361.92', '999.99'))
    assert changed.source_checksum != a.source_checksum


def test_list_yields_record_ids_dates_and_mawbs():
    rows = parse_ups_list(read('crm_ups_list.html'), 'http://crm.invalid/Sales_WebForms/')
    assert len(rows) == 3
    assert rows[0]['crm_record_id'] == '2901'
    assert rows[0]['MAWB'] == '16014396152'
    assert rows[0]['manifest_date'] == date(2026, 8, 10)
    assert rows[0]['detail_ref'] == 'http://crm.invalid/Sales_WebForms/S_MenifestPrevUPS.aspx?ID=2901'
    assert [r['crm_record_id'] for r in rows] == ['2901', '2900', '2899']
