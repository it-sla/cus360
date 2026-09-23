"""Transactional import for AE (Account Executive) territory assignment spreadsheets.

Mirrors the preview/commit structure of company_imports.py, but matches the exact
headers of the actual business file ("AE Territory Assignment") rather than requiring
the file to be reshaped to match this code:
  Account Executive | Customer Name | Location | Customer/ICRIS Code

The AE column mixes short codes ("SLR", "DN (Key & Central)") and first names
("Ankit", "Prakash", "Pratik", "Namuna"). NAME_TO_CODE is the confirmed mapping
(2026-08-10) — do not guess additional entries; an unrecognized value is reported
as "unknown AE" in the preview rather than silently coerced to a code.
"""
from collections import defaultdict
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from openpyxl import load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import AccountExecutive,ActivityLog,AeImportBatch,AeImportRow,AeReassignmentLog,Company,Shipment,now
from .utils import normalize_icris

class AeWorkbookError(ValueError):pass

REQUIRED_HEADERS=('Account Executive','Customer Name','Location','Customer/ICRIS Code')

# Confirmed 2026-08-10. Case-insensitive lookup; the sheet also carries bare codes
# ("SLR") and codes with a territory suffix ("DN (Key & Central)") handled separately.
NAME_TO_CODE={
    'ankit':'AS','prakash':'PR','pratik':'PS','namuna':'NT',
    'dinesh':'DN','rupesh':'RT','akrit':'AJ',
}

# Confirmed 2026-09-23: the 4 geographic AEs get a "Territory N" label, DN is "Resellers".
# SLR/AJ/RT stay unclassified (None) — user will divide AJ/RT later. Same map used by
# migration 20260923_0001 to seed existing rows; applied here too so any AE created fresh
# via import (a code never seen before) also gets the right territory_name.
TERRITORY_NAMES={
    'AS':'Territory 1 — North & West Kathmandu (Thamel to Sitapaila)',
    'PR':'Territory 2 — Northeast & East Kathmandu (Baneshwor to Boudha)',
    'PS':'Territory 3 — Southeast Kathmandu (Koteshwor to Kupondole)',
    'NT':'Territory 4 — Southwest Kathmandu (Kirtipur to Jawalakhel)',
    'DN':'Resellers',
}

def clean_header(value):return ' '.join(str(value or '').replace(' ',' ').split()).strip()
def clean_text(value):
    if value is None:return ''
    return str(value).replace(' ',' ').strip(' \t\r\n​‌‍⁠﻿')
def cell_text(cell):
    value=cell.value
    if value is None:return ''
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        fmt=(cell.number_format or '').split(';')[0]
        if isinstance(value,int) and fmt and set(fmt)<=set('0'):return str(value).zfill(len(fmt))
        return str(value)
    return clean_text(value)

def normalize_ae_value(raw:str)->tuple[str|None,str]:
    """Returns (resolved_code_or_None, display_label_for_the_raw_value)."""
    text=clean_text(raw)
    if not text:return None,''
    # Strip a trailing "(...)" territory annotation, e.g. "DN (Key & Central)" -> "DN"
    base=text.split('(')[0].strip()
    lower=base.casefold()
    if lower in NAME_TO_CODE:return NAME_TO_CODE[lower],text
    if base.isupper() and 1<len(base)<=6:return base,text
    # Fall back to the name map even if casing/spacing was odd
    if lower.replace(' ','') in {k.replace(' ','') for k in NAME_TO_CODE}:
        for k,v in NAME_TO_CODE.items():
            if k.replace(' ','')==lower.replace(' ',''):return v,text
    return None,text

