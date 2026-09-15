"""Strict parsers for sanitized legacy CRM manifest HTML."""
from dataclasses import dataclass,field
from datetime import datetime
from typing import Any
from decimal import Decimal,InvalidOperation
from hashlib import sha256
from html.parser import HTMLParser
import json,re,unicodedata
from urllib.parse import parse_qs,urljoin,urlparse

LIST_HEADERS=['Date','MAWB','FLIGHT','FROM','TO']
ROW_HEADERS=['SN','Tracking No.','Bill Type','Icrisno','Shipper','Consignee','Dest.','Act wt','Pcs','Dim wt','Pay Term','Bill no.','Bill amt','Gross amt','Tarriff Rate','AE','Delivery']
REQUIRED_ROW_HEADERS={'Tracking No.','Icrisno'}
PARSER_VERSION='2.0.0'
PNL_HEADERS=['MAWB','Date','Bill Amount','UPS Bill Amt','Profit/Loss']
PNL_PARSER_VERSION='1.0.0'
# S_MenifestPrevUPS.aspx per-shipment grid. Source spellings are the CRM's own —
# 'Icris No' here has a space, unlike the manifest's 'Icrisno'. Do not correct them.
UPS_ROW_HEADERS=['SN','Tracking No.','Shipper','Dest.','Wt(KG)','Pcs','Icris No','Bill Number','Bill Amount','UPS Discount%','UPS BillAmt','Profit/Loss']
UPS_LIST_HEADERS=['Date','MAWB','Flight','From','To']
UPS_PARSER_VERSION='1.0.0'

class CrmParseError(ValueError):
    code='crm_header_mismatch'
class LoginRequired(CrmParseError):
    code='crm_session_expired'
class EmptyManifestError(CrmParseError):
    code='crm_empty_manifest'
class PartialManifestError(CrmParseError):
    code='crm_partial_page'
class DuplicateTrackingConflict(CrmParseError):
    code='crm_duplicate_tracking_conflict'

@dataclass
class ParsedValue:value:Decimal|None;warning:str|None=None
@dataclass
class ManifestDetail:
    header:dict;totals:dict;rows:list[dict];warnings:list[str]=field(default_factory=list)
    original_row_headers:list[str]=field(default_factory=list);source_data_row_count:int=0;duplicate_row_count:int=0;parser_version:str=PARSER_VERSION;source_checksum:str=''
@dataclass
class PnlReport:
    rows:list[dict];total:dict|None;warnings:list[str]=field(default_factory=list)
    parser_version:str=PNL_PARSER_VERSION;source_checksum:str=''
@dataclass
class UpsPnlDetail:
    rows:list[dict];total:dict|None;manifest_date:Any=None;warnings:list[str]=field(default_factory=list)
    original_row_headers:list[str]=field(default_factory=list);duplicate_row_count:int=0
    parser_version:str=UPS_PARSER_VERSION;source_checksum:str=''

def normalize_header(value):
    value=unicodedata.normalize('NFKC',str(value)).replace('\u00a0',' ')
    value=re.sub(r'\s+',' ',value).strip().casefold()
    return re.sub(r'\s*([.])\s*',r'\1',value)

class Tables(HTMLParser):
    def __init__(self):super().__init__();self.tables=[];self.table=None;self.row=None;self.cell=None;self.title='';self.in_title=False;self.has_password=False
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='title':self.in_title=True
        if tag=='input' and attrs.get('type','').lower()=='password':self.has_password=True
        if tag=='table':self.table=[]
        elif tag=='tr' and self.table is not None:self.row=[]
        elif tag in ('th','td') and self.row is not None:self.cell={'text':[],'href':None}
        elif tag=='a' and self.cell is not None:self.cell['href']=attrs.get('href','')
    def handle_data(self,data):
        if self.in_title:self.title+=data
        if self.cell is not None:self.cell['text'].append(data)
    def handle_endtag(self,tag):
        if tag=='title':self.in_title=False
        elif tag in ('th','td') and self.cell is not None:
            self.cell['text']=' '.join(''.join(self.cell['text']).split());self.row.append(self.cell);self.cell=None
        elif tag=='tr' and self.row is not None:
            if self.row:self.table.append(self.row)
            self.row=None
        elif tag=='table' and self.table is not None:self.tables.append(self.table);self.table=None

