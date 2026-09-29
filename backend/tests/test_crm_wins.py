from datetime import date

from sqlalchemy import func, select

from app.crm_parser import WIN_HEADERS, parse_wins
from app.crm_sync import sync_wins
from app.db import SessionLocal
from app.models import CrmWin

# Same split layout as the real CRM_Win.aspx: totals + headers in tbl_Header, rows in tbl_Quotation.
_TD = lambda vals: '<tr>' + ''.join(f'<td>{v}</td>' for v in vals) + '</tr>'
HTML = f'''<html><body>
<table id="MainContent_tbl_Header">{_TD(['', '', '3', '600'] + [''] * 15)}{_TD(WIN_HEADERS)}</table>
<table id="MainContent_tbl_Quotation">
{_TD(['1', '<a href="S_Entry2.aspx?ID2=976">09/23/2026</a>', 'Acme Rugs', '300', '2960', '10', '4.5', '81.37', '1', '', '', '', '', '', '379', 'LA', '98000', 'RT', 'Win with rate'])}
{_TD(['2', '09/21/2026', 'Beta Med', '100', '2250', '5', '', '', '', '', '', '', '', '', '2', 'IFC', '98111', 'PS', ''])}
{_TD(['3', '', 'No Date Co', '1', '1', '1', '', '', '', '', '', '', '', '', '', '', '', 'PS', ''])}
</table></body></html>'''


def test_parse_wins_reads_split_table_and_customer_id():
    rows = parse_wins(HTML)
    assert [r['Company Name'] for r in rows] == ['Acme Rugs', 'Beta Med']  # blank Win Date dropped
    assert rows[0]['win_date'] == date(2026, 9, 23)
    assert rows[0]['crm_customer_id'] == '976'
    assert rows[0]['pieces'] == 10 and float(rows[0]['revenue_usd']) == 2960
    assert rows[1]['crm_customer_id'] == '' and rows[1]['AE'] == 'PS'


def test_sync_wins_replaces_table_and_keeps_it_on_empty_fetch(client):
    db = SessionLocal()
    try:
        db.add(CrmWin(win_date=date(2020, 1, 1), company_name='Stale Co', ae_code='XX'))
        db.flush()
        assert sync_wins(db, parse_wins(HTML))['inserted_count'] == 2
        db.flush()
        assert db.scalar(select(func.count()).select_from(CrmWin)) == 2
        assert sync_wins(db, [])['inserted_count'] == 0
        assert db.scalar(select(func.count()).select_from(CrmWin)) == 2
    finally:
        db.rollback()
        db.close()
