from datetime import date
from pathlib import Path
import pytest
from app.crm_parser import *
FIX=Path(__file__).parent/'fixtures'
def read(name):return (FIX/name).read_text()
def test_manifest_list_and_explicit_dates():
    rows=parse_manifest_list(read('crm_manifest_list.html'));assert len(rows)==2;assert rows[0]['MAWB']=='R1100X';assert rows[0]['manifest_date']==date(2026,7,14);assert rows[1]['detail_ref']=='/manifest/2'
def test_detail_header_totals_rows_and_exact_headers():
    d=parse_manifest_detail(read('crm_manifest_detail.html'));assert d.header['MAWB']=='R1100X';assert d.header['manifest_date']==date(2026,7,14);assert d.totals['pp_weight']==Decimal('10.5');assert d.totals['fc_pieces']==Decimal('1');assert len(d.rows)==3;assert list(d.rows[0]['raw'])==ROW_HEADERS;assert d.rows[1]['raw']['Pay Term']=='';assert d.rows[0]['parsed']['Pcs']==2
def test_login_and_changed_structure_detected():
    with pytest.raises(LoginRequired):parse_manifest_list(read('crm_login.html'))
    with pytest.raises(CrmParseError):parse_manifest_list(read('crm_changed.html'))
def test_invalid_date_rejected():
    with pytest.raises(CrmParseError):parse_date('14/07/2026')
def test_invalid_number_warns_without_zero():
    d=parse_manifest_detail(read('crm_invalid_numeric.html'));assert d.rows[0]['parsed']['Act wt'] is None;assert 'Invalid numeric value' in d.warnings[0]
def test_empty_detail_is_visible_warning():
    d=parse_manifest_detail(read('crm_empty.html'));assert not d.rows;assert 'no shipment rows' in d.warnings[-1]
def test_sanitized_live_export_structure_and_source_typo():
    d=parse_manifest_detail(read('crm_export_live_structure.html'));assert d.header['MAWB']=='SANITIZED-MAWB';assert d.header['Fuel Surcharge']=='0';assert d.totals['pp_weight']==Decimal('1.5');assert list(d.rows[0]['raw'])==ROW_HEADERS;assert d.rows[0]['parsed']['Dim wt'] is None
def test_misaligned_header_row_flags_leaked_label_as_warning():
    html=read('crm_manifest_detail.html').replace('<td>TO</td><td>DEL</td>','<td>TO</td><td>Exchange Rate: 132.500000</td>')
    d=parse_manifest_detail(html)
    assert d.header['TO']=='Exchange Rate: 132.500000'
    assert any('TO header value looks corrupted' in w for w in d.warnings)
def test_well_formed_header_row_never_flagged():
    d=parse_manifest_detail(read('crm_manifest_detail.html'))
    assert not any('header value looks corrupted' in w for w in d.warnings)
def test_parse_active_pipeline_list():
    html='''<table>
    <tr><td>S.no.</td><td>Expected Date</td><td>Company Name</td><td>Acc No</td><td>Country</td><td>Weight(kg)</td><td>Revenue($)</td><td>PCS</td><td>Category</td><td>AE</td><td>Win/Loss</td><td>Remarks</td></tr>
    <tr><td>1</td><td>08/05/2026</td><td><a href="/Customer/View.aspx?ID=1">Trust Craft</a></td><td>7257X3</td><td>US</td><td>62</td><td>792</td><td>1</td><td>SME</td><td>PR</td><td></td><td></td></tr>
    <tr><td>7</td><td>08/13/2026</td><td>Kathmandu Village Rugs</td><td></td><td>US</td><td>67</td><td>841</td><td>1</td><td>SME</td><td>AS</td><td></td><td></td></tr>
    </table>'''
    rows=parse_active_pipeline_list(html,'http://crm.example')
    assert len(rows)==2
    assert rows[0]['Company Name']=='Trust Craft';assert rows[0]['Acc No']=='7257X3';assert rows[0]['expected_date']==date(2026,8,5)
    assert rows[0]['weight_kg']==Decimal('62');assert rows[0]['revenue_usd']==Decimal('792');assert rows[0]['pieces']==1
    assert rows[0]['detail_ref']=='http://crm.example/Customer/View.aspx?ID=1'
    assert rows[1]['Acc No']==''
def test_parse_active_pipeline_list_skips_blank_expected_date():
    html='''<table>
    <tr><td>S.no.</td><td>Expected Date</td><td>Company Name</td><td>Acc No</td><td>Country</td><td>Weight(kg)</td><td>Revenue($)</td><td>PCS</td><td>Category</td><td>AE</td><td>Win/Loss</td><td>Remarks</td></tr>
    <tr><td>1</td><td></td><td>No Date Co</td><td></td><td>US</td><td>1</td><td>1</td><td>1</td><td>SME</td><td>PR</td><td></td><td></td></tr>
    </table>'''
    assert parse_active_pipeline_list(html)==[]
def test_parse_active_pipeline_list_header_and_data_in_separate_tables():
    """Regression test for the live page's actual structure: the header lives alone in one
    <table> and the data rows are in the very next <table>, unlike the manifest list where
    both share a table. Verified against real CRM output on 2026-08-12."""
    html='''<table><tr><td>S.no.</td><td>Expected Date</td><td>Company Name</td><td>Acc No</td><td>Country</td><td>Weight(kg)</td><td>Revenue($)</td><td>PCS</td><td>Category</td><td>AE</td><td>Win/Loss</td><td>Remarks</td></tr></table>
    <table>
    <tr><td>1</td><td>08/13/2026</td><td>Kathmandu Village Rugs</td><td></td><td>US</td><td>67</td><td>841</td><td>1</td><td>SME</td><td>PS</td><td></td><td></td></tr>
    <tr><td>2</td><td>08/14/2026</td><td><a href="/Customer/View.aspx?ID=2">UNIQUE GALAINCHA STUDIO</a></td><td>853R8F</td><td>US</td><td>100</td><td>800</td><td>4</td><td>SME</td><td>PR</td><td></td><td></td></tr>
    </table>'''
    rows=parse_active_pipeline_list(html,'http://crm.example')
    assert len(rows)==2
    assert rows[0]['Company Name']=='Kathmandu Village Rugs';assert rows[0]['Acc No']==''
    assert rows[1]['Acc No']=='853R8F';assert rows[1]['detail_ref']=='http://crm.example/Customer/View.aspx?ID=2'