def document(html):
    if not html or len(html.strip())<80:raise PartialManifestError('CRM response is empty or truncated')
    p=Tables();p.feed(html)
    if p.has_password and ('login' in p.title.casefold() or 'sign in' in html.casefold()):raise LoginRequired('CRM authentication is required')
    return p
def cells(row):return [x['text'] for x in row]
def parse_date(value):
    try:return datetime.strptime(value.strip(),'%m/%d/%Y').date()
    except (ValueError,AttributeError) as e:raise CrmParseError('Invalid manifest date') from e
def number(value,label='value'):
    original=str(value or '').strip();cleaned=original.replace(',','')
    if not cleaned:return ParsedValue(None)
    try:return ParsedValue(Decimal(cleaned))
    except InvalidOperation:return ParsedValue(None,f'Invalid numeric value for {label}')
def find_table(doc,required):
    wanted={normalize_header(x) for x in required}
    for table in doc.tables:
        for index,row in enumerate(table):
            headers=cells(row);normalized={normalize_header(x) for x in headers}
            if wanted<=normalized:return table,index,headers
    raise CrmParseError('Expected CRM table headers were not found')
def _positions(headers,expected):
    normalized=[normalize_header(x) for x in headers];return {name:normalized.index(normalize_header(name)) for name in expected}
def _manifest_id(ref):
    parsed=urlparse(ref);query=parse_qs(parsed.query)
    found=next((values[0] for key,values in query.items() if key.casefold() in {'id','manifestid','manifest_id'} and values),'')
    return found or (parsed.path.rstrip('/').rsplit('/',1)[-1] if parsed.path.rstrip('/').rsplit('/',1)[-1].isdigit() else '')
def _data_rows_from_table(table,pos):
    required_cols=max(pos.values())+1
    out=[]
    for row in table:
        values=cells(row)
        if not any(values):continue
        if len(values)>=required_cols:out.append(row)
    return out
def parse_manifest_list(html,base_url=''):
    doc=document(html);table,index,headers=find_table(doc,LIST_HEADERS);pos=_positions(headers,LIST_HEADERS)
    data_rows=_data_rows_from_table(table[index+1:],pos)
    if not data_rows:
        header_table_id=None
        for tbl in doc.tables:
            for row in tbl:
                normalized=[normalize_header(x) for x in cells(row)]
                if all(normalize_header(h) in normalized for h in LIST_HEADERS):
                    header_table_id=id(tbl);break
            if header_table_id:break
        for tbl in doc.tables:
            if id(tbl)==header_table_id:continue
            candidate=_data_rows_from_table(tbl,pos)
            if candidate:data_rows=candidate;break
    out=[]
    for row in data_rows:
        values=cells(row)
        if max(pos.values())>=len(values):raise PartialManifestError('Short manifest-list row')
        item={h:values[i] for h,i in pos.items()};item['manifest_date']=parse_date(item['Date']);ref=next((c['href'] for c in row if c['href']), '')
        item['detail_ref']=urljoin(base_url,ref) if base_url else ref;item['crm_manifest_id']=_manifest_id(ref)
        if item['MAWB']:out.append(item)
    return out
def labels(doc):
    result={}
    for table in doc.tables:
        for row in table:
            values=cells(row)
            for i in range(0,len(values)-1,2):
                if values[i]:result[values[i].rstrip(':')]=values[i+1]
    return result