def parse_workbook(data:bytes,filename:str,worksheet:str|None=None):
    if Path(filename).suffix.casefold() not in {'.xlsx','.xlsm'}:raise AeWorkbookError('AE assignment file must be an .xlsx workbook')
    try:workbook=load_workbook(BytesIO(data),read_only=True,data_only=True)
    except Exception as exc:raise AeWorkbookError('The uploaded workbook is malformed or unreadable') from exc
    wanted=clean_header(worksheet or 'AE Territory Assignment')
    available={clean_header(s).casefold():s for s in workbook.sheetnames}
    sheet_key=wanted.casefold()
    if sheet_key not in available:
        # Fall back to the first sheet if the exact name isn't found — but say so in the result.
        sheet_name=workbook.sheetnames[0]
    else:
        sheet_name=available[sheet_key]
    ws=workbook[sheet_name]
    raw_headers=[cell.value for cell in next(ws.iter_rows(min_row=1,max_row=1))]
    headers=[clean_header(h) for h in raw_headers if clean_header(h)]
    column_by_header={}
    for index,value in enumerate(raw_headers,1):
        header=clean_header(value)
        if header:column_by_header.setdefault(header,index)
    missing=[h for h in REQUIRED_HEADERS if h not in column_by_header]
    if missing:
        workbook.close()
        raise AeWorkbookError(f"Expected columns not found: {', '.join(missing)}. Found: {', '.join(headers)}")
    ae_col=column_by_header['Account Executive'];name_col=column_by_header['Customer Name']
    loc_col=column_by_header['Location'];icris_col=column_by_header['Customer/ICRIS Code']
    rows=[]
    for row_number,row in enumerate(ws.iter_rows(min_row=2),2):
        def cell(col):return cell_text(row[col-1]) if len(row)>=col else ''
        ae_raw=cell(ae_col);customer_name=cell(name_col);location=cell(loc_col);icris_raw=cell(icris_col)
        if not any([ae_raw,customer_name,location,icris_raw]):continue
        ae_code,ae_label=normalize_ae_value(ae_raw)
        rows.append({
            'row_number':row_number,'ae_raw':ae_raw,'ae_code':ae_code,'ae_label':ae_label,
            'customer_name':customer_name,'location':location,
            'icris_raw':icris_raw,'normalized_icris':normalize_icris(icris_raw),
        })
    workbook.close()
    return {'file_name':Path(filename).name,'worksheet_name':sheet_name,'headers':headers,'rows':rows}

def analyze(db:Session,parsed:dict)->dict:
    rows=parsed['rows']
    invalid=[r for r in rows if not r['normalized_icris']]
    unknown_ae=[r for r in rows if r['ae_raw'] and not r['ae_code']]
    valid=[r for r in rows if r['normalized_icris'] and r['ae_code']]
    icris_list=[r['normalized_icris'] for r in valid]
    dupes=[icris for icris,c in {(x,icris_list.count(x)) for x in icris_list} if c>1] if icris_list else []
    dupe_groups=defaultdict(list)
    for r in valid:
        if icris_list.count(r['normalized_icris'])>1:dupe_groups[r['normalized_icris']].append(r['row_number'])
    existing={normalize_icris(c.icris_number):c for c in db.scalars(select(Company).where(Company.icris_number.in_({r['normalized_icris'] for r in valid}))).all()} if valid else {}
    matched=[r for r in valid if r['normalized_icris'] in existing]
    unmatched_icris=[r for r in valid if r['normalized_icris'] not in existing]
    reassignments=sum(1 for r in matched if (existing[r['normalized_icris']].assigned_ae_code or None)!=r['ae_code'])
    unchanged=len(matched)-reassignments
    return {
        'file_name':parsed['file_name'],'worksheet_name':parsed['worksheet_name'],'headers':parsed['headers'],
        'total_rows':len(rows),'valid_rows':len(valid),
        'blank_icris_count':sum(1 for r in rows if not r['icris_raw']),
        'invalid_icris_count':len(invalid),
        'unknown_ae_count':len(unknown_ae),
        'unknown_ae_values':sorted({r['ae_label'] for r in unknown_ae}),
        'duplicate_icris_count':len(dupe_groups),
        'duplicate_groups':[{'normalized_icris':k,'row_numbers':v} for k,v in dupe_groups.items()],
        'matched_count':len(matched),'unmatched_icris_count':len(unmatched_icris),
        'to_reassign_count':reassignments,'unchanged_count':unchanged,
        'unmatched_icris_preview':[{'row_number':r['row_number'],'icris':r['icris_raw'],'customer_name':r['customer_name']} for r in unmatched_icris[:25]],
        'unknown_ae_preview':[{'row_number':r['row_number'],'ae_raw':r['ae_raw'],'customer_name':r['customer_name']} for r in unknown_ae[:25]],
        'preview_rows':rows[:10],
    }

