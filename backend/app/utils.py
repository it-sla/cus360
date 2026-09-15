import json, re, unicodedata
from decimal import Decimal, InvalidOperation
def normalize_name(value: str) -> str:
    value=re.sub(r"[^\w\s]"," ",str(value).casefold())
    value=re.sub(r"\b(pvt|private)\s+(ltd|limited)\b","pvt ltd",value)
    return re.sub(r"\s+"," ",value).strip()
def extract_icris_from_tracking(tracking: object) -> str | None:
    """UPS tracking numbers embed the ICRIS as chars 3-8 (e.g. 1ZR111490448804620 -> R11149).
    This is the authoritative ICRIS source for CRM manifest rows: the Icrisno column can be
    blank initially (filled in a later sync) or permanently blank for FC pay-term shipments."""
    text=str(tracking or '').strip()
    if len(text)>=8 and text[:2].upper()=='1Z':return text[2:8].upper()
    return None
def normalize_icris(value: object) -> str:
    """Normalize identity without deleting meaningful internal characters."""
    if value is None:return ''
    text=unicodedata.normalize('NFKC',str(value)).replace('\u00a0',' ')
    text=text.strip(' \t\r\n\u200b\u200c\u200d\u2060\ufeff')
    return text.upper()
def escape_like(value: str) -> str:
    """Escape SQL LIKE/ILIKE wildcards so a literal search term never behaves as a pattern.
    Callers must query with ESCAPE '\\' (raw SQL) or .ilike(pattern, escape='\\') (ORM)."""
    return str(value).replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
def clean(value):
    if value is None: return None
    try:
        if value != value: return None
    except Exception: pass
    text=str(value).strip()
    return None if not text else (text[:-2] if text.endswith('.0') and text[:-2].isdigit() else text)
def integer(value):
    try: return int(float(value)) if clean(value) is not None else None
    except (ValueError,TypeError): return None
def decimal(value):
    try: return Decimal(str(value)) if clean(value) is not None else None
    except (InvalidOperation,ValueError): return None
def jsonable(row):
    return json.loads(json.dumps({str(k): clean(v) for k,v in row.items()},default=str))