def _checksum(header,totals,rows):
    payload={'header':{k:str(v) for k,v in header.items() if k!='manifest_date'},'totals':{k:str(v) for k,v in totals.items()},'rows':[r['raw'] for r in rows]}
    return sha256(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def parse_manifest_detail(html,expected_manifest_id=None):
    doc=document(html);values=labels(doc);full_text='\n'.join(cell['text'] for table in doc.tables for row in table for cell in row)
    patterns={'Date':r'(?m)\bDate:\s*([^\n]+)','MAWB':r'(?m)\bMAWB:\s*([^\n]+)','Flight No':r'(?m)\bFlight No:\s*([^\n]+)','From':r'(?m)\bFrom:\s*([^\n]+)','TO':r'(?m)\bTO:\s*([^\n]+)','Exchange Rate':r'(?m)\bExchange Rate:\s*([^\n]+)','Fuel Surcharge':r'(?m)\bFuel Surch(?:arge|age):\s*([^\n]+)'}
    header={}
    for key,pattern in patterns.items():
        match=re.search(pattern,full_text,re.I);header[key]=(values.get(key) or (match.group(1).strip() if match else ''))
    
    if not header.get('MAWB') or not header.get('Date'):
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, 'html.parser')
            d_elem = soup.select_one('input[name*="txt_Date"]') or soup.select_one('input[name*="Date"]')
            m_elem = soup.select_one('input[name*="txt_mawb"]') or soup.select_one('input[name*="mawb"]')
            if d_elem and m_elem:
                header['Date'] = d_elem.get('value', '').strip()
                header['MAWB'] = m_elem.get('value', '').strip()
                f_elem = soup.select_one('input[name*="txt_FlightNo"]')
                if f_elem: header['Flight No'] = f_elem.get('value', '').strip()
                fr_elem = soup.select_one('input[name*="txt_From"]')
                if fr_elem: header['From'] = fr_elem.get('value', '').strip()
                to_elem = soup.select_one('input[name*="txt_To"]')
                if to_elem: header['TO'] = to_elem.get('value', '').strip()
                ex_elem = soup.select_one('input[name*="txt_ExRate"]')
                if ex_elem: header['Exchange Rate'] = ex_elem.get('value', '').strip()
                fu_elem = soup.select_one('input[name*="txt_FuelSurchage"]')
                if fu_elem: header['Fuel Surcharge'] = fu_elem.get('value', '').strip()
        except Exception:
            pass

    if not header.get('MAWB') or not header.get('Date'):raise PartialManifestError('Manifest MAWB or date header is missing')
    header['manifest_date']=parse_date(header['Date']);warnings=[];totals={}
    _leaked_label_prefixes=('exchange rate:','flight no:','fuel surch','from:','to:','date:','mawb:')
    for _field in ('From','TO'):
        _val=(header.get(_field) or '').strip()
        if _val and (_val.casefold().startswith(_leaked_label_prefixes) or _val.casefold() in {'total','sn'} or _val.isdigit() or not _val[0].isalnum()):
            warnings.append(f'{_field} header value looks corrupted (matches another field label or a table artifact instead of a real value): {_val!r}. Header table cells were likely misaligned for this manifest.')
    for table in doc.tables:
        if not table:continue
        hs=cells(table[0]);normalized=[normalize_header(x) for x in hs]
        expected=['Wt.','Pcs','Bill Amount','Gross Amount']
        if all(normalize_header(x) in normalized for x in expected):
            pos=_positions(hs,expected)
            for row in table[1:]:
                vals=cells(row)
                if vals and vals[0] in ('PP','FC','FD'):
                    for source,target in [('Wt.','weight'),('Pcs','pieces'),('Bill Amount','bill_amount'),('Gross Amount','gross_amount')]:
                        parsed=number(vals[pos[source]] if pos[source]<len(vals) else '',f'{vals[0]} {source}');totals[f'{vals[0].lower()}_{target}']=parsed.value
                        if parsed.warning:warnings.append(parsed.warning)
        elif normalized and normalized[0]==normalize_header('Total') and any(normalize_header(x) in normalized for x in ('PP','FC','FD')):
            categories=hs[1:]
            for row in table[1:]:
                vals=cells(row)
                if not vals:continue
                target={'wt.':'weight','pcs':'pieces','bill amount':'bill_amount','gross amount':'gross_amount'}.get(normalize_header(vals[0]))
                if target:
                    for i,category in enumerate(categories,1):
                        parsed=number(vals[i] if i<len(vals) else '',f'{category} {vals[0]}');totals[f'{category.lower()}_{target}']=parsed.value
                        if parsed.warning:warnings.append(parsed.warning)
    
    table, index, headers = None, None, None
    try:
        table,index,headers=find_table(doc,REQUIRED_ROW_HEADERS|{'Shipper','Consignee'})
    except CrmParseError as err:
        is_import_html = any(k in html for k in ('EditFormImport', 'MenifestPreviewImport', 'txt_ExRate', 'txt_FuelSurchage', 'Shipper Acc No', 'Consignee Acc. No.'))
        if not is_import_html:
            raise err

    numeric={'Act wt','Pcs','Dim wt','Bill amt','Gross amt','Tarriff Rate'};rows=[];source_count=0;seen={};duplicates=0

    if table is not None:
        normalized=[normalize_header(x) for x in headers];expected=[normalize_header(x) for x in ROW_HEADERS]
        if len(headers)<17 or normalized[:17]!=expected:raise CrmParseError('Shipment headers differ from the verified 17-column contract')
        for source_number,row in enumerate(table[index+1:],1):
            vals=cells(row)
            if not any(vals):continue
            source_count+=1
            if len(vals)<17:raise PartialManifestError('Short shipment row')
            raw=dict(zip(ROW_HEADERS,vals[:17]));tracking=raw['Tracking No.'].strip()
            if not tracking:raise CrmParseError('Business row has no Tracking No.')
            parsed={};row_warnings=[]
            for key in numeric:
                result=number(raw[key],key);parsed[key]=result.value
                if result.warning:row_warnings.append(result.warning);warnings.append(result.warning)
            normalized_tracking=unicodedata.normalize('NFKC',tracking).strip()
            comparable=json.dumps(raw,sort_keys=True,ensure_ascii=False)
            if normalized_tracking in seen:
                duplicates+=1
                if seen[normalized_tracking]!=comparable:raise DuplicateTrackingConflict('Conflicting duplicate Tracking No. rows')
                continue
            seen[normalized_tracking]=comparable;rows.append({'source_row_number':source_number,'raw':raw,'parsed':parsed,'warnings':row_warnings})
    else:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        tbls = soup.select('table')
        found_import_table = False
        if tbls:
            last_tbl = tbls[-1]
            trs = last_tbl.select('tr')
            if trs:
                col_headers = [th.get_text(strip=True) for th in trs[0].select('th, td')]
                if any('tracking' in h.lower() for h in col_headers):
                    found_import_table = True
                    headers = ROW_HEADERS
                    for source_number, r in enumerate(trs[1:], 1):
                        c_vals = [td.get_text(strip=True) for td in r.select('td, th')]
                        if not c_vals or not any(c_vals): continue
                        source_count += 1
                        d_row = dict(zip(col_headers, c_vals))
                        raw = {
                            'SN': d_row.get('Sno', str(source_number)),
                            'Tracking No.': d_row.get('Tracking Number', ''),
                            'Bill Type': d_row.get('Bill Type', ''),
                            'Icrisno': d_row.get('Shipper Acc No', '') or d_row.get('Consignee Acc. No.', ''),
                            'Shipper': d_row.get('Shipper', ''),
                            'Consignee': d_row.get('Consignee', ''),
                            'Dest.': d_row.get('Destination', '') or d_row.get('Origin', ''),
                            'Act wt': d_row.get('Weight(KG)', '0'),
                            'Pcs': d_row.get('Pcs', '1'),
                            'Dim wt': '0',
                            'Pay Term': d_row.get('Pay Term', ''),
                            'Bill no.': d_row.get('BillNo', ''),
                            'Bill amt': d_row.get('Bill Amount', '0'),
                            'Gross amt': d_row.get('Gross Amount', '0'),
                            'Tarriff Rate': '0',
                            'AE': '',
                            'Delivery': d_row.get('Delivery', '')
                        }
                        tracking = raw['Tracking No.'].strip()
                        if not tracking: continue
                        parsed={};row_warnings=[]
                        for key in numeric:
                            result=number(raw[key],key);parsed[key]=result.value
                            if result.warning:row_warnings.append(result.warning);warnings.append(result.warning)
                        normalized_tracking=unicodedata.normalize('NFKC',tracking).strip()
                        comparable=json.dumps(raw,sort_keys=True,ensure_ascii=False)
                        if normalized_tracking in seen:
                            duplicates+=1
                            if seen[normalized_tracking]!=comparable:raise DuplicateTrackingConflict('Conflicting duplicate Tracking No. rows')
                            continue
                        seen[normalized_tracking]=comparable;rows.append({'source_row_number':source_number,'raw':raw,'parsed':parsed,'warnings':row_warnings})
        if not found_import_table:
            raise CrmParseError('Expected CRM table headers were not found')

    if not rows:warnings.append('Manifest detail contains no shipment rows')
    detail=ManifestDetail(header,totals,rows,warnings,headers[:17] if headers else ROW_HEADERS,source_count,duplicates)
    detail.source_checksum=_checksum(header,totals,rows)
    return detail

