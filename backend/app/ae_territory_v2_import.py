"""Adapter for the "Finalv2.xlsx" AE Territory Assignment shape: one sheet per AE
(Ankit, Prakash, Pratik, Namuna, SLR, "DN (Key & Central)", "AJ (Key & Central)",
"RT (Key & Central)") with columns S.N. | Customer Name | Location | Customer Code,
plus a "Total: N customers" footer row per sheet and a Summary sheet.

ae_imports.py's parser expects a single flat sheet with an explicit "Account Executive"
column (the format its docstring calls "AE Territory Assignment"). This file carries the
same information but with the AE implied by the sheet tab instead of a column — so this
adapter flattens the 8 sheets into that same row shape (reusing normalize_ae_value to
resolve each sheet name, "DN (Key & Central)" included, to a roster code) and hands off
to ae_imports.analyze()/_reassign_company() so every safety property (audit log, override
locking, blank-never-erases) is identical to the existing AE import path.
"""
from pathlib import Path
from openpyxl import load_workbook

from .ae_imports import normalize_ae_value
from .utils import normalize_icris

DATA_HEADER = ('S.N.', 'Customer Name', 'Location', 'Customer Code')


class AeTerritoryV2Error(ValueError):
    pass


def _clean(value):
    if value is None:
        return ''
    return str(value).replace(' ', ' ').strip()


def _find_header_row(ws, max_scan=10):
    for i, row in enumerate(ws.iter_rows(min_row=1, max_row=max_scan, values_only=True), 1):
        cells = tuple(_clean(c) for c in row[:4])
        if cells == DATA_HEADER:
            return i
    return None


def parse_workbook(path_or_bytes, filename='Finalv2.xlsx'):
    if Path(filename).suffix.casefold() not in {'.xlsx', '.xlsm'}:
        raise AeTerritoryV2Error('AE territory file must be an .xlsx workbook')
    workbook = load_workbook(path_or_bytes, read_only=True, data_only=True)
    ae_sheets = [s for s in workbook.sheetnames if s.casefold() != 'summary']
    if not ae_sheets:
        raise AeTerritoryV2Error(f'No per-AE sheets found (only: {workbook.sheetnames})')

    rows = []
    sheet_report = []
    global_row_number = 1  # synthetic row numbers, unique across the flattened set
    for sheet_name in ae_sheets:
        ws = workbook[sheet_name]
        header_row = _find_header_row(ws)
        if header_row is None:
            sheet_report.append({'sheet': sheet_name, 'error': f'Header row {DATA_HEADER} not found'})
            continue
        ae_code, ae_label = normalize_ae_value(sheet_name)
        count = 0
        for raw in ws.iter_rows(min_row=header_row + 1, values_only=True):
            sn, name, location, code = (raw + (None, None, None, None))[:4]
            if not any([sn, name, location, code]):
                continue
            if isinstance(sn, str) and sn.strip().casefold().startswith('total'):
                continue
            global_row_number += 1
            count += 1
            rows.append({
                'row_number': global_row_number, 'ae_raw': sheet_name, 'ae_code': ae_code, 'ae_label': ae_label,
                'customer_name': _clean(name), 'location': _clean(location),
                'icris_raw': _clean(code), 'normalized_icris': normalize_icris(_clean(code)),
            })
        sheet_report.append({'sheet': sheet_name, 'ae_code': ae_code, 'rows': count})

    return {'file_name': Path(filename).name, 'worksheet_name': '+'.join(ae_sheets),
            'headers': list(DATA_HEADER), 'rows': rows, 'sheet_report': sheet_report}
