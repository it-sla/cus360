import hashlib, io
from pathlib import Path
import pandas as pd
from rapidfuzz import fuzz, process
from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import Company,CompanyAlias,ManifestImportBatch,ManifestRawRow,Shipment,Package,now
from .utils import clean,decimal,integer,jsonable,normalize_name

MANIFEST_HEADERS=["Shipment Number","Package Id","Pieces","Shipment Weight","Weight Unit","Bill Type","Shipper_Name","Shipper Address1","Shipper Address2","Shipper Address3","Shipper Postal Code","Shipper City Name","Export Country","Importer Name","Importer Adresse 1","Importer Adresse 2","Importer Adresse 3","Importer Postal Code","Importer City Name","Import Country","Importer Telephone Number","Description","Billing Term Field","Declared Value","Value Currency","TND"]
FIELD_MAP={"Pieces":"pieces","Shipment Weight":"shipment_weight","Weight Unit":"weight_unit","Bill Type":"bill_type","Shipper_Name":"shipper_name","Shipper Address1":"shipper_address_1","Shipper Address2":"shipper_address_2","Shipper Address3":"shipper_address_3","Shipper Postal Code":"shipper_postal_code","Shipper City Name":"shipper_city","Export Country":"export_country","Importer Name":"importer_name","Importer Adresse 1":"importer_address_1","Importer Adresse 2":"importer_address_2","Importer Adresse 3":"importer_address_3","Importer Postal Code":"importer_postal_code","Importer City Name":"importer_city","Import Country":"import_country","Importer Telephone Number":"importer_telephone","Description":"goods_description","Billing Term Field":"billing_term","Declared Value":"declared_value","Value Currency":"value_currency","TND":"tnd_value"}
NUMERIC={"shipment_weight","declared_value","tnd_value"}
def read_file(data: bytes, filename: str, worksheet: str|None=None):
    ext=Path(filename).suffix.lower()
    if ext not in {'.xls','.xlsx','.csv'}: raise ValueError('Unsupported import file type')
    if ext=='.csv': return pd.read_csv(io.BytesIO(data),dtype=object),None,[]
    engine='xlrd' if ext=='.xls' else 'openpyxl'; book=pd.ExcelFile(io.BytesIO(data),engine=engine); sheets=book.sheet_names
    chosen=worksheet or ('Query2' if 'Query2' in sheets else None)
    if not chosen or chosen not in sheets: raise ValueError(f"Worksheet Query2 not found. Available worksheets: {', '.join(sheets)}")
    return pd.read_excel(io.BytesIO(data),sheet_name=chosen,dtype=object,engine=engine),chosen,sheets
def preview_manifest(data,filename,worksheet=None):
    df,sheet,sheets=read_file(data,filename,worksheet); headers=[str(x) for x in df.columns]
    return {'file_name':filename,'file_type':Path(filename).suffix.lstrip('.'),'worksheet_name':sheet,'available_worksheets':sheets,'headers':headers,'missing_headers':[h for h in MANIFEST_HEADERS if h not in headers],'unexpected_columns':[h for h in headers if h not in MANIFEST_HEADERS],'estimated_row_count':len(df),'preview_rows':[jsonable(r) for r in df.head(5).to_dict('records')]}
def match_company(db: Session,name):
    norm=normalize_name(name or '')
    if not norm:return None,'unmatched',None,'none'
    companies=db.scalars(select(Company)).all(); official=[c for c in companies if c.normalized_name==norm]
    if len(official)==1:return official[0],'matched',100,'exact_company'
    aliases=db.execute(select(CompanyAlias,Company).join(Company)).all(); exact=[c for a,c in aliases if a.normalized_alias_name==norm]
    if len({c.id for c in exact})==1:return exact[0],'matched',100,'exact_alias'
    choices={c.normalized_name:c for c in companies}; found=process.extractOne(norm,list(choices),scorer=fuzz.ratio) if choices else None
    if found and found[1]>=70:return choices[found[0]],'suggested',found[1],'suggested'
    return None,'unmatched',None,'none'