PNL_EMPTY_MARKER='no data records'
def parse_pnl_grid(html):
    doc=document(html)
    if any(PNL_EMPTY_MARKER in ' '.join(c['text'] for c in row).casefold() for table in doc.tables for row in table):
        payload=json.dumps({'rows':[],'total':None},sort_keys=True)
        return PnlReport(rows=[],total=None,warnings=['P&L report contains no rows for the requested range'],source_checksum=sha256(payload.encode()).hexdigest())
    table,index,headers=find_table(doc,PNL_HEADERS)
    pos=_positions(headers,PNL_HEADERS)
    rows=[];total=None;warnings=[]
    for row in table[index+1:]:
        values=cells(row)
        if not any(values):continue
        if max(pos.values())>=len(values):raise PartialManifestError('Short P&L row')
        mawb=values[pos['MAWB']].strip()
        if mawb.casefold().startswith('total'):
            bill=number(values[pos['Bill Amount']],'Total Bill Amount');ups=number(values[pos['UPS Bill Amt']],'Total UPS Bill Amt');pl=number(values[pos['Profit/Loss']],'Total Profit/Loss')
            for parsed in (bill,ups,pl):
                if parsed.warning:warnings.append(parsed.warning)
            total={'bill_amount':bill.value,'ups_bill_amount':ups.value,'profit_loss':pl.value}
            continue
        if not mawb:continue
        date_value=values[pos['Date']].strip();manifest_date=parse_date(date_value) if date_value else None
        bill=number(values[pos['Bill Amount']],'Bill Amount');ups=number(values[pos['UPS Bill Amt']],'UPS Bill Amt');pl=number(values[pos['Profit/Loss']],'Profit/Loss')
        for parsed in (bill,ups,pl):
            if parsed.warning:warnings.append(parsed.warning)
        rows.append({'mawb':mawb,'manifest_date':manifest_date,'bill_amount':bill.value,'ups_bill_amount':ups.value,'profit_loss':pl.value})
    payload=json.dumps({'rows':[{**r,'manifest_date':r['manifest_date'].isoformat() if r['manifest_date'] else None,'bill_amount':str(r['bill_amount']),'ups_bill_amount':str(r['ups_bill_amount']),'profit_loss':str(r['profit_loss'])} for r in rows],'total':{k:str(v) for k,v in total.items()} if total else None},sort_keys=True,ensure_ascii=False)
    return PnlReport(rows=rows,total=total,warnings=warnings,source_checksum=sha256(payload.encode()).hexdigest())