def import_ae_assignments(db:Session,data:bytes,filename:str,worksheet:str|None,changed_by_user_id=None)->AeImportBatch:
    parsed=parse_workbook(data,filename,worksheet)
    preview=analyze(db,parsed)
    digest=sha256(data).hexdigest()
    batch=AeImportBatch(
        file_name=parsed['file_name'],file_hash=digest,worksheet_name=parsed['worksheet_name'],
        total_rows=preview['total_rows'],matched_count=preview['matched_count'],
        unmatched_icris_count=preview['unmatched_icris_count'],unknown_ae_count=preview['unknown_ae_count'],
        invalid_row_count=preview['invalid_icris_count'],status='processing',
    )
    db.add(batch);db.flush()

    known_codes={a.ae_code for a in db.scalars(select(AccountExecutive)).all()}
    rows=parsed['rows']
    icris_wanted={r['normalized_icris'] for r in rows if r['normalized_icris'] and r['ae_code']}
    existing={normalize_icris(c.icris_number):c for c in db.scalars(select(Company).where(Company.icris_number.in_(icris_wanted))).all()} if icris_wanted else {}
    seen_icris=set()

    for row in rows:
        icris=row['normalized_icris']
        if not icris:
            batch.invalid_row_count+=0  # already counted in preview; keep row for audit
            db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='rejected',error_message='Blank or invalid ICRIS'))
            continue
        if not row['ae_code']:
            db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='rejected',error_message=f"Unrecognized AE value: {row['ae_label']!r}"))
            continue
        company=existing.get(icris)
        if not company:
            db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='unmatched',error_message='ICRIS not found in this system',company_id=None))
            continue
        if icris in seen_icris:
            # Duplicate ICRIS within the same file — first occurrence already applied, keep as audit trail only.
            db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='duplicate',error_message='Duplicate ICRIS in this file — later row ignored',company_id=company.id))
            continue
        seen_icris.add(icris)

        # Add any never-before-seen code to the roster rather than silently rejecting it —
        # this file is a legitimate source of AE identity, not just a report.
        if row['ae_code'] not in known_codes:
            db.add(AccountExecutive(ae_code=row['ae_code'],display_name=None,is_active=True,territory_name=TERRITORY_NAMES.get(row['ae_code'])));known_codes.add(row['ae_code'])

        previous=company.assigned_ae_code
        if previous==row['ae_code']:
            db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='unchanged',company_id=company.id))
            continue

        _reassign_company(db,company,row['ae_code'],reason=f"AE import: {batch.file_name}",source='import',changed_by_user_id=changed_by_user_id,batch_id=batch.id)
        batch.reassigned_count+=1
        db.add(AeImportRow(import_batch_id=batch.id,row_number=row['row_number'],raw_data_json=row,processing_status='reassigned',company_id=company.id))

    batch.status='completed';batch.completed_at=now();return batch

def _reassign_company(db:Session,company:Company,new_ae_code:str,reason:str|None,source:str,changed_by_user_id,batch_id=None)->int:
    """Sets the company's assigned AE, overwrites ae_code on every historical shipment
    (the explicitly-chosen behavior — not a going-forward-only model), locks each touched
    shipment's ae_code against future CRM overwrite via manual_override_fields (the same
    mechanism crm_sync already respects for every other field), and logs the change.
    Returns the number of shipments updated."""
    previous=company.assigned_ae_code
    company.assigned_ae_code=new_ae_code;company.ae_assigned_at=now()
    shipments=db.scalars(select(Shipment).where(Shipment.company_id==company.id)).all()
    for s in shipments:
        s.ae_code=new_ae_code
        overrides=set(s.manual_override_fields or [])
        overrides.add('ae_code')
        s.manual_override_fields=sorted(overrides)
    db.add(AeReassignmentLog(
        company_id=company.id,from_ae_code=previous,to_ae_code=new_ae_code,reason=reason,
        source=source,changed_by_user_id=changed_by_user_id,shipments_updated=len(shipments),
    ))
    db.add(ActivityLog(
        entity_type='company',entity_id=company.id,action='ae_reassigned',
        description=f"AE reassigned from {previous or 'Unassigned'} to {new_ae_code} ({len(shipments)} shipments updated)",
        source=source,metadata_json={'from_ae_code':previous,'to_ae_code':new_ae_code,'import_batch_id':str(batch_id) if batch_id else None},
    ))
    return len(shipments)