def import_manifest(db:Session,data:bytes,filename:str,mode='skip_existing',worksheet=None,allow_duplicate=False):
    digest=hashlib.sha256(data).hexdigest()
    if not allow_duplicate and db.scalar(select(ManifestImportBatch).where(ManifestImportBatch.file_hash==digest)): raise FileExistsError('This manifest file has already been imported')
    df,sheet,_=read_file(data,filename,worksheet); headers=[str(x) for x in df.columns]; missing=[h for h in MANIFEST_HEADERS if h not in headers]
    if missing: raise ValueError('Missing required manifest headers: '+', '.join(missing))
    batch=ManifestImportBatch(file_name=filename,file_hash=digest,file_type=Path(filename).suffix.lstrip('.'),worksheet_name=sheet,import_mode=mode,total_rows=len(df),status='processing'); db.add(batch); db.flush()
    rows=list(df.to_dict('records')); valid=[]
    for idx,row in enumerate(rows,2):
        sn=clean(row.get('Shipment Number')); pid=clean(row.get('Package Id')); warnings=[]; status='imported'; error=None
        if not sn: status='failed'; error='Missing Shipment Number'; batch.failed_count+=1
        elif not pid: status='warning'; warnings.append('Missing Package Id'); batch.warning_count+=1
        raw=ManifestRawRow(import_batch_id=batch.id,row_number=idx,shipment_number=sn,package_id=pid,raw_data_json=jsonable(row),processing_status=status,warning_messages=warnings or None,error_message=error); db.add(raw)
        if sn: valid.append((idx,row,raw))
    groups={}
    for item in valid: groups.setdefault(clean(item[1]['Shipment Number']),[]).append(item)
    batch.shipment_count=len(groups)
    for sn,group in groups.items():
        existing=db.scalar(select(Shipment).where(Shipment.shipment_number==sn)); first={}
        for header in FIELD_MAP:
            first[header]=next((clean(x[1].get(header)) for x in group if clean(x[1].get(header)) is not None),None)
        if existing and mode=='skip_existing': batch.skipped_shipments+=1; continue
        company,status,confidence,method=match_company(db,first.get('Shipper_Name'))
        shipment=existing or Shipment(shipment_number=sn,source='manifest',manifest_batch_id=batch.id)
        if not existing: db.add(shipment); batch.created_shipments+=1
        else: batch.updated_shipments+=1
        for source,target in FIELD_MAP.items():
            value=first[source]; value=integer(value) if target=='pieces' else decimal(value) if target in NUMERIC else value
            if value is not None: setattr(shipment,target,value)
        shipment.manifest_batch_id=batch.id
        if not shipment.manually_matched: shipment.company_id=company.id if status=='matched' else None; shipment.match_status=status; shipment.match_confidence=confidence; shipment.matched_by_method=method
        setattr(batch,status+'_count',getattr(batch,status+'_count')+1); db.flush()
        seen=set(); package_count=0
        for _,row,raw in group:
            pid=clean(row.get('Package Id'))
            if not pid or pid in seen: continue
            seen.add(pid); package_count+=1
            pkg=db.scalar(select(Package).where(Package.package_id==pid))
            if not pkg: db.add(Package(shipment_id=shipment.id,package_id=pid,piece_number=package_count,description=clean(row.get('Description'))))
        source_pieces=integer(first.get('Pieces'))
        if source_pieces is not None and source_pieces!=package_count:
            for _,_,raw in group: raw.processing_status='warning'; raw.warning_messages=(raw.warning_messages or [])+[f'Pieces ({source_pieces}) differs from distinct Package Id count ({package_count})']
            batch.warning_count+=1
    batch.package_count=len({clean(r.get('Package Id')) for r in rows if clean(r.get('Package Id'))}); batch.status='completed_with_errors' if batch.failed_count or batch.warning_count else 'completed'; batch.completed_at=now(); db.flush(); return batch