def parse_ups_list(html,base_url=''):
    """UPS manifest list (MenifestPreview_UPS.aspx) -> rows with the S_MenifestPrevUPS record id.

    The grid has no header row of its own, so rows are identified positionally:
    Date | MAWB | Flight | From | To, with the detail link on the first cell.
    """
    doc=document(html)
    out=[];seen=set()
    for table in doc.tables:
        for row in table:
            values=cells(row)
            if len(values)<5:continue
            ref=next((c['href'] for c in row if c['href']),'')
            if 'menifestprevups' not in (ref or '').casefold():continue
            record_id=_manifest_id(ref)
            if not record_id or record_id in seen:continue
            try:manifest_date=parse_date(values[0])
            except CrmParseError:continue
            mawb=values[1].strip()
            if not mawb:continue
            seen.add(record_id)
            out.append({'crm_record_id':record_id,'manifest_date':manifest_date,'MAWB':mawb,
                        'Flight':values[2].strip(),'From':values[3].strip(),'To':values[4].strip(),
                        'detail_ref':urljoin(base_url,ref) if base_url else ref})
    return out

PIPELINE_HEADERS=['S.no.','Expected Date','Company Name','Acc No','Country','Weight(kg)','Revenue($)','PCS','Category','AE','Win/Loss','Remarks']
PIPELINE_PARSER_VERSION='1.0.0'
def parse_active_pipeline_list(html,base_url=''):
    """CRM_Activepipeline.aspx detail grid -> list of dicts, one per pipeline row.

    Source spellings preserved exactly ('S.no.', 'Acc No', 'Win/Loss', etc.) per project
    convention. Unlike the manifest list, the header row and the data rows live in separate
    <table> elements on this page — the header table has just the one row, and the 16-row
    grid below it is its own table — so this can't reuse find_table's same-table row walk;
    it locates the header table, then falls back to scanning sibling tables for the data,
    mirroring parse_manifest_list's own fallback for the same reason.
    Rows with no Expected Date are dropped rather than raising, since a blank date means the
    row can't be evaluated for overdue status and there's nothing else strict to validate here."""
    doc=document(html)
    header_table=None;headers=None;wanted={normalize_header(x) for x in PIPELINE_HEADERS}
    for table in doc.tables:
        if not table:continue
        normalized={normalize_header(x) for x in cells(table[0])}
        if wanted<=normalized:header_table=table;headers=cells(table[0]);break
    if header_table is None:raise CrmParseError('Expected CRM table headers were not found')
    pos=_positions(headers,PIPELINE_HEADERS)
    data_rows=_data_rows_from_table(header_table[1:],pos)
    if not data_rows:
        header_id=id(header_table)
        for tbl in doc.tables:
            if id(tbl)==header_id:continue
            candidate=_data_rows_from_table(tbl,pos)
            if candidate:data_rows=candidate;break
    out=[]
    for row in data_rows:
        values=cells(row)
        if not any(values):continue
        if max(pos.values())>=len(values):continue
        item={h:values[i] for h,i in pos.items()}
        expected_raw=item['Expected Date'].strip()
        if not expected_raw or not item['Company Name'].strip():continue
        try:item['expected_date']=parse_date(expected_raw)
        except CrmParseError:continue
        item['weight_kg']=number(item['Weight(kg)'],'Weight(kg)').value
        item['revenue_usd']=number(item['Revenue($)'],'Revenue($)').value
        pcs=number(item['PCS'],'PCS').value;item['pieces']=int(pcs) if pcs is not None else None
        ref=next((c['href'] for c in row if c['href']),'')
        item['detail_ref']=urljoin(base_url,ref) if base_url else ref
        out.append(item)
    return out

DAILY_CALL_LOG_HEADERS=['Date','Company Name','Stage','Category','Contact Person','Phone No','Call Type','AE','Remarks','Supervisor Comment','Follow up']
DAILY_CALL_LOG_PARSER_VERSION='1.0.0'
def _customer_id(ref):
    query=parse_qs(urlparse(ref).query)
    found=next((values[0] for key,values in query.items() if key.casefold()=='id2' and values),'')
    return found
def parse_daily_call_logs(html,base_url=''):
    """CRM_DairyAEList.aspx ('Daily Call Logs') -> list of dicts, one per call-log row.

    Same split-table layout as parse_active_pipeline_list: the header lives alone in
    #MainContent_tbl_Header, the data rows in #MainContent_tbl_Quotation, so the header
    table's own body is empty and the fallback scan over sibling tables is what actually
    finds the rows. Rows with no Date or Company Name are dropped rather than raising."""
    doc=document(html)
    header_table=None;headers=None;wanted={normalize_header(x) for x in DAILY_CALL_LOG_HEADERS}
    for table in doc.tables:
        if not table:continue
        normalized={normalize_header(x) for x in cells(table[0])}
        if wanted<=normalized:header_table=table;headers=cells(table[0]);break
    if header_table is None:raise CrmParseError('Expected CRM table headers were not found')
    pos=_positions(headers,DAILY_CALL_LOG_HEADERS)
    data_rows=_data_rows_from_table(header_table[1:],pos)
    if not data_rows:
        header_id=id(header_table)
        for tbl in doc.tables:
            if id(tbl)==header_id:continue
            candidate=_data_rows_from_table(tbl,pos)
            if candidate:data_rows=candidate;break
    out=[]
    for row in data_rows:
        values=cells(row)
        if not any(values):continue
        if max(pos.values())>=len(values):continue
        item={h:values[i] for h,i in pos.items()}
        date_raw=item['Date'].strip()
        if not date_raw or not item['Company Name'].strip():continue
        try:item['call_date']=parse_date(date_raw)
        except CrmParseError:continue
        try:item['follow_up_date']=parse_date(item['Follow up'].strip())
        except CrmParseError:item['follow_up_date']=None
        ref=next((c['href'] for c in row if c['href']),'')
        item['crm_customer_id']=_customer_id(ref)
        item['detail_ref']=urljoin(base_url,ref) if base_url else ref
        out.append(item)
    return out

_UPS_NUMERIC={'Wt(KG)','Pcs','Bill Amount','UPS Discount%','UPS BillAmt','Profit/Loss'}
def parse_ups_detail(html):
    """Per-shipment UPS profit/loss grid (S_MenifestPrevUPS.aspx?ID=n).

    Strict on the 12-column contract; the trailing 'Total' row is parsed separately
    (it is short — Total | bill | <blank discount> | ups | profit) and never treated
    as a shipment row.
    """
    doc=document(html)
    table,index,headers=find_table(doc,UPS_ROW_HEADERS)
    normalized=[normalize_header(x) for x in headers]
    expected=[normalize_header(x) for x in UPS_ROW_HEADERS]
    if len(headers)<12 or normalized[:12]!=expected:
        raise CrmParseError('UPS shipment headers differ from the verified 12-column contract')
    pos=_positions(headers,UPS_ROW_HEADERS)
    rows=[];total=None;warnings=[];seen={};duplicates=0
    # The manifest date lives in a <span id="lbl_Date"> that the strict table parser does not
    # surface as cell text. It is redundant anyway — the UPS list row carries the authoritative
    # date per record — so the caller supplies it rather than this parser guessing.
    manifest_date=None
    for row in table[index+1:]:
        values=cells(row)
        if not any(values):continue
        first=values[0].strip()
        if first.casefold().startswith('total'):
            numbers=[number(v,'total').value for v in values[1:] if v.strip()]
            if len(numbers)>=3:
                total={'bill_amount':numbers[0],'ups_bill_amount':numbers[-2],'profit_loss':numbers[-1]}
            continue
        if len(values)<12:raise PartialManifestError('Short UPS shipment row')
        raw=dict(zip(UPS_ROW_HEADERS,values[:12]))
        tracking=unicodedata.normalize('NFKC',raw['Tracking No.']).strip()
        if not tracking:continue
        parsed={}
        for key in _UPS_NUMERIC:
            result=number(raw[key],key);parsed[key]=result.value
            if result.warning:warnings.append(result.warning)
        comparable=json.dumps(raw,sort_keys=True,ensure_ascii=False)
        if tracking in seen:
            duplicates+=1
            if seen[tracking]!=comparable:raise DuplicateTrackingConflict('Conflicting duplicate Tracking No. rows in UPS detail')
            continue
        seen[tracking]=comparable
        rows.append({'tracking_number':tracking,'raw':raw,'parsed':parsed})
    if not rows:warnings.append('UPS detail contains no shipment rows')
    payload=json.dumps({'rows':[r['raw'] for r in rows],'total':{k:str(v) for k,v in (total or {}).items()}},sort_keys=True,ensure_ascii=False)
    return UpsPnlDetail(rows=rows,total=total,manifest_date=manifest_date,warnings=warnings,
                        original_row_headers=headers[:12],duplicate_row_count=duplicates,
                        source_checksum=sha256(payload.encode()).hexdigest())
