import csv, hashlib, io, logging, mimetypes, re, uuid
from urllib.parse import parse_qs,urlparse
from datetime import date, timedelta
from pathlib import Path
from typing import Annotated,Literal
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select, text, case, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload
from .core import settings
from .auth import AUTH_COOKIE_NAME, AUTH_SESSION_TTL_SECONDS, LoginRequest, create_session_token, find_user_by_setup_token, generate_setup_token, get_ae_scope, get_current_user, hash_password, require_role, serialize_user, verify_password
from .db import get_db
from .imports import read_file
from .company_imports import CompanyWorkbookError, analyze as analyze_company_workbook, import_companies, parse_workbook
from .crm_sync import rematch,upsert_pnl,upsert_ups_detail,run_active_pipeline_sync
from .ae_imports import AeWorkbookError, analyze as analyze_ae_workbook, import_ae_assignments, parse_workbook as parse_ae_workbook, _reassign_company as reassign_company
from .ae_targets import AeTargetWorkbookError, import_ae_targets
from .crm_backfills import cancel_backfill,create_backfill,create_incremental,customer_master_ready,earliest_state,incremental_range,pause_backfill,resume_backfill,watermark_state,activate_next_chunk
from .customer_segments import recompute_customer_segments
from .tier_alerts import get_tier_shipping_gap_breaches
from .email_notifications import send_tier_alert_digests, send_weekly_report
from .models import *
from .utils import clean, escape_like, jsonable, normalize_icris, normalize_name

log=logging.getLogger('customer360'); app=FastAPI(title='Customer 360',version='1.0.0')
app.add_middleware(CORSMiddleware,allow_origins=[x.strip() for x in settings.backend_cors_origins.split(',')],allow_credentials=True,allow_methods=['*'],allow_headers=['*'])

# --- Revenue basis -------------------------------------------------------------------
# The source CRM totals revenue into exactly three pay-term buckets on each manifest footer:
# PP (Prepaid, shipper-paid), FC (Freight Collect, consignee-paid) and FD (Free Domicile).
# Its "SP Export Report" likewise defaults to Pay Term = "FC & PP".
#
# Anything outside those buckets is NOT revenue to the CRM and must not be to us either:
#   NON_REV / RTS — real cargo movements, never billable
#   blank / unknown — cannot be bucketed, so the CRM's own footer omits them entirely
#
# This is an ALLOWLIST on purpose: a pay term we've never seen must default to non-revenue
# rather than silently inflating totals.
#
# Verified 2026-08-07 by reconciling against the CRM's own manifest footers month by month —
# 11 of 12 recent months match to the cent on this basis. Counting blank-term rows was
# overstating revenue by 2-18% per month (July 2026: +$24,087.28 on $152,337.59).
#
# Rows excluded here remain counted as SHIPMENTS — only their monetary contribution is zeroed.
BILLABLE_PAY_TERMS = ('PP', 'FC', 'FD')
# Single source of truth. Valid in any raw-SQL block where the shipments table is aliased `s`.
REVENUE_AMOUNT_SQL = ("CASE WHEN upper(trim(coalesce(s.pay_term,''))) IN ('PP','FC','FD') "
                      "THEN coalesce(s.bill_amount, s.declared_value, 0) ELSE 0 END")
# A blank or invalid-format ICRIS is expected to self-resolve once accounts/billing bills
# the shipment and a later CRM sync fills in the real ICRIS — that's a normal lag, not a
# defect. Past this many days without resolving, it isn't self-resolving anymore; it's
# stuck and needs a human. 30 days is accounting's own stated buffer window (2026-09).
# Applies to crm_invalid_icris and crm_blank_icris — NOT crm_icris_not_in_master, which is
# a different situation (well-formed ICRIS, just not in the master list yet) resolved by a
# company-master import, not by waiting on accounting.
ICRIS_BUFFER_DAYS = 30
# Per-customer repeat rate: of the calendar months between their first and last shipment
# (inclusive), what fraction had at least one shipment. A single-shipment customer has no
# repeat behaviour yet, so it's defined as 0 rather than the degenerate 100% a 1-month span gives.
# Span is computed from date_trunc('month', ...) calendar arithmetic, not age() — age() is
# day-aware and can undercount the number of distinct months spanned (e.g. Jan 31 -> Mar 1 is
# 3 calendar months but age() reports ~1), which let the numerator exceed the denominator and
# produced rates over 100%.
REPEAT_RATE_SQL = """(
    SELECT CASE WHEN count(*) <= 1 THEN 0 ELSE round(
        100.0 * count(DISTINCT date_trunc('month', s.shipment_date))
        / GREATEST(1, (extract(year FROM max(s.shipment_date)) - extract(year FROM min(s.shipment_date)))*12
                       + (extract(month FROM max(s.shipment_date)) - extract(month FROM min(s.shipment_date))) + 1), 1)
    END
    FROM shipments s WHERE s.company_id = {alias}.company_id AND s.shipment_date IS NOT NULL
)"""
class CompanyIn(BaseModel):
    icris_number:str; company_name:str; legal_name:str|None=None; phone:str|None=None; email:str|None=None; address:str|None=None; pan_vat_number:str|None=None; customer_type:str|None=None; status:str='active'; notes:str|None=None
class CompanyPatch(BaseModel):
    company_name:str|None=None; legal_name:str|None=None; phone:str|None=None; email:str|None=None; address:str|None=None; pan_vat_number:str|None=None; customer_type:str|None=None; status:str|None=None; notes:str|None=None
class AliasIn(BaseModel): alias_name:str
class AssignAeIn(BaseModel): ae_code: str; reason: str|None=None
class ShipmentIn(BaseModel):
    shipment_number:str; company_id:uuid.UUID|None=None; shipment_date:date|None=None; pieces:int|None=Field(None,ge=0); shipment_weight:float|None=Field(None,ge=0); weight_unit:str|None=None; shipper_name:str|None=None; importer_name:str|None=None; importer_telephone:str|None=None; export_country:str|None=None; import_country:str|None=None; goods_description:str|None=None
class PackageIn(BaseModel): package_id:str; piece_number:int=Field(ge=1); package_weight:float|None=Field(None,ge=0); weight_unit:str|None=None; description:str|None=None; package_status:str|None=None; remarks:str|None=None
class LinkIn(BaseModel): company_id:uuid.UUID; save_as_alias:bool=False
class CrmManifestSyncIn(BaseModel):
    direction:Literal['export','import','both']='export';date_from:date;date_to:date;dry_run:bool=False;maximum_manifests:int|None=Field(None,ge=1,le=1000);retry_failed:bool=False;force_reparse:bool=False
class CrmSingleRecordIn(BaseModel):record_reference:str=Field(min_length=1,max_length=2048);dry_run:bool=True
class CrmBackfillIn(BaseModel):
    direction:Literal['export','import','both']='export';start_date:date|None=None;end_date:date=Field(default_factory=date.today);chunk_size_days:Literal[1,7,14,30]=7;confirm_start_date:bool=False;confirm_without_customer_master:bool=False
class CrmUpdateIn(BaseModel):direction:Literal['export','import']='export';overlap_days:int=Field(3,ge=1,le=30);force_recheck:bool=False
class CrmPnlSyncIn(BaseModel):date_from:date;date_to:date;dry_run:bool=False
class CrmUpsPnlSyncIn(BaseModel):date_from:date;date_to:date;dry_run:bool=False;maximum_manifests:int|None=Field(None,ge=1,le=200)
class CrmPipelineSyncIn(BaseModel):date_from:date|None=None;date_to:date|None=None;dry_run:bool=False
class QualityPatch(BaseModel): status:str; reason:str|None=None
class QualityFixIn(BaseModel):
    action:Literal['assign_company','set_field','save_alias','rename_company','merge','acknowledge']
    company_id:uuid.UUID|None=None; target_id:uuid.UUID|None=None; field:str|None=None; value:str|None=None; company_name:str|None=None
class UserCreate(BaseModel):
    email:str; display_name:str; role:Literal['super_admin','admin','sales_lead','ae','user']='user'; ae_code:str|None=None
class UserBulkCreate(BaseModel):
    users:list[UserCreate]=Field(min_length=1,max_length=200)
class UserPatch(BaseModel):
    display_name:str|None=None; role:Literal['super_admin','admin','sales_lead','ae','user']|None=None; ae_code:str|None=None; is_active:bool|None=None; email_alerts_enabled:bool|None=None
class SetPasswordIn(BaseModel):
    token:str; password:str=Field(min_length=8)
class AuthUserOut(BaseModel):
    id:str; email:str; display_name:str; role:str; ae_code:str|None=None; must_change_password:bool=False
def serialize(obj,extra=None):
    data={c.name:getattr(obj,c.name) for c in obj.__table__.columns}; data.update(extra or {}); return data
def one(db,model,id):
    value=db.get(model,id)
    if not value: raise HTTPException(404,f'{model.__name__} not found')
    return value
def scoped_company(db,company_id,ae_scope):
    """Same 404-not-403 treatment as the main company detail route — an AE probing
    a company_id outside their scope can't tell 'not yours' from 'does not exist'."""
    c=one(db,Company,company_id)
    if ae_scope and c.assigned_ae_code!=ae_scope:raise HTTPException(404,'Company not found')
    return c
def commit(db):
    try: db.commit()
    except IntegrityError as e: db.rollback(); log.exception('Database conflict'); raise HTTPException(409,'A record with this unique identifier already exists') from e
def log_activity(db,entity_type,entity_id,action,description,source='admin',metadata=None):
    db.add(ActivityLog(entity_type=entity_type,entity_id=entity_id,action=action,description=description,source=source,metadata_json=metadata))
@app.exception_handler(ValueError)
async def value_error(_:Request,exc:ValueError): return __import__('fastapi').responses.JSONResponse(status_code=422,content={'error':{'code':'validation_error','message':str(exc)}})
@app.get('/health')
def health(): return {'status':'ok'}

@app.post('/api/v1/auth/login', response_model=AuthUserOut)
def auth_login(body: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if user and not user.password_hash:
        raise HTTPException(status_code=401, detail='This account has not been activated yet — use your setup link to create a password.')
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail='Invalid credentials')
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=create_session_token(str(user.id)),
        httponly=True,
        samesite='lax',
        secure=False,
        path='/',
        max_age=AUTH_SESSION_TTL_SECONDS,
    )
    return serialize_user(user)

@app.get('/api/v1/auth/me', response_model=AuthUserOut)
def auth_me(user: User = Depends(get_current_user)):
    return serialize_user(user)

@app.post('/api/v1/auth/logout')
def auth_logout(response: Response):
    response.delete_cookie(AUTH_COOKIE_NAME, path='/')
    return {'status': 'ok'}

@app.post('/api/v1/auth/set-password', response_model=AuthUserOut)
def auth_set_password(body: SetPasswordIn, response: Response, db: Session = Depends(get_db)):
    """Public — the token is the credential. Used both for a brand-new account's first
    login and for an admin-issued 'reset link' on an existing account; either way this
    is the only place a user's own password gets set, never an admin-typed value."""
    user = find_user_by_setup_token(db, body.token)
    if not user:
        raise HTTPException(status_code=400, detail='This setup link is invalid or has expired — ask an admin to generate a new one.')
    if not user.is_active:
        raise HTTPException(status_code=403, detail='This account is deactivated.')
    user.password_hash = hash_password(body.password)
    user.must_change_password = False
    user.setup_token_hash = None
    user.setup_token_expires_at = None
    log_activity(db, 'user', user.id, 'password_set', f'{user.email} set their password via setup link')
    commit(db)
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=create_session_token(str(user.id)),
        httponly=True,
        samesite='lax',
        secure=False,
        path='/',
        max_age=AUTH_SESSION_TTL_SECONDS,
    )
    return serialize_user(user)

def serialize_admin_user(u:User,setup_link:str|None=None)->dict:
    d={'id':str(u.id),'email':u.email,'display_name':u.display_name,'role':u.role,'ae_code':u.ae_code,'is_active':u.is_active,'has_password':bool(u.password_hash),'must_change_password':u.must_change_password,'email_alerts_enabled':u.email_alerts_enabled,'created_at':u.created_at,'updated_at':u.updated_at}
    if setup_link:d['setup_link']=setup_link
    return d

def issue_setup_link(user:User)->str:
    """Generates a fresh one-time setup token for `user` and returns the full link an
    admin can copy and hand to them out-of-band — this app has no outbound email, so a
    shareable link is the entire delivery mechanism, not a fallback for one."""
    token,token_hash,expires_at=generate_setup_token()
    user.setup_token_hash=token_hash
    user.setup_token_expires_at=expires_at
    origin=(settings.frontend_base_url or settings.backend_cors_origins.split(',')[0]).strip().rstrip('/')
    return f'{origin}/set-password?token={token}'

@app.get('/api/v1/admin/users')
def admin_list_users(q:str|None=None,role:str|None=None,is_active:bool|None=None,limit:int=Query(50,le=200),offset:int=0,db:Session=Depends(get_db),_:User=Depends(require_role('super_admin'))):
    stmt=select(User)
    if q and q.strip():
        term=f'%{escape_like(q.strip())}%'
        stmt=stmt.where(or_(User.email.ilike(term,escape='\\'),User.display_name.ilike(term,escape='\\')))
    if role:stmt=stmt.where(User.role==role)
    if is_active is not None:stmt=stmt.where(User.is_active==is_active)
    total=db.scalar(select(func.count()).select_from(stmt.subquery()))
    items=db.scalars(stmt.order_by(User.display_name).limit(limit).offset(offset)).all()
    return {'items':[serialize_admin_user(u) for u in items],'total':total,'limit':limit,'offset':offset}

def validate_ae_code(db,role,ae_code):
    """'ae' role must point at a real, known AE code — otherwise the account is
    scoped to a code nothing will ever match, and silently sees zero data forever
    with no error to explain why. Same source of truth as AE Targets/AE Territory."""
    if role!='ae':return None
    code=(ae_code or '').strip().upper()
    if not code:raise HTTPException(422,'AE role requires an ae_code')
    if not db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==code)):
        raise HTTPException(422,f'Unknown AE code: {code}. It must match an existing Account Executive.')
    return code

def _create_user_no_password(db:Session,body:UserCreate)->User:
    """Shared by the single and bulk create endpoints. Raises HTTPException on any
    per-row validation failure (dup email, bad AE code) so the bulk endpoint can catch
    it per-row instead of aborting the whole batch on the first bad one."""
    email=body.email.strip().lower()
    if not email or '@' not in email:raise HTTPException(422,'A valid email is required')
    if not body.display_name.strip():raise HTTPException(422,'Display name is required')
    if db.scalar(select(User).where(User.email==email)):raise HTTPException(409,'A user with this email already exists')
    ae_code=validate_ae_code(db,body.role,body.ae_code)
    u=User(email=email,display_name=body.display_name.strip(),role=body.role,ae_code=ae_code,password_hash=None,must_change_password=True,is_active=True)
    db.add(u);db.flush()
    return u

@app.post('/api/v1/admin/users',status_code=201)
def admin_create_user(body:UserCreate,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    u=_create_user_no_password(db,body)
    link=issue_setup_link(u)
    log_activity(db,'user',u.id,'created',f'{admin.email} created user {u.email} ({u.role})')
    commit(db);return serialize_admin_user(u,setup_link=link)

@app.post('/api/v1/admin/users/bulk',status_code=201)
def admin_bulk_create_users(body:UserBulkCreate,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    """One button, many accounts. Every row is validated and created in its own
    savepoint so one bad row (dup email, unknown AE code) doesn't roll back the rows
    that were fine — the response tells the admin exactly which rows landed and why
    any others didn't, instead of an all-or-nothing failure."""
    results=[]
    for i,row in enumerate(body.users):
        try:
            with db.begin_nested():
                u=_create_user_no_password(db,row)
                link=issue_setup_link(u)
                log_activity(db,'user',u.id,'created',f'{admin.email} bulk-created user {u.email} ({u.role})')
            results.append({'row':i,'email':row.email,'status':'created','user':serialize_admin_user(u,setup_link=link)})
        except HTTPException as exc:
            results.append({'row':i,'email':row.email,'status':'error','error':exc.detail})
        except IntegrityError:
            results.append({'row':i,'email':row.email,'status':'error','error':'A user with this email already exists'})
    commit(db)
    return {'results':results,'created_count':sum(1 for r in results if r['status']=='created'),'error_count':sum(1 for r in results if r['status']=='error')}

@app.post('/api/v1/admin/users/{user_id}/setup-link')
def admin_issue_setup_link(user_id:uuid.UUID,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    """(Re)issues a one-time setup link — the only way a user (first login or a later
    forgot-password case) ever sets their own password. Invalidates any link issued
    earlier for this user; does not touch an existing password until the link is used."""
    u=one(db,User,user_id)
    link=issue_setup_link(u)
    log_activity(db,'user',u.id,'setup_link_issued',f'{admin.email} issued a new setup link for {u.email}')
    commit(db);return {'setup_link':link}

@app.patch('/api/v1/admin/users/{user_id}')
def admin_update_user(user_id:uuid.UUID,body:UserPatch,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    u=one(db,User,user_id)
    changes=body.model_dump(exclude_unset=True)
    if (changes.get('is_active') is False or ('role' in changes and changes.get('role')!='admin')) and u.id==admin.id:
        raise HTTPException(422,'You cannot deactivate or demote your own account')
    demoting_admin=u.role=='admin' and ('role' in changes and changes.get('role')!='admin')
    if (changes.get('is_active') is False or demoting_admin) and u.role=='admin':
        remaining=db.scalar(select(func.count()).select_from(User).where(User.role=='admin',User.is_active==True,User.id!=u.id))
        if not remaining:raise HTTPException(422,'Cannot deactivate or demote the last active admin')
    effective_role=changes.get('role',u.role)
    if effective_role=='ae':
        changes['ae_code']=validate_ae_code(db,effective_role,changes.get('ae_code',u.ae_code))
    elif 'role' in changes:
        changes.setdefault('ae_code',None)  # moving away from 'ae' clears a stale ae_code rather than leaving it dangling unused
    for k,v in changes.items():setattr(u,k,v.strip() if isinstance(v,str) else v)
    log_activity(db,'user',u.id,'updated',f'{admin.email} updated user {u.email} ({", ".join(changes) or "no fields"})')
    commit(db);return serialize_admin_user(u)

@app.get('/api/v1/admin/audit-logs')
def admin_audit_logs(entity_type:str|None=None,action:str|None=None,q:str|None=None,date_from:date|None=None,date_to:date|None=None,limit:int=Query(50,le=200),offset:int=0,db:Session=Depends(get_db),_:User=Depends(require_role('super_admin'))):
    stmt=select(ActivityLog)
    if entity_type:stmt=stmt.where(ActivityLog.entity_type==entity_type)
    if action:stmt=stmt.where(ActivityLog.action==action)
    if q and q.strip():stmt=stmt.where(ActivityLog.description.ilike(f'%{escape_like(q.strip())}%',escape='\\'))
    if date_from:stmt=stmt.where(ActivityLog.created_at>=date_from)
    if date_to:stmt=stmt.where(ActivityLog.created_at<date_to+timedelta(days=1))
    total=db.scalar(select(func.count()).select_from(stmt.subquery()))
    items=db.scalars(stmt.order_by(ActivityLog.created_at.desc()).limit(limit).offset(offset)).all()
    return {'items':[serialize(x) for x in items],'total':total,'limit':limit,'offset':offset}

def compute_inactivity(row: dict) -> dict:
    from datetime import date as _date, datetime as _datetime
    last_date_str = row.get('last_shipment_date')
    d = None
    if last_date_str:
        if isinstance(last_date_str, (_date, _datetime)):
            d = last_date_str if isinstance(last_date_str, _date) else last_date_str.date()
        else:
            try:
                d = _datetime.strptime(str(last_date_str)[:10], '%Y-%m-%d').date()
            except Exception:
                d = None
    
    if d is None:
        days = None
        status = 'dormant'
    else:
        days = (_date.today() - d).days
        if days < 30:
            status = 'active'
        elif days <= 60:
            status = 'quiet'
        elif days <= 90:
            status = 'inactive'
        else:
            status = 'dormant'
    
    row['days_since_last_shipment'] = days
    row['inactivity_status'] = status
    return row

@app.get('/api/v1/companies')
def companies(
    q:str|None=None,status:str|None=None,customer_type:str|None=None,inactivity_status:str|None=None,
    pay_term:str|None=None,has_shipments:bool|None=None,has_documents:bool|None=None,
    country:str|None=None,ae_code:str|None=None,
    min_revenue:float|None=None,max_revenue:float|None=None,
    min_shipments:int|None=None,max_shipments:int|None=None,
    min_weight:float|None=None,max_weight:float|None=None,
    limit:int=Query(50,le=200),offset:int=0,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)
):
    sql = f"""
        SELECT
            v.*,
            c.customer_type,
            c.email,
            c.phone,
            (SELECT s.ae_code FROM shipments s WHERE s.company_id = v.company_id AND s.ae_code IS NOT NULL AND s.ae_code != '' ORDER BY s.created_at DESC LIMIT 1) AS ae_code,
            (SELECT s.import_country FROM shipments s WHERE s.company_id = v.company_id AND s.import_country IS NOT NULL AND s.import_country != '' GROUP BY s.import_country ORDER BY count(*) DESC LIMIT 1) AS country,
            COALESCE((SELECT SUM({REVENUE_AMOUNT_SQL}) FROM shipments s WHERE s.company_id = v.company_id), 0)::float AS revenue,
            COALESCE((SELECT SUM(coalesce(s.shipment_weight, s.actual_weight, 0)) FROM shipments s WHERE s.company_id = v.company_id), 0)::float AS total_weight,
            COALESCE({REPEAT_RATE_SQL.format(alias='v')}, 0)::float AS repeat_rate
        FROM vw_company_operational_summary v
        JOIN companies c ON c.id = v.company_id
        WHERE c.status != 'archived'
    """
    args = {}
    if ae_scope: sql += ' AND c.assigned_ae_code = :ae_scope'; args['ae_scope'] = ae_scope
    if q and q.strip(): sql += " AND (v.icris_number ILIKE :q ESCAPE '\\' OR v.company_name ILIKE :q ESCAPE '\\')"; args['q'] = f'%{escape_like(q.strip())}%'
    if status:
        if status.lower() == 'official': sql += ' AND v.is_provisional = false'
        elif status.lower() == 'provisional': sql += ' AND v.is_provisional = true'
        else: sql += ' AND v.company_status = :status'; args['status'] = status
    if customer_type: sql += ' AND c.customer_type ILIKE :customer_type'; args['customer_type'] = customer_type
    if pay_term: sql += ' AND EXISTS (SELECT 1 FROM shipments s WHERE s.company_id = v.company_id AND s.pay_term ILIKE :pay_term)'; args['pay_term'] = f'%{pay_term}%'
    if has_shipments is not None: sql += f" AND v.shipment_count {'>' if has_shipments else '='} 0"
    if has_documents is not None: sql += f" AND v.document_count {'>' if has_documents else '='} 0"
    if inactivity_status == 'reactivated':
        sql += """
        AND EXISTS (
            SELECT 1 FROM shipments s_curr
            WHERE s_curr.company_id = c.id
              AND s_curr.shipment_date >= date_trunc('month', CURRENT_DATE)
        )
        AND NOT EXISTS (
            SELECT 1 FROM shipments s_prev
            WHERE s_prev.company_id = c.id
              AND s_prev.shipment_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '6 months'
              AND s_prev.shipment_date < date_trunc('month', CURRENT_DATE)
        )
        """

    sql += ' ORDER BY v.company_name'
    items = [compute_inactivity(dict(x._mapping)) for x in db.execute(text(sql), args)]

    if inactivity_status and inactivity_status != 'all' and inactivity_status != 'reactivated':
        items = [i for i in items if i.get('inactivity_status') == inactivity_status]
    if country: items = [i for i in items if country.strip().lower() in (i.get('country') or '').lower()]
    if ae_code: items = [i for i in items if ae_code.strip().lower() in (i.get('ae_code') or '').lower()]
    if min_revenue is not None: items = [i for i in items if (i.get('revenue') or 0) >= min_revenue]
    if max_revenue is not None: items = [i for i in items if (i.get('revenue') or 0) <= max_revenue]
    if min_shipments is not None: items = [i for i in items if (i.get('shipment_count') or 0) >= min_shipments]
    if max_shipments is not None: items = [i for i in items if (i.get('shipment_count') or 0) <= max_shipments]
    if min_weight is not None: items = [i for i in items if (i.get('total_weight') or 0) >= min_weight]
    if max_weight is not None: items = [i for i in items if (i.get('total_weight') or 0) <= max_weight]

    paginated = items[offset:offset+limit]
    return {'items': paginated, 'total': len(items), 'limit': limit, 'offset': offset}

@app.post('/api/v1/companies',status_code=201)
def create_company(body:CompanyIn,db:Session=Depends(get_db)):
    icris=normalize_icris(body.icris_number); name=body.company_name.strip()
    if not icris or not name:raise HTTPException(422,'ICRIS Number and Company Name are required')
    c=Company(**body.model_dump(exclude={'icris_number','company_name'}),icris_number=icris,company_name=name,normalized_name=normalize_name(name),source='manual',name_source='manual',manual_override_fields=['company_name']);db.add(c);commit(db);return serialize(c)

@app.get('/api/v1/companies/{company_id}')
def company(company_id:uuid.UUID,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    c=one(db,Company,company_id)
    if ae_scope and c.assigned_ae_code!=ae_scope:raise HTTPException(404,'Company not found')
    summary_raw=db.execute(text('SELECT * FROM vw_company_operational_summary WHERE company_id=:id'),{'id':company_id}).mappings().first()
    summary = compute_inactivity(dict(summary_raw)) if summary_raw else {}
    stats=db.execute(text(f"""
        SELECT
            (SELECT s.ae_code FROM shipments s WHERE s.company_id=:id AND s.ae_code IS NOT NULL AND s.ae_code != '' ORDER BY s.created_at DESC LIMIT 1) AS ae_code,
            (SELECT s.import_country FROM shipments s WHERE s.company_id=:id AND s.import_country IS NOT NULL AND s.import_country != '' GROUP BY s.import_country ORDER BY count(*) DESC LIMIT 1) AS country,
            COALESCE((SELECT SUM({REVENUE_AMOUNT_SQL}) FROM shipments s WHERE s.company_id=:id), 0)::float AS revenue,
            COALESCE({REPEAT_RATE_SQL.format(alias='sub')}, 0)::float AS repeat_rate
        FROM (SELECT :id AS company_id) sub
    """),{'id':company_id}).mappings().first()
    res = serialize(c, {'summary': summary, **dict(stats)})
    res['days_since_last_shipment'] = summary.get('days_since_last_shipment')
    res['inactivity_status'] = summary.get('inactivity_status')
    res['shipment_count'] = summary.get('shipment_count', 0)
    return res

@app.get('/api/v1/companies/{company_id}/dossier-pdf')
def company_dossier_pdf(
    company_id: uuid.UUID,
    date_from: date | None = None,
    date_to: date | None = None,
    timeframe_label: str | None = None,
    db: Session = Depends(get_db)
):
    c = one(db, Company, company_id)
    summary_raw = db.execute(text('SELECT * FROM vw_company_operational_summary WHERE company_id=:id'),{'id':company_id}).mappings().first()
    summary = compute_inactivity(dict(summary_raw)) if summary_raw else {}
    
    stmt = select(Shipment).where(Shipment.company_id == company_id)
    if date_from:
        stmt = stmt.where(or_(Shipment.shipment_date >= date_from, Shipment.created_at >= date_from))
    if date_to:
        stmt = stmt.where(or_(Shipment.shipment_date <= date_to, Shipment.created_at <= date_to))
    
    shipments = db.scalars(
        stmt.order_by(Shipment.shipment_date.desc(), Shipment.created_at.desc()).limit(15)
    ).all()
    
    if date_from or date_to:
        count_stmt = select(func.count(Shipment.id)).where(Shipment.company_id == company_id)
        pkg_stmt = select(func.coalesce(func.sum(Shipment.pieces), 0)).where(Shipment.company_id == company_id)
        if date_from:
            count_stmt = count_stmt.where(or_(Shipment.shipment_date >= date_from, Shipment.created_at >= date_from))
            pkg_stmt = pkg_stmt.where(or_(Shipment.shipment_date >= date_from, Shipment.created_at >= date_from))
        if date_to:
            count_stmt = count_stmt.where(or_(Shipment.shipment_date <= date_to, Shipment.created_at <= date_to))
            pkg_stmt = pkg_stmt.where(or_(Shipment.shipment_date <= date_to, Shipment.created_at <= date_to))
        
        filtered_shipment_count = db.scalar(count_stmt) or 0
        filtered_package_count = db.scalar(pkg_stmt) or 0
    else:
        filtered_shipment_count = summary.get('shipment_count', 0)
        filtered_package_count = summary.get('package_count', 0)

    docs_count = db.scalar(
        select(func.count(CompanyDocument.id))
        .where(CompanyDocument.company_id == company_id, CompanyDocument.status == 'active')
    ) or 0

    documents = db.scalars(
        select(CompanyDocument)
        .where(CompanyDocument.company_id == company_id, CompanyDocument.status == 'active')
        .order_by(CompanyDocument.uploaded_at.desc())
        .limit(20)
    ).all()

    total_revenue = db.scalar(text(
        f"SELECT coalesce(sum({REVENUE_AMOUNT_SQL}), 0) FROM shipments s WHERE s.company_id = :id"
    ), {'id': company_id}) or 0

    ae_code = db.scalar(text(
        "SELECT s.ae_code FROM shipments s WHERE s.company_id=:id AND s.ae_code IS NOT NULL AND s.ae_code != '' "
        "ORDER BY s.created_at DESC LIMIT 1"
    ), {'id': company_id})

    recent_activity = db.scalars(
        select(ActivityLog)
        .where(ActivityLog.entity_type == 'company', ActivityLog.entity_id == company_id)
        .order_by(ActivityLog.created_at.desc())
        .limit(10)
    ).all()

    dest_sql = "SELECT import_country, COUNT(*) as cnt FROM shipments WHERE company_id=:id AND import_country IS NOT NULL"
    dest_args = {'id': company_id}
    if date_from:
        dest_sql += " AND (shipment_date >= :df OR created_at >= :df)"
        dest_args['df'] = date_from
    if date_to:
        dest_sql += " AND (shipment_date <= :dt OR created_at <= :dt)"
        dest_args['dt'] = date_to
    dest_sql += " GROUP BY import_country ORDER BY cnt DESC LIMIT 5"

    dest_rows = db.execute(text(dest_sql), dest_args).all()

    import io
    from reportlab.lib.pagesizes import letter
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from datetime import datetime as _datetime
    from xml.sax.saxutils import escape as _esc
    
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter, leftMargin=36, rightMargin=36, topMargin=36, bottomMargin=36)
    story = []
    
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=20,
        leading=24,
        textColor=colors.HexColor('#0F172A')
    )
    subtitle_style = ParagraphStyle(
        'SubTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=10,
        leading=12,
        textColor=colors.HexColor('#0F766E')
    )
    heading2_style = ParagraphStyle(
        'SectionHeader',
        parent=styles['Heading2'],
        fontName='Helvetica-Bold',
        fontSize=12,
        leading=15,
        textColor=colors.HexColor('#0F766E'),
        spaceBefore=12,
        spaceAfter=6
    )
    body_style = ParagraphStyle(
        'BodyTextCustom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=colors.HexColor('#334155')
    )
    bold_body = ParagraphStyle(
        'BoldBody',
        parent=body_style,
        fontName='Helvetica-Bold'
    )

    # Timeframe string
    if timeframe_label:
        period_str = f"Period: <b>{timeframe_label}</b>"
    elif date_from and date_to:
        period_str = f"Period: <b>{date_from} → {date_to}</b>"
    elif date_from:
        period_str = f"Period: <b>From {date_from}</b>"
    elif date_to:
        period_str = f"Period: <b>Up to {date_to}</b>"
    else:
        period_str = "Period: <b>All Time (Cumulative History)</b>"

    # 1. Header Banner
    story.append(Paragraph("SHANGRILA COURIER INTELLIGENCE", subtitle_style))
    story.append(Spacer(1, 2))
    story.append(Paragraph(f"Customer 360 Account Dossier: {_esc(c.company_name)}", title_style))
    story.append(Paragraph(f"ICRIS: <b>{_esc(c.icris_number or 'Not assigned')}</b> · {period_str} · Generated: {_datetime.now().strftime('%B %d, %Y %H:%M')}", body_style))
    story.append(Spacer(1, 8))
    story.append(HRFlowable(width="100%", thickness=2, color=colors.HexColor("#0F766E"), spaceAfter=14))

    # 2. Executive Key Summary KPI Grid Table
    inactivity_label = (summary.get('inactivity_status') or 'dormant').upper()
    days_inactive = summary.get('days_since_last_shipment')
    inact_desc = f"{days_inactive} days" if days_inactive is not None else "No shipments"
    
    kpi_data = [
        [
            Paragraph("<b>Air Waybills (Period)</b>", body_style),
            Paragraph("<b>Total Packages</b>", body_style),
            Paragraph("<b>Inactivity Status</b>", body_style),
            Paragraph("<b>Vault Documents</b>", body_style)
        ],
        [
            Paragraph(str(filtered_shipment_count), ParagraphStyle('V1', parent=bold_body, fontSize=14, leading=16, textColor=colors.HexColor('#0F766E'))),
            Paragraph(str(filtered_package_count), ParagraphStyle('V2', parent=bold_body, fontSize=14, leading=16, textColor=colors.HexColor('#0F766E'))),
            Paragraph(f"<b>{inactivity_label}</b><br/><font size=7 color='#64748B'>{inact_desc}</font>", body_style),
            Paragraph(str(docs_count), ParagraphStyle('V4', parent=bold_body, fontSize=14, leading=16, textColor=colors.HexColor('#0F766E')))
        ]
    ]
    t_kpi = Table(kpi_data, colWidths=[135, 135, 135, 135])
    t_kpi.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#F8FAFC')),
        ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#E2E8F0')),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
        ('PADDING', (0,0), (-1,-1), 8),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
    ]))
    story.append(t_kpi)
    story.append(Spacer(1, 14))

    # 3. Company Profile Master Details Table
    story.append(Paragraph("Company Master Details", heading2_style))
    master_data = [
        [Paragraph("<b>ICRIS Code:</b>", body_style), Paragraph(_esc(c.icris_number or 'Not assigned'), body_style), Paragraph("<b>Status:</b>", body_style), Paragraph(_esc(c.status or 'active'), body_style)],
        [Paragraph("<b>Company Name:</b>", body_style), Paragraph(_esc(c.company_name), body_style), Paragraph("<b>Provisional Account:</b>", body_style), Paragraph("Yes" if c.is_provisional else "No", body_style)],
        [Paragraph("<b>Legal Name:</b>", body_style), Paragraph(_esc(c.legal_name or 'Not supplied'), body_style), Paragraph("<b>Customer Type:</b>", body_style), Paragraph(_esc(c.customer_type or 'Standard'), body_style)],
        [Paragraph("<b>Phone Contact:</b>", body_style), Paragraph(_esc(c.phone or 'Not supplied'), body_style), Paragraph("<b>Email Address:</b>", body_style), Paragraph(_esc(c.email or 'Not supplied'), body_style)],
        [Paragraph("<b>PAN / VAT No:</b>", body_style), Paragraph(_esc(c.pan_vat_number or 'Not supplied'), body_style), Paragraph("<b>Account Executive:</b>", body_style), Paragraph(_esc(ae_code or 'Unassigned'), body_style)],
        [Paragraph("<b>Address:</b>", body_style), Paragraph(_esc(c.address or 'Not supplied'), body_style), Paragraph("<b>Total Revenue (All-Time):</b>", body_style), Paragraph(f"${float(total_revenue):,.2f}", body_style)],
    ]
    t_master = Table(master_data, colWidths=[100, 170, 100, 170])
    t_master.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), colors.HexColor('#FFFFFF')),
        ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#CBD5E1')),
        ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#F1F5F9')),
        ('PADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t_master)
    story.append(Spacer(1, 14))

    # 4. Top Shipping Destinations Table
    if dest_rows:
        story.append(Paragraph("Top Shipping Destinations", heading2_style))
        dest_table_data = [[Paragraph("<b>Destination Country</b>", body_style), Paragraph("<b>Air Waybills Count</b>", body_style)]]
        for row in dest_rows:
            dest_table_data.append([
                Paragraph(str(row.import_country), body_style),
                Paragraph(str(row.cnt), body_style)
            ])
        t_dest = Table(dest_table_data, colWidths=[340, 200])
        t_dest.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#F1F5F9')),
            ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#CBD5E1')),
            ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
            ('PADDING', (0,0), (-1,-1), 5),
        ]))
        story.append(t_dest)
        story.append(Spacer(1, 14))

    # 5. Recent Air Waybills Table
    story.append(Paragraph("Air Waybill Manifest Records", heading2_style))
    if shipments:
        sw_data = [[
            Paragraph("<b>AWB Number</b>", body_style),
            Paragraph("<b>Date</b>", body_style),
            Paragraph("<b>Shipper / Exporter</b>", body_style),
            Paragraph("<b>Consignee / Importer</b>", body_style),
            Paragraph("<b>Bill Amount</b>", body_style)
        ]]
        for s in shipments:
            s_date = s.shipment_date.strftime('%Y-%m-%d') if s.shipment_date else (s.created_at.strftime('%Y-%m-%d') if s.created_at else '—')
            sw_data.append([
                Paragraph(f"<b>{_esc(s.shipment_number or '—')}</b>", body_style),
                Paragraph(s_date, body_style),
                Paragraph(_esc(s.shipper_name or s.source_customer_name or '—'), body_style),
                Paragraph(_esc(s.importer_name or '—'), body_style),
                Paragraph(f"${s.bill_amount}" if s.bill_amount else '—', body_style)
            ])
        t_sw = Table(sw_data, colWidths=[100, 75, 145, 145, 75])
        t_sw.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#F1F5F9')),
            ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#CBD5E1')),
            ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
            ('PADDING', (0,0), (-1,-1), 5),
        ]))
        story.append(t_sw)
    else:
        story.append(Paragraph("<i>No Air Waybills matching this period for this company.</i>", body_style))

    story.append(Spacer(1, 14))

    # 6. Documents Vault
    story.append(Paragraph(f"Documents Vault ({docs_count} on file)", heading2_style))
    if documents:
        doc_data = [[
            Paragraph("<b>Title</b>", body_style),
            Paragraph("<b>Category</b>", body_style),
            Paragraph("<b>Size</b>", body_style),
            Paragraph("<b>Uploaded</b>", body_style)
        ]]
        for d in documents:
            up_date = d.uploaded_at.strftime('%Y-%m-%d') if d.uploaded_at else '—'
            size_kb = f"{round((d.file_size_bytes or 0) / 1024)} KB"
            doc_data.append([
                Paragraph(_esc(d.title or d.original_file_name), body_style),
                Paragraph(_esc((d.category or 'other').replace('_', ' ').title()), body_style),
                Paragraph(size_kb, body_style),
                Paragraph(up_date, body_style)
            ])
        t_doc = Table(doc_data, colWidths=[220, 130, 75, 115])
        t_doc.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#F1F5F9')),
            ('BOX', (0,0), (-1,-1), 1, colors.HexColor('#CBD5E1')),
            ('INNERGRID', (0,0), (-1,-1), 0.5, colors.HexColor('#E2E8F0')),
            ('PADDING', (0,0), (-1,-1), 5),
        ]))
        story.append(t_doc)
    else:
        story.append(Paragraph("<i>No documents uploaded for this account.</i>", body_style))

    story.append(Spacer(1, 14))

    # 7. Recent Activity
    story.append(Paragraph("Recent Activity", heading2_style))
    if recent_activity:
        for a in recent_activity:
            ts = a.created_at.strftime('%Y-%m-%d %H:%M') if a.created_at else '—'
            story.append(Paragraph(f"<b>{ts}</b> — {_esc(a.description)} <font size=7 color='#94A3B8'>({_esc(a.source)})</font>", body_style))
            story.append(Spacer(1, 3))
    else:
        story.append(Paragraph("<i>No activity recorded for this account.</i>", body_style))

    story.append(Spacer(1, 20))
    story.append(Paragraph("CONFIDENTIAL · Shangrila Tours Customer 360 Operational Intelligence", ParagraphStyle('Footer', parent=body_style, fontSize=8, textColor=colors.HexColor('#94A3B8'), alignment=1)))

    doc.build(story)
    pdf_bytes = buffer.getvalue()
    buffer.close()

    filename = f"Customer360_Dossier_{c.icris_number or c.id}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

@app.patch('/api/v1/companies/{company_id}')
def patch_company(company_id:uuid.UUID,body:CompanyPatch,db:Session=Depends(get_db)):
    c=one(db,Company,company_id)
    changes=body.model_dump(exclude_unset=True);overrides=set(c.manual_override_fields or [])
    for k,v in changes.items(): setattr(c,k,v.strip() if isinstance(v,str) else v);overrides.add(k)
    c.manual_override_fields=sorted(overrides)
    if body.company_name is not None:c.normalized_name=normalize_name(c.company_name)
    commit(db);return serialize(c)

@app.post('/api/v1/companies/{company_id}/assign-ae')
def assign_ae(company_id:uuid.UUID, payload: AssignAeIn, db:Session=Depends(get_db), _role:User=Depends(require_role('admin'))):
    comp=one(db,Company,company_id)
    new_code=payload.ae_code.strip().upper()
    if not new_code:raise HTTPException(422,'ae_code is required')
    if comp.assigned_ae_code==new_code:return {'status':'unchanged','ae_code':new_code,'shipments_updated':0}
    ae=db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==new_code))
    if not ae:ae=AccountExecutive(ae_code=new_code,is_active=True);db.add(ae)
    updated=reassign_company(db,comp,new_code,reason=payload.reason,source='manual',changed_by_user_id=None)
    commit(db)
    return {'status':'reassigned','ae_code':new_code,'shipments_updated':updated}

@app.get('/api/v1/companies/{company_id}/ae-history')
def company_ae_history(company_id:uuid.UUID,db:Session=Depends(get_db)):
    one(db,Company,company_id)
    return [serialize(x) for x in db.scalars(select(AeReassignmentLog).where(AeReassignmentLog.company_id==company_id).order_by(AeReassignmentLog.created_at.desc())).all()]

@app.get('/api/v1/account-executives')
def list_account_executives(active_only:bool=False,db:Session=Depends(get_db)):
    stmt=select(AccountExecutive).order_by(AccountExecutive.ae_code)
    if active_only:stmt=stmt.where(AccountExecutive.is_active==True)
    aes=db.scalars(stmt).all()
    counts=dict(db.execute(select(Company.assigned_ae_code,func.count()).where(Company.assigned_ae_code.is_not(None)).group_by(Company.assigned_ae_code)).all())
    return [serialize(a,{'assigned_customer_count':counts.get(a.ae_code,0)}) for a in aes]

class AccountExecutiveIn(BaseModel): display_name:str|None=None; is_active:bool|None=None
class AccountExecutiveCreateIn(BaseModel): ae_code:str; display_name:str|None=None

@app.post('/api/v1/account-executives')
def create_account_executive(body:AccountExecutiveCreateIn,db:Session=Depends(get_db)):
    code=body.ae_code.strip().upper()
    if not code:raise HTTPException(422,'ae_code is required')
    if db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==code)):raise HTTPException(409,'AE code already exists')
    ae=AccountExecutive(ae_code=code,display_name=body.display_name,is_active=True)
    db.add(ae);commit(db);return serialize(ae,{'assigned_customer_count':0})

@app.patch('/api/v1/account-executives/{ae_code}')
def update_account_executive(ae_code:str,body:AccountExecutiveIn,db:Session=Depends(get_db)):
    ae=db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==ae_code.strip().upper()))
    if not ae:raise HTTPException(404,'AE not found')
    changes=body.model_dump(exclude_unset=True)
    for k,v in changes.items():setattr(ae,k,v)
    commit(db);return serialize(ae)

@app.delete('/api/v1/account-executives/{ae_code}')
def delete_account_executive(ae_code:str,force:bool=False,db:Session=Depends(get_db)):
    code=ae_code.strip().upper()
    ae=db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==code))
    if not ae:raise HTTPException(404,'AE not found')
    assigned_customer_count=db.scalar(select(func.count()).where(Company.assigned_ae_code==code)) or 0
    user_count=db.scalar(select(func.count()).where(User.ae_code==code)) or 0
    if (assigned_customer_count or user_count) and not force:
        raise HTTPException(409,{'detail':f'{code} is still referenced by {assigned_customer_count} customer(s) and {user_count} user(s)','assigned_customer_count':assigned_customer_count,'user_count':user_count})
    db.delete(ae);commit(db);return {'status':'deleted','ae_code':code}

async def read_ae_workbook(file:UploadFile):
    if Path(file.filename or '').suffix.casefold() not in {'.xlsx','.xlsm'}:raise HTTPException(415,'AE assignment file must be an .xlsx workbook')
    data=await file.read(settings.max_company_import_mb*1024*1024+1)
    if len(data)>settings.max_company_import_mb*1024*1024:raise HTTPException(413,'AE import exceeds configured upload limit')
    return data

@app.post('/api/v1/ae-imports/preview')
async def ae_import_preview(file:UploadFile=File(...),worksheet:str|None=Form(None),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    data=await read_ae_workbook(file)
    try:return analyze_ae_workbook(db,parse_ae_workbook(data,file.filename or 'upload.xlsx',worksheet))
    except AeWorkbookError as exc:raise HTTPException(422,str(exc)) from exc

@app.post('/api/v1/ae-imports',status_code=201)
async def ae_import_commit(file:UploadFile=File(...),worksheet:str|None=Form(None),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    data=await read_ae_workbook(file)
    try:
        batch=import_ae_assignments(db,data,file.filename or 'upload.xlsx',worksheet,changed_by_user_id=None);db.commit();db.refresh(batch)
    except AeWorkbookError as exc:db.rollback();raise HTTPException(422,str(exc)) from exc
    except Exception:db.rollback();log.exception('AE assignment import rolled back');raise
    return serialize(batch)

@app.get('/api/v1/ae-imports')
def ae_import_batches(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [serialize(x) for x in db.scalars(select(AeImportBatch).order_by(AeImportBatch.created_at.desc())).all()]
@app.get('/api/v1/ae-imports/{batch_id}')
def ae_import_batch(batch_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return serialize(one(db,AeImportBatch,batch_id))
@app.get('/api/v1/ae-imports/{batch_id}/rows')
def ae_import_rows(batch_id:uuid.UUID,status:str|None=None,limit:int=Query(200,le=1000),offset:int=0,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    stmt=select(AeImportRow).where(AeImportRow.import_batch_id==batch_id)
    if status:stmt=stmt.where(AeImportRow.processing_status==status)
    return [serialize(x) for x in db.scalars(stmt.order_by(AeImportRow.row_number).limit(limit).offset(offset)).all()]

# --- AE Targets -----------------------------------------------------------------------
class AeTargetIn(BaseModel):
    ae_code:str; year:int=Field(ge=2000,le=2100); month:int=Field(ge=1,le=12)
    weight_target:float|None=None; piece_target:int|None=Field(None,ge=0); revenue_target:float|None=None
    weight_target_import:float|None=None; piece_target_import:int|None=Field(None,ge=0); revenue_target_import:float|None=None
    notes:str|None=None
class AeTargetPatch(BaseModel):
    weight_target:float|None=None; piece_target:int|None=Field(None,ge=0); revenue_target:float|None=None
    weight_target_import:float|None=None; piece_target_import:int|None=Field(None,ge=0); revenue_target_import:float|None=None
    notes:str|None=None

@app.get('/api/v1/ae-targets')
def list_ae_targets(year:int|None=None,ae_code:str|None=None,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    stmt=select(AeTarget).order_by(AeTarget.ae_code,AeTarget.year,AeTarget.month)
    if year:stmt=stmt.where(AeTarget.year==year)
    if ae_code:stmt=stmt.where(AeTarget.ae_code==ae_code.strip().upper())
    return [serialize(x) for x in db.scalars(stmt).all()]

@app.post('/api/v1/ae-targets',status_code=201)
def upsert_ae_target(body:AeTargetIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    ae_code=body.ae_code.strip().upper()
    if not db.scalar(select(AccountExecutive).where(AccountExecutive.ae_code==ae_code)):raise HTTPException(422,f'Unknown AE code: {ae_code}')
    existing=db.scalar(select(AeTarget).where(AeTarget.ae_code==ae_code,AeTarget.year==body.year,AeTarget.month==body.month))
    if not existing:existing=AeTarget(ae_code=ae_code,year=body.year,month=body.month,source='manual');db.add(existing)
    else:existing.source='manual'
    for field in ('weight_target','piece_target','revenue_target','weight_target_import','piece_target_import','revenue_target_import','notes'):
        setattr(existing,field,getattr(body,field))
    commit(db);return serialize(existing)

@app.patch('/api/v1/ae-targets/{target_id}')
def patch_ae_target(target_id:uuid.UUID,body:AeTargetPatch,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    target=one(db,AeTarget,target_id);target.source='manual'
    for k,v in body.model_dump(exclude_unset=True).items():setattr(target,k,v)
    commit(db);return serialize(target)

@app.delete('/api/v1/ae-targets/{target_id}',status_code=204)
def delete_ae_target(target_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    db.delete(one(db,AeTarget,target_id));commit(db)

async def read_ae_target_workbook(file:UploadFile):
    if Path(file.filename or '').suffix.casefold() not in {'.xlsx','.xlsm'}:raise HTTPException(415,'AE targets file must be an .xlsx workbook')
    data=await file.read(settings.max_company_import_mb*1024*1024+1)
    if len(data)>settings.max_company_import_mb*1024*1024:raise HTTPException(413,'AE targets import exceeds configured upload limit')
    return data

@app.post('/api/v1/ae-targets/import')
async def ae_targets_import(file:UploadFile=File(...),worksheet:str|None=Form(None),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    data=await read_ae_target_workbook(file)
    try:
        stats=import_ae_targets(db,data,file.filename or 'upload.xlsx',worksheet);commit(db)
    except AeTargetWorkbookError as exc:db.rollback();raise HTTPException(422,str(exc)) from exc
    except Exception:db.rollback();log.exception('AE targets import rolled back');raise
    return stats

@app.get('/api/v1/companies/{company_id}/shipments')
def company_shipments(company_id:uuid.UUID,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)): scoped_company(db,company_id,ae_scope);return [serialize(x,{'package_count':len(x.packages)}) for x in db.scalars(select(Shipment).options(selectinload(Shipment.packages)).where(Shipment.company_id==company_id)).all()]
@app.get('/api/v1/companies/{company_id}/aliases')
def aliases(company_id:uuid.UUID,db:Session=Depends(get_db)): return [serialize(x) for x in db.scalars(select(CompanyAlias).where(CompanyAlias.company_id==company_id)).all()]
@app.delete('/api/v1/companies/{company_id}',status_code=204)
def delete_company(company_id:uuid.UUID,db:Session=Depends(get_db)):
    c=one(db,Company,company_id);c.status='archived';commit(db);return Response(status_code=204)

@app.post('/api/v1/companies/{company_id}/aliases',status_code=201)
def add_alias(company_id:uuid.UUID,body:AliasIn,db:Session=Depends(get_db)):
    one(db,Company,company_id);name=body.alias_name.strip();a=CompanyAlias(company_id=company_id,alias_name=name,normalized_alias_name=normalize_name(name),source='manual');db.add(a);commit(db);return serialize(a)
@app.delete('/api/v1/companies/{company_id}/aliases/{alias_id}',status_code=204)
def delete_alias(company_id:uuid.UUID,alias_id:uuid.UUID,db:Session=Depends(get_db)):
    a=one(db,CompanyAlias,alias_id)
    if a.company_id!=company_id:raise HTTPException(404,'Alias not found')
    db.delete(a);commit(db)

def shipment_revenue(s)->float:
    if (s.pay_term or '').strip().upper() not in BILLABLE_PAY_TERMS:return 0.0
    return float(s.bill_amount if s.bill_amount is not None else (s.declared_value or 0))

@app.get('/api/v1/shipments')
def shipments(q:str|None=None,company_id:uuid.UUID|None=None,shipment_number:str|None=None,package_id:str|None=None,shipper_name:str|None=None,importer_name:str|None=None,importer_telephone:str|None=None,export_country:str|None=None,import_country:str|None=None,bill_type:str|None=None,billing_term:str|None=None,match_status:str|None=None,manifest_batch_id:uuid.UUID|None=None,min_weight:float|None=None,max_weight:float|None=None,date_from:date|None=None,date_to:date|None=None,limit:int=Query(50,le=200),offset:int=0,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    stmt=select(Shipment)
    filters={'company_id':company_id,'billing_term':billing_term,'match_status':match_status,'manifest_batch_id':manifest_batch_id}
    for k,v in filters.items():
        if v is not None:stmt=stmt.where(getattr(Shipment,k)==v)
    if ae_scope:stmt=stmt.where(Shipment.ae_code==ae_scope)
    if export_country:stmt=stmt.where(Shipment.export_country.ilike(f'%{export_country}%'))
    if import_country:stmt=stmt.where(Shipment.import_country.ilike(f'%{import_country}%'))
    if bill_type:stmt=stmt.where(Shipment.bill_type.ilike(f'%{bill_type}%'))
    if shipment_number:stmt=stmt.where(Shipment.shipment_number.ilike(f'%{shipment_number}%'))
    if shipper_name:stmt=stmt.where(Shipment.shipper_name.ilike(f'%{shipper_name}%'))
    if importer_name:stmt=stmt.where(Shipment.importer_name.ilike(f'%{importer_name}%'))
    if importer_telephone:stmt=stmt.where(Shipment.importer_telephone.ilike(f'%{importer_telephone}%'))
    if package_id:stmt=stmt.where(Shipment.id.in_(select(Package.shipment_id).where(Package.package_id.ilike(f'%{package_id}%'))))
    if q and q.strip():
        # The search box promises "AWB Number, Customer, Destination, Airline" — this used to
        # only actually match shipment_number/package_id, silently ignoring everything else
        # it claimed to search. Customer covers both the linked company name and, for
        # unlinked shipments, the raw shipper/importer name the list falls back to displaying.
        term=f'%{escape_like(q.strip())}%'
        stmt=stmt.where(or_(
            Shipment.shipment_number.ilike(term,escape='\\'),
            Shipment.shipper_name.ilike(term,escape='\\'),
            Shipment.importer_name.ilike(term,escape='\\'),
            Shipment.import_country.ilike(term,escape='\\'),
            Shipment.export_country.ilike(term,escape='\\'),
            Shipment.company_id.in_(select(Company.id).where(Company.company_name.ilike(term,escape='\\'))),
            Shipment.mawb_id.in_(select(MasterAirWaybill.id).where(MasterAirWaybill.flight_number.ilike(term,escape='\\'))),
            Shipment.id.in_(select(Package.shipment_id).where(Package.package_id.ilike(term,escape='\\'))),
        ))
    weight_expr=func.coalesce(Shipment.shipment_weight,Shipment.actual_weight)
    if min_weight is not None:stmt=stmt.where(weight_expr>=min_weight)
    if max_weight is not None:stmt=stmt.where(weight_expr<=max_weight)
    # Filters against created_at (not shipment_date) to match the "Date" column the AWB list actually displays.
    if date_from:stmt=stmt.where(func.date(Shipment.created_at)>=date_from)
    if date_to:stmt=stmt.where(func.date(Shipment.created_at)<=date_to)
    total=db.scalar(select(func.count()).select_from(stmt.subquery()))
    items=db.scalars(stmt.options(selectinload(Shipment.company),selectinload(Shipment.packages)).order_by(Shipment.created_at.desc()).limit(limit).offset(offset)).all()
    return {'items':[serialize(s,{'company':serialize(s.company) if s.company else None,'package_count':len(s.packages),'revenue':shipment_revenue(s)}) for s in items],'total':total,'limit':limit,'offset':offset}

@app.get('/api/v1/shipments/stats')
def shipment_stats(q:str|None=None,company_id:uuid.UUID|None=None,shipment_number:str|None=None,package_id:str|None=None,shipper_name:str|None=None,importer_name:str|None=None,importer_telephone:str|None=None,export_country:str|None=None,import_country:str|None=None,bill_type:str|None=None,billing_term:str|None=None,match_status:str|None=None,manifest_batch_id:uuid.UUID|None=None,db:Session=Depends(get_db)):
    stmt = select(
        func.count(Shipment.id).label('total_shipments'),
        func.sum(func.coalesce(Shipment.shipment_weight, Shipment.actual_weight)).label('total_weight'),
        func.avg(func.coalesce(Shipment.shipment_weight, Shipment.actual_weight)).label('avg_weight'),
        func.sum(case((Shipment.match_status == 'matched', 1), else_=0)).label('matched_count'),
        func.sum(case((Shipment.match_status == 'unmatched', 1), else_=0)).label('unmatched_count'),
        func.sum(case((Shipment.match_status == 'suggested', 1), else_=0)).label('suggested_count')
    )
    filters={'company_id':company_id,'billing_term':billing_term,'match_status':match_status,'manifest_batch_id':manifest_batch_id}
    for k,v in filters.items():
        if v is not None:stmt=stmt.where(getattr(Shipment,k)==v)
    if export_country:stmt=stmt.where(Shipment.export_country.ilike(f'%{export_country}%'))
    if import_country:stmt=stmt.where(Shipment.import_country.ilike(f'%{import_country}%'))
    if bill_type:stmt=stmt.where(Shipment.bill_type.ilike(f'%{bill_type}%'))
    if shipment_number:stmt=stmt.where(Shipment.shipment_number.ilike(f'%{shipment_number}%'))
    if shipper_name:stmt=stmt.where(Shipment.shipper_name.ilike(f'%{shipper_name}%'))
    if importer_name:stmt=stmt.where(Shipment.importer_name.ilike(f'%{importer_name}%'))
    if importer_telephone:stmt=stmt.where(Shipment.importer_telephone.ilike(f'%{importer_telephone}%'))
    if package_id:stmt=stmt.where(Shipment.id.in_(select(Package.shipment_id).where(Package.package_id.ilike(f'%{package_id}%'))))
    if q and q.strip():
        # The search box promises "AWB Number, Customer, Destination, Airline" — this used to
        # only actually match shipment_number/package_id, silently ignoring everything else
        # it claimed to search. Customer covers both the linked company name and, for
        # unlinked shipments, the raw shipper/importer name the list falls back to displaying.
        term=f'%{escape_like(q.strip())}%'
        stmt=stmt.where(or_(
            Shipment.shipment_number.ilike(term,escape='\\'),
            Shipment.shipper_name.ilike(term,escape='\\'),
            Shipment.importer_name.ilike(term,escape='\\'),
            Shipment.import_country.ilike(term,escape='\\'),
            Shipment.export_country.ilike(term,escape='\\'),
            Shipment.company_id.in_(select(Company.id).where(Company.company_name.ilike(term,escape='\\'))),
            Shipment.mawb_id.in_(select(MasterAirWaybill.id).where(MasterAirWaybill.flight_number.ilike(term,escape='\\'))),
            Shipment.id.in_(select(Package.shipment_id).where(Package.package_id.ilike(term,escape='\\'))),
        ))
    row = db.execute(stmt).mappings().one()
    return {
        'total_shipments': row['total_shipments'] or 0,
        'total_weight': float(row['total_weight'] or 0),
        'avg_weight': float(row['avg_weight'] or 0),
        'matched_count': int(row['matched_count'] or 0),
        'unmatched_count': int(row['unmatched_count'] or 0),
        'suggested_count': int(row['suggested_count'] or 0)
    }
@app.post('/api/v1/shipments',status_code=201)
def create_shipment(body:ShipmentIn,db:Session=Depends(get_db)):
    values=body.model_dump();values['shipment_number']=body.shipment_number.strip();s=Shipment(**values,source='manual',match_status='matched' if body.company_id else 'unmatched',matched_by_method='manual' if body.company_id else 'none',manually_matched=bool(body.company_id));db.add(s);commit(db);return serialize(s)
@app.get('/api/v1/shipments/{shipment_id}')
def shipment(shipment_id:uuid.UUID,db:Session=Depends(get_db)):
    s=db.scalar(select(Shipment).options(selectinload(Shipment.company),selectinload(Shipment.packages)).where(Shipment.id==shipment_id))
    if not s:raise HTTPException(404,'Shipment not found')
    mawb=db.get(MasterAirWaybill,s.mawb_id) if s.mawb_id else None
    return serialize(s,{'company':serialize(s.company) if s.company else None,'mawb':serialize(mawb) if mawb else None,'packages':[serialize(p) for p in s.packages],'revenue':shipment_revenue(s)})
@app.patch('/api/v1/shipments/{shipment_id}')
def patch_shipment(shipment_id:uuid.UUID,body:dict,db:Session=Depends(get_db)):
    s=one(db,Shipment,shipment_id);allowed={c.name for c in Shipment.__table__.columns}-{'id','shipment_number','created_at','updated_at'}
    overrides=set(s.manual_override_fields or [])
    for k,v in body.items():
        if k in allowed:setattr(s,k,v);overrides.add(k)
    s.manual_override_fields=sorted(overrides)
    commit(db);return serialize(s)
@app.get('/api/v1/shipments/{shipment_id}/packages')
def shipment_packages(shipment_id:uuid.UUID,db:Session=Depends(get_db)):one(db,Shipment,shipment_id);return [serialize(p) for p in db.scalars(select(Package).where(Package.shipment_id==shipment_id)).all()]
@app.post('/api/v1/shipments/{shipment_id}/packages',status_code=201)
def create_package(shipment_id:uuid.UUID,body:PackageIn,db:Session=Depends(get_db)):one(db,Shipment,shipment_id);p=Package(shipment_id=shipment_id,**body.model_dump());db.add(p);commit(db);return serialize(p)
@app.post('/api/v1/shipments/{shipment_id}/link-company')
def link(shipment_id:uuid.UUID,body:LinkIn,db:Session=Depends(get_db)):
    s=one(db,Shipment,shipment_id);one(db,Company,body.company_id);s.company_id=body.company_id;s.match_status='manually_linked';s.matched_by_method='manual';s.manually_matched=True;s.is_manually_matched=True
    if body.save_as_alias and s.shipper_name:
        norm=normalize_name(s.shipper_name)
        if not db.scalar(select(CompanyAlias).where(CompanyAlias.company_id==body.company_id,CompanyAlias.normalized_alias_name==norm)):db.add(CompanyAlias(company_id=body.company_id,alias_name=s.shipper_name,normalized_alias_name=norm,source='manifest'))
    commit(db);return serialize(s)
@app.delete('/api/v1/shipments/{shipment_id}/company-link')
def unlink(shipment_id:uuid.UUID,db:Session=Depends(get_db)):s=one(db,Shipment,shipment_id);s.company_id=None;s.match_status='unmatched';s.matched_by_method='none';s.manually_matched=True;commit(db);return serialize(s)
@app.get('/api/v1/packages/by-package-id/{package_id}')
def package_by_id(package_id:str,db:Session=Depends(get_db)):
    p=db.scalar(select(Package).where(Package.package_id==package_id));
    if not p:raise HTTPException(404,'Package not found')
    return package_detail(p,db)
@app.get('/api/v1/packages/{package_uuid}')
def package(package_uuid:uuid.UUID,db:Session=Depends(get_db)):return package_detail(one(db,Package,package_uuid),db)
def package_detail(p,db):
    s=one(db,Shipment,p.shipment_id);return serialize(p,{'shipment':serialize(s),'company':serialize(s.company) if s.company else None})
@app.patch('/api/v1/packages/{package_uuid}')
def patch_package(package_uuid:uuid.UUID,body:dict,db:Session=Depends(get_db)):
    p=one(db,Package,package_uuid);allowed={c.name for c in Package.__table__.columns}-{'id','shipment_id','package_id','created_at','updated_at'}
    for k,v in body.items():
        if k in allowed:setattr(p,k,v)
    commit(db);return serialize(p)

COMPANY_FIELDS=['ICRIS Number','Company Name']
COMPANY_MASTER_MIME={'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream','application/zip'}
async def read_company_workbook(file:UploadFile):
    if Path(file.filename or '').suffix.casefold()!='.xlsx':raise HTTPException(415,'Company master must be an .xlsx workbook')
    if file.content_type and file.content_type not in COMPANY_MASTER_MIME:raise HTTPException(415,'Unsupported company-master content type')
    data=await file.read(settings.max_company_import_mb*1024*1024+1)
    if len(data)>settings.max_company_import_mb*1024*1024:raise HTTPException(413,'Company import exceeds configured upload limit')
    return data
def company_mapping(value:str|None):
    if not value:return None
    try:
        import json
        parsed=json.loads(value)
    except Exception as exc:raise HTTPException(422,'Mapping must be valid JSON') from exc
    if not isinstance(parsed,dict):raise HTTPException(422,'Mapping must be an object')
    return parsed
@app.post('/api/v1/company-imports/preview')
async def company_preview(file:UploadFile=File(...),worksheet:str|None=Form(None),mapping_json:str|None=Form(None),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    data=await read_company_workbook(file)
    try:return analyze_company_workbook(db,parse_workbook(data,file.filename or 'upload.xlsx',worksheet,company_mapping(mapping_json)))
    except CompanyWorkbookError as exc:raise HTTPException(422,str(exc)) from exc
@app.post('/api/v1/company-imports',status_code=201)
async def company_import(file:UploadFile=File(...),mapping_json:str=Form(...),worksheet:str|None=Form(None),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    data=await read_company_workbook(file);mapping=company_mapping(mapping_json)
    try:
        batch=import_companies(db,data,file.filename or 'upload.xlsx',worksheet,mapping);db.commit();db.refresh(batch)
    except CompanyWorkbookError as exc:db.rollback();raise HTTPException(422,str(exc)) from exc
    except Exception:db.rollback();log.exception('Company master import rolled back');raise
    return serialize(batch,{'companies_created':batch.created_count,'companies_updated':batch.updated_count,'provisional_companies_promoted':batch.promoted_count,'aliases_added':batch.alias_added_count,'unchanged_records':batch.unchanged_count,'conflicts_recorded':batch.conflict_count,'rejected_rows':batch.rejected_count,'total_processed':batch.total_rows})
@app.get('/api/v1/company-imports')
def company_batches(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [serialize(x) for x in db.scalars(select(CompanyImportBatch).order_by(CompanyImportBatch.created_at.desc())).all()]
@app.get('/api/v1/company-imports/{batch_id}')
def company_batch(batch_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return serialize(one(db,CompanyImportBatch,batch_id))
@app.get('/api/v1/company-imports/{batch_id}/rows')
def company_rows(batch_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [serialize(x) for x in db.scalars(select(CompanyImportRawRow).where(CompanyImportRawRow.import_batch_id==batch_id)).all()]

ALLOWED_EXT={'.pdf','.doc','.docx','.xls','.xlsx','.csv','.txt','.png','.jpg','.jpeg'}
CATEGORIES={'company_registration','pan_vat','kyc','contract','rate_sheet','invoice','correspondence','operations','other'}

def optimize_image_bytes(data: bytes, ext: str) -> tuple[bytes, bool]:
    """Compresses PNG/JPG images if resizing/quality optimization saves space."""
    if ext not in {'.png', '.jpg', '.jpeg'}:
        return data, False
    try:
        from PIL import Image, ImageOps
        import io
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        orig_w, orig_h = img.size
        max_dim = 2000
        if orig_w > max_dim or orig_h > max_dim:
            img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
        
        buf = io.BytesIO()
        if ext in {'.jpg', '.jpeg'}:
            if img.mode in ('RGBA', 'P', 'LA'):
                img = img.convert('RGB')
            img.save(buf, format='JPEG', quality=85, optimize=True)
        else:
            if img.mode == 'P':
                img = img.convert('RGBA')
            img.save(buf, format='PNG', optimize=True)
        
        compressed = buf.getvalue()
        if len(compressed) < len(data):
            return compressed, True
    except Exception:
        pass
    return data, False

async def store_document(file:UploadFile,company_id:uuid.UUID,document_id:uuid.UUID,db:Session|None=None):
    original=Path(file.filename or 'document').name;ext=Path(original).suffix.lower()
    if ext not in ALLOWED_EXT:raise HTTPException(415,'Unsupported or dangerous document type')
    data=await file.read(settings.max_document_upload_mb*1024*1024+1)
    if len(data)>settings.max_document_upload_mb*1024*1024:raise HTTPException(413,'Document exceeds configured upload limit')
    
    # Compress image if applicable
    data, compressed = optimize_image_bytes(data, ext)
    checksum = hashlib.sha256(data).hexdigest()

    # SHA256 Deduplication check: if identical active file exists for this company, reuse path to save disk!
    if db is not None:
        existing_dup = db.scalar(select(CompanyDocument).where(
            CompanyDocument.company_id == company_id,
            CompanyDocument.checksum_sha256 == checksum,
            CompanyDocument.status == 'active'
        ))
        if existing_dup:
            return original, existing_dup.stored_file_name, existing_dup.relative_storage_path, data, ext, checksum, True

    safe=re.sub(r'[^A-Za-z0-9._-]+','_',original).strip('._') or f'document{ext}';stored=f'{document_id}-{safe}'
    relative=f'{company_id}/{stored}';path=(Path(settings.document_storage_root)/relative).resolve();root=Path(settings.document_storage_root).resolve()
    if root not in path.parents:raise HTTPException(422,'Invalid storage path')
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    return original,stored,relative,data,ext,checksum,False

@app.get('/api/v1/companies/{company_id}/documents')
def documents(company_id:uuid.UUID,q:str|None=None,category:str|None=None,status:str|None=None,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    scoped_company(db,company_id,ae_scope)
    stmt=select(CompanyDocument).where(CompanyDocument.company_id==company_id)
    if q:stmt=stmt.where(or_(CompanyDocument.title.ilike(f'%{q}%'),CompanyDocument.original_file_name.ilike(f'%{q}%')))
    if category:stmt=stmt.where(CompanyDocument.category==category)
    if status:stmt=stmt.where(CompanyDocument.status==status)
    else:stmt=stmt.where(CompanyDocument.status=='active')
    return [serialize(x) for x in db.scalars(stmt.order_by(CompanyDocument.uploaded_at.desc())).all()]

@app.get('/api/v1/companies/{company_id}/storage-stats')
def company_storage_stats(company_id:uuid.UUID,db:Session=Depends(get_db)):
    docs = db.scalars(select(CompanyDocument).where(CompanyDocument.company_id==company_id, CompanyDocument.status=='active')).all()
    total_bytes = sum(d.file_size_bytes for d in docs)
    cat_counts: dict[str, dict[str, int]] = {}
    ext_counts: dict[str, dict[str, int]] = {}
    for d in docs:
        c = d.category or 'other'
        cat_counts[c] = cat_counts.get(c, {'count': 0, 'bytes': 0})
        cat_counts[c]['count'] += 1
        cat_counts[c]['bytes'] += d.file_size_bytes
        
        e = d.file_extension or 'other'
        ext_counts[e] = ext_counts.get(e, {'count': 0, 'bytes': 0})
        ext_counts[e]['count'] += 1
        ext_counts[e]['bytes'] += d.file_size_bytes

    return {
        'total_documents': len(docs),
        'total_size_bytes': total_bytes,
        'by_category': cat_counts,
        'by_extension': ext_counts,
    }

@app.post('/api/v1/companies/{company_id}/documents',status_code=201)
async def upload_document(company_id:uuid.UUID,file:UploadFile=File(...),title:str=Form(...),category:str=Form('other'),description:str|None=Form(None),tags:str=Form(''),document_date:date|None=Form(None),db:Session=Depends(get_db)):
    one(db,Company,company_id)
    if category not in CATEGORIES:raise HTTPException(422,'Invalid document category')
    did=uuid.uuid4();original,stored,relative,data,ext,checksum,is_dup=await store_document(file,company_id,did,db)
    tag_list = [x.strip() for x in tags.split(',') if x.strip()]
    if is_dup:
        tag_list.append('deduplicated')

    d=CompanyDocument(
        id=did,company_id=company_id,title=title.strip(),
        original_file_name=original,stored_file_name=stored,
        relative_storage_path=relative,
        mime_type=file.content_type or mimetypes.guess_type(original)[0] or 'application/octet-stream',
        file_extension=ext,file_size_bytes=len(data),
        category=category,description=description,
        tags=tag_list,
        document_date=document_date,
        checksum_sha256=checksum
    )
    db.add(d);commit(db);
    res = serialize(d)
    res['is_deduplicated'] = is_dup
    return res

@app.get('/api/v1/documents/{document_id}')
def document(document_id:uuid.UUID,db:Session=Depends(get_db)):return serialize(one(db,CompanyDocument,document_id))
def document_file(d):
    path=(Path(settings.document_storage_root)/d.relative_storage_path).resolve();root=Path(settings.document_storage_root).resolve()
    if root not in path.parents or not path.is_file():raise HTTPException(404,'Document file not found')
    return path
@app.get('/api/v1/documents/{document_id}/content')
def document_content(document_id:uuid.UUID,db:Session=Depends(get_db)):
    d=one(db,CompanyDocument,document_id)
    if not (d.mime_type=='application/pdf' or d.mime_type.startswith('image/')):raise HTTPException(415,'Browser preview is available for PDF and images only')
    return FileResponse(document_file(d),media_type=d.mime_type,headers={'Content-Disposition':f'inline; filename="{d.original_file_name}"','X-Content-Type-Options':'nosniff'})
@app.get('/api/v1/documents/{document_id}/download')
def document_download(document_id:uuid.UUID,db:Session=Depends(get_db)):
    d=one(db,CompanyDocument,document_id);return FileResponse(document_file(d),media_type='application/octet-stream',filename=d.original_file_name,headers={'X-Content-Type-Options':'nosniff'})
@app.patch('/api/v1/documents/{document_id}')
def patch_document(document_id:uuid.UUID,body:dict,db:Session=Depends(get_db)):
    d=one(db,CompanyDocument,document_id)
    for k in {'title','category','description','tags','document_date','status'}:
        if k in body:setattr(d,k,body[k])
    commit(db);return serialize(d)
@app.post('/api/v1/documents/{document_id}/archive')
def archive_document(document_id:uuid.UUID,db:Session=Depends(get_db)):d=one(db,CompanyDocument,document_id);d.status='archived';commit(db);return serialize(d)
@app.delete('/api/v1/documents/{document_id}')
def delete_document(document_id:uuid.UUID,db:Session=Depends(get_db)):d=one(db,CompanyDocument,document_id);d.status='archived';commit(db);return {'status':'success','message':'Document archived successfully','id':str(d.id)}
@app.post('/api/v1/documents/{document_id}/replace',status_code=201)
async def replace_document(document_id:uuid.UUID,file:UploadFile=File(...),db:Session=Depends(get_db)):
    old=one(db,CompanyDocument,document_id);did=uuid.uuid4();original,stored,relative,data,ext,checksum,is_dup=await store_document(file,old.company_id,did,db);old.status='archived'
    d=CompanyDocument(id=did,company_id=old.company_id,title=old.title,original_file_name=original,stored_file_name=stored,relative_storage_path=relative,mime_type=file.content_type or mimetypes.guess_type(original)[0] or 'application/octet-stream',file_extension=ext,file_size_bytes=len(data),category=old.category,description=old.description,tags=old.tags,document_date=old.document_date,version_number=old.version_number+1,status='active',checksum_sha256=checksum,replaces_document_id=old.id);db.add(d);commit(db);return serialize(d)

@app.get('/api/v1/matching-review')
def matching_review(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [serialize(s) for s in db.scalars(select(Shipment).where(Shipment.match_status.in_(['suggested','unmatched'])).order_by(Shipment.created_at.desc())).all()]
@app.get('/api/v1/matching-review/{shipment_id}')
def matching_detail(shipment_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return shipment(shipment_id,db)
@app.post('/api/v1/matching-review/{shipment_id}/link')
def matching_link(shipment_id:uuid.UUID,body:LinkIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return link(shipment_id,body,db)
@app.post('/api/v1/matching-review/{shipment_id}/reject-suggestion')
def reject_match(shipment_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):s=one(db,Shipment,shipment_id);s.company_id=None;s.match_status='unmatched';s.match_confidence=None;s.matched_by_method='none';s.manually_matched=True;commit(db);return serialize(s)

@app.get('/api/v1/search')
def search(q:str=Query(min_length=1),limit:int=Query(20,le=100),db:Session=Depends(get_db)):
    q_trim=q.strip();q_icris=normalize_icris(q);norm=normalize_name(q);like=f'%{escape_like(q_trim)}%';results=[]

    # Companies — an exact ICRIS match (case-insensitive, trimmed, unicode-normalized) always wins rank 1,
    # matching the same identity rule crm_sync.exact_company enforces for CRM matching.
    # Archived companies (soft-deleted, or a merge source per docs/03-data-rules.md rule 11)
    # must not resurface here -- they still exist as rows precisely so a merged-in shipment
    # has somewhere to point, not so a user can find and open them from search.
    cs=db.scalars(select(Company).where(Company.status!='archived',or_(Company.icris_number.ilike(like,escape='\\'),Company.company_name.ilike(like,escape='\\'),Company.legal_name.ilike(like,escape='\\'))).limit(limit)).all()
    if q_icris:
        exact=db.scalar(select(Company).where(Company.status!='archived',func.upper(func.trim(Company.icris_number))==q_icris))
        if exact and exact not in cs: cs=[exact,*cs]
    def _add_c(c, rk):
        if any(x['id']==c.id for x in results): return
        sc=db.scalar(select(func.count(Shipment.id)).where(Shipment.company_id==c.id))
        ld=db.scalar(select(Shipment.import_country).where(Shipment.company_id==c.id).order_by(Shipment.shipment_date.desc().nullslast()).limit(1))
        ls=db.scalar(select(Shipment.shipment_date).where(Shipment.company_id==c.id).order_by(Shipment.shipment_date.desc().nullslast()).limit(1))
        results.append({
            'result_type':'company', 'id':c.id, 'title':c.company_name, 'subtitle':c.icris_number, 'url':f'/customers/{c.id}', 'rank':rk,
            'metadata': { 'icris_number': c.icris_number, 'shipment_count': sc or 0, 'last_shipment_date': str(ls) if ls else None, 'status': 'Active' if sc else 'New', 'destination': ld or 'Unknown' }
        })
    for c in cs: _add_c(c, 1 if q_icris and normalize_icris(c.icris_number)==q_icris else 4 if c.normalized_name==norm else 7)
    als=db.execute(select(CompanyAlias,Company).join(Company).where(Company.status!='archived',CompanyAlias.alias_name.ilike(like,escape='\\')).limit(limit)).all()
    for a,c in als: _add_c(c, 5 if a.normalized_alias_name==norm else 7)

    # Shipments
    ss=db.scalars(select(Shipment).options(selectinload(Shipment.company)).where(or_(Shipment.shipment_number.ilike(like,escape='\\'),Shipment.source_icris_number.ilike(like,escape='\\'),Shipment.shipper_name.ilike(like,escape='\\'),Shipment.source_customer_name.ilike(like,escape='\\'),Shipment.importer_name.ilike(like,escape='\\'),Shipment.importer_telephone.ilike(like,escape='\\'),Shipment.goods_description.ilike(like,escape='\\'))).limit(limit)).all()
    for s in ss:
        results.append({
            'result_type':'shipment', 'id':s.id, 'title':s.shipment_number, 'subtitle':f"{s.company.company_name if s.company else (s.shipper_name or '')} · {s.shipment_date or 'No date'}", 'url':f'/awb?shipment={s.id}', 'rank':2 if s.shipment_number.casefold()==q_trim.casefold() else 6 if q_icris and normalize_icris(s.source_icris_number)==q_icris else 8,
            'metadata': { 'shipment_number': s.shipment_number, 'company': s.company.company_name if s.company else (s.shipper_name or ''), 'date': str(s.shipment_date) if s.shipment_date else None, 'destination': s.import_country or 'Unknown', 'pieces': s.pieces or 0, 'weight': float(s.shipment_weight or s.actual_weight or 0), 'bill_type': s.bill_type or 'Unknown', 'status': s.match_status }
        })

    # Packages
    ps=db.execute(select(Package,Shipment).join(Shipment).where(Package.package_id.ilike(like,escape='\\')).limit(limit)).all()
    for p,s in ps:
        results.append({
            'result_type':'package', 'id':p.id, 'title':p.package_id, 'subtitle':f'AWB {s.shipment_number}', 'url':f'/awb?shipment={s.id}', 'rank':3 if p.package_id.casefold()==q_trim.casefold() else 9,
            'metadata': { 'package_id': p.package_id, 'shipment_number': s.shipment_number, 'weight': float(p.package_weight) if p.package_weight else 0, 'destination': s.import_country or 'Unknown', 'status': p.package_status or 'In Transit' }
        })

    # Documents — archived documents are hidden in the Documents tab UI, so surfacing them
    # here would land the user on a tab that appears to have nothing in it.
    ds=db.scalars(select(CompanyDocument).options(selectinload(CompanyDocument.company)).where(CompanyDocument.status!='archived',or_(CompanyDocument.title.ilike(like,escape='\\'),CompanyDocument.original_file_name.ilike(like,escape='\\'),CompanyDocument.category.ilike(like,escape='\\'),CompanyDocument.tags.cast(String).ilike(like,escape='\\'))).limit(limit)).all()
    for d in ds:
        results.append({
            'result_type':'document', 'id':d.id, 'title':d.title, 'subtitle':d.original_file_name, 'url':f'/customers/{d.company_id}?tab=documents', 'rank':11,
            'metadata': { 'document_name': d.title, 'customer': d.company.company_name if d.company else 'Unknown', 'document_type': d.category, 'upload_date': str(d.uploaded_at.date()) if d.uploaded_at else None, 'file_size': d.file_size_bytes }
        })

    # MAWBs
    ms=db.scalars(select(MasterAirWaybill).where(or_(MasterAirWaybill.mawb_number.ilike(like,escape='\\'),MasterAirWaybill.flight_number.ilike(like,escape='\\'),MasterAirWaybill.origin.ilike(like,escape='\\'),MasterAirWaybill.destination.ilike(like,escape='\\'))).limit(limit)).all()
    for m in ms:
        sc = db.scalar(select(func.count(Shipment.id)).where(Shipment.mawb_id==m.id))
        results.append({
            'result_type':'mawb', 'id':m.id, 'title':m.mawb_number, 'subtitle':f'{m.manifest_date} · {m.flight_number or "No Flight"}', 'url':f'/mawb?mawb={m.id}', 'rank':4 if m.mawb_number.casefold()==q_trim.casefold() else 10,
            'metadata': { 'mawb_number': m.mawb_number, 'airline': m.origin or 'Unknown', 'flight': m.flight_number or 'Unknown', 'shipment_count': sc or 0, 'total_weight': float(m.pp_weight or 0) + float(m.fc_weight or 0) + float(m.fd_weight or 0) }
        })

    results.sort(key=lambda x:x['rank']); return {'query':q,'items':results[:limit]}

def rows(db,sql,args=None):return [dict(x) for x in db.execute(text(sql),args or {}).mappings()]
@app.get('/api/v1/analytics/overview')
def overview(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):
    sql = """
WITH company_shipments AS (
    SELECT company_id, 
           MAX(shipment_date) FILTER (WHERE shipment_date >= date_trunc('month', CURRENT_DATE)) AS current_month_shipment,
           MAX(shipment_date) FILTER (WHERE shipment_date < date_trunc('month', CURRENT_DATE)) AS previous_shipment,
           MAX(shipment_date) FILTER (WHERE shipment_date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND shipment_date < date_trunc('month', CURRENT_DATE)) AS last_month_shipment,
           MAX(shipment_date) FILTER (WHERE shipment_date < date_trunc('month', CURRENT_DATE - INTERVAL '1 month')) AS previous_shipment_before_last_month
    FROM shipments 
    WHERE company_id IS NOT NULL 
    GROUP BY company_id
)
SELECT 
    (SELECT count(*) FROM companies) AS total_companies,
    (SELECT count(*) FROM companies WHERE status='active') AS active_companies,
    (SELECT count(*) FROM shipments) AS total_shipments,
    (SELECT count(*) FROM packages) AS total_packages,
    (SELECT count(*) FROM shipments WHERE company_id IS NOT NULL) AS matched_shipments,
    (SELECT count(*) FROM shipments WHERE match_status='suggested') AS suggested_shipments,
    (SELECT count(*) FROM shipments WHERE company_id IS NULL) AS unmatched_shipments,
    (SELECT count(*) FROM manifest_import_batches) AS manifest_batches,
    (SELECT count(*) FROM company_documents WHERE status='active') AS active_documents,
    coalesce(round(100.0*(SELECT count(*) FROM shipments WHERE shipment_date IS NOT NULL)/nullif((SELECT count(*) FROM shipments),0),2),0) AS shipment_date_coverage,
    coalesce(round(100.0*(SELECT count(*) FROM shipments WHERE company_id IS NOT NULL)/nullif((SELECT count(*) FROM shipments),0),2),0) AS company_match_rate,
    (SELECT count(*) FROM data_quality_issues WHERE status IN ('open','reviewed','acknowledged')) AS open_quality_issues,
    (SELECT count(*) FROM companies WHERE is_provisional) AS provisional_companies,
    (SELECT max(last_synced_at) FROM master_air_waybills) AS last_crm_sync,
    (SELECT count(*) FROM company_shipments WHERE current_month_shipment IS NOT NULL AND (previous_shipment IS NULL OR previous_shipment < current_month_shipment - INTERVAL '6 months')) AS reactivated_this_month,
    (SELECT count(*) FROM company_shipments WHERE last_month_shipment IS NOT NULL AND (previous_shipment_before_last_month IS NULL OR previous_shipment_before_last_month < last_month_shipment - INTERVAL '6 months')) AS reactivated_last_month
    """
    return dict(db.execute(text(sql)).mappings().one())
@app.get('/api/v1/analytics/dashboard')
def analytics_dashboard(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):
    return {
        'overview':dict(overview(db)),
        'shipment_trend':rows(db,"SELECT to_char(m.manifest_date,'YYYY-MM-DD') period,count(s.id)::int shipments,coalesce(sum(s.pieces),0)::int pieces FROM master_air_waybills m LEFT JOIN shipments s ON s.mawb_id=m.id GROUP BY m.manifest_date ORDER BY m.manifest_date DESC LIMIT 30")[::-1],
        'top_customers':rows(db,'SELECT company_id,company_name,icris_number,shipment_count,package_count,document_count,last_shipment_date FROM vw_company_operational_summary WHERE shipment_count>0 ORDER BY shipment_count DESC,company_name LIMIT 10'),
        'destinations':rows(db,"SELECT coalesce(nullif(import_country,''),'Not supplied') name,count(*)::int value FROM shipments GROUP BY import_country ORDER BY value DESC LIMIT 8"),
        'bill_types':rows(db,"SELECT coalesce(nullif(bill_type,''),'Not supplied') name,count(*)::int value FROM shipments GROUP BY bill_type ORDER BY value DESC"),
        'quality_issues':rows(db,"SELECT issue_type name,count(*)::int value FROM data_quality_issues WHERE status IN ('open','reviewed','acknowledged') GROUP BY issue_type ORDER BY value DESC LIMIT 8"),
        'match_status':rows(db,"SELECT CASE WHEN company_id IS NOT NULL THEN 'Linked' ELSE 'Unlinked' END name,count(*)::int value FROM shipments GROUP BY 1 ORDER BY 1"),
        'recent_mawbs':rows(db,'SELECT id,mawb_number,manifest_date,flight_number,origin,destination,last_synced_at FROM master_air_waybills ORDER BY manifest_date DESC,last_synced_at DESC LIMIT 8'),
    }
@app.get('/api/v1/analytics/customers')
def analytics_customers(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT v.* FROM vw_company_operational_summary v JOIN companies c ON c.id=v.company_id WHERE (c.is_provisional=false OR v.shipment_count>0) ORDER BY v.shipment_count DESC, v.company_name')
@app.get('/api/v1/analytics/destinations')
def destinations(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT * FROM vw_destination_summary ORDER BY shipment_count DESC')
@app.get('/api/v1/analytics/bill-types')
def bill_types(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT bill_type,count(*)::int shipment_count FROM shipments GROUP BY bill_type ORDER BY shipment_count DESC')
@app.get('/api/v1/analytics/values-by-currency')
def values_by_currency(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT company_id,value_currency currency,sum(declared_value) total_value FROM shipments WHERE declared_value IS NOT NULL GROUP BY company_id,value_currency ORDER BY total_value DESC')
@app.get('/api/v1/analytics/weights-by-unit')
def weights_by_unit(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT company_id,weight_unit,sum(shipment_weight) total_weight FROM shipments WHERE shipment_weight IS NOT NULL GROUP BY company_id,weight_unit ORDER BY total_weight DESC')
@app.get('/api/v1/analytics/import-quality')
def import_quality(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT * FROM vw_manifest_import_quality ORDER BY imported_at DESC')
@app.get('/api/v1/analytics/document-completeness')
def completeness(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return rows(db,'SELECT * FROM vw_company_document_summary ORDER BY active_document_count DESC,company_name')
@app.get('/api/v1/analytics/data-quality')
def data_quality(db:Session=Depends(get_db),_user:User=Depends(get_current_user)):return {'shipment_date_coverage':overview(db)['shipment_date_coverage'],'match_status':rows(db,'SELECT match_status,count(*)::int count FROM shipments GROUP BY match_status')}
EXPORTS={'customers':'SELECT * FROM vw_company_operational_summary ORDER BY company_name','destinations':'SELECT * FROM vw_destination_summary ORDER BY shipment_count DESC','import-quality':'SELECT * FROM vw_manifest_import_quality ORDER BY imported_at DESC','document-completeness':'SELECT * FROM vw_company_document_summary ORDER BY company_name'}
@app.get('/api/v1/analytics/{report}/export.csv')
def export_csv(report:str,db:Session=Depends(get_db),_user:User=Depends(get_current_user)):
    if report not in EXPORTS:raise HTTPException(404,'Export not found')
    data=rows(db,EXPORTS[report]);out=io.StringIO();writer=csv.DictWriter(out,fieldnames=list(data[0]) if data else ['no_data']);writer.writeheader();writer.writerows(data)
    return StreamingResponse(iter([out.getvalue()]),media_type='text/csv',headers={'Content-Disposition':f'attachment; filename="{report}.csv"'})

def get_timeframe_bounds(tf:str,d_from:date|None=None,d_to:date|None=None,y_from:int|None=None,y_to:int|None=None,compare_mode:str='pop'):
    import calendar
    from datetime import date as _date,timedelta
    today=_date.today()
    
    if tf=='today':
        c_start,c_end=today,today
    elif tf=='yesterday':
        c_start,c_end=today-timedelta(days=1),today-timedelta(days=1)
    elif tf=='last_7_days':
        c_start,c_end=today-timedelta(days=6),today
    elif tf=='last_30_days':
        c_start,c_end=today-timedelta(days=29),today
    elif tf=='last_90_days':
        c_start,c_end=today-timedelta(days=89),today
    elif tf=='this_week':
        days_since_sun=(today.weekday()+1)%7
        c_start=today-timedelta(days=days_since_sun)
        c_end=c_start+timedelta(days=6)
    elif tf=='last_week':
        days_since_sun=(today.weekday()+1)%7
        this_sun=today-timedelta(days=days_since_sun)
        c_start=this_sun-timedelta(days=7)
        c_end=this_sun-timedelta(days=1)
    elif tf=='this_month':
        c_start=today.replace(day=1)
        last_day=calendar.monthrange(today.year,today.month)[1]
        c_end=today.replace(day=last_day)
    elif tf=='last_month':
        first_of_this=today.replace(day=1)
        p_end=first_of_this-timedelta(days=1)
        c_start=p_end.replace(day=1)
        c_end=p_end
    elif tf=='this_quarter':
        q_m=((today.month-1)//3)*3+1
        c_start=today.replace(month=q_m,day=1)
        q_end_m=q_m+2
        last_day=calendar.monthrange(today.year,q_end_m)[1]
        c_end=today.replace(month=q_end_m,day=last_day)
    elif tf=='last_quarter':
        q_m=((today.month-1)//3)*3+1
        this_q_start=today.replace(month=q_m,day=1)
        p_end=this_q_start-timedelta(days=1)
        prev_q_m=((p_end.month-1)//3)*3+1
        c_start=p_end.replace(month=prev_q_m,day=1)
        c_end=p_end
    elif tf=='this_year':
        c_start=today.replace(month=1,day=1)
        c_end=today.replace(month=12,day=31)
    elif tf=='last_year':
        c_start=_date(today.year-1,1,1)
        c_end=_date(today.year-1,12,31)
    elif tf=='fiscal_year':
        if today.month >= 7:
            c_start=_date(today.year,7,1)
            c_end=_date(today.year+1,6,30)
        else:
            c_start=_date(today.year-1,7,1)
            c_end=_date(today.year,6,30)
    elif tf=='ytd':
        c_start=today.replace(month=1,day=1)
        c_end=today
    elif tf=='qtd':
        q_m=((today.month-1)//3)*3+1
        c_start=today.replace(month=q_m,day=1)
        c_end=today
    elif tf=='mtd':
        c_start=today.replace(day=1)
        c_end=today
    elif tf.startswith('year_') or (tf.isdigit() and len(tf) == 4):
        yr = int(tf.replace('year_', ''))
        c_start = _date(yr, 1, 1)
        c_end = _date(yr, 12, 31)
    elif tf=='year_range' and y_from and y_to:
        c_start,c_end=_date(y_from,1,1),_date(y_to,12,31)
    elif (tf=='custom' or tf=='custom_range') and d_from and d_to:
        c_start,c_end=d_from,d_to
    elif tf=='all_time':
        c_start,c_end=_date(2000,1,1),today
    else:
        # Unrecognised timeframe. Fall back to 30 days so nothing breaks, but log it loudly —
        # this silently made '7d'/'30d'/'90d' return identical data for a long time.
        log.warning('Unrecognised timeframe %r; defaulting to last 30 days', tf)
        c_start=today-timedelta(days=29)
        c_end=today

    if compare_mode == 'yoy':
        try: p_start = c_start.replace(year=c_start.year - 1)
        except ValueError: p_start = c_start - timedelta(days=365)
        try: p_end = c_end.replace(year=c_end.year - 1)
        except ValueError: p_end = c_end - timedelta(days=365)
    else:
        span_days = (c_end - c_start).days + 1
        p_end = c_start - timedelta(days=1)
        p_start = p_end - timedelta(days=max(0, span_days - 1))

    return c_start,c_end,p_start,p_end

def calc_pop(cur:float|int,prev:float|int)->float:
    if not prev:return 100.0 if cur else 0.0
    return round(float((cur-prev)/prev*100.0),1)

# Customer health buckets, in days since the customer's TRUE last shipment (all-time,
# NOT merely the latest one inside the selected window). Aligned with compute_inactivity's
# dormancy threshold so the whole app agrees on what "dormant" means.
AE_HEALTH_ACTIVE_DAYS = 30
AE_HEALTH_WARNING_DAYS = 90
# A customer counts as reactivated when they shipped in the current period after a gap of
# at least this long. Matches the definition used by /analytics/executive-dashboard.
AE_REACTIVATION_GAP_MONTHS = 6
# The real segment values in `companies.customer_type`. Anything else falls into 'Unclassified'.
# Full rule for how a company lands in one of these: docs/customer-segmentation-rules.md.
AE_SEGMENTS = ('Key Account', 'Reseller', 'Large Account', 'SME', 'Small Customer')

@app.get('/api/v1/analytics/top-customers')
def top_customers(
    timeframe:str=Query('this_quarter'),
    date_from:date|None=None,
    date_to:date|None=None,
    metric:Literal['revenue','shipments','weight']='revenue',
    limit:int=Query(10,le=2000),
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,None,None,'pop')
    ae_filter_sql=' AND c.assigned_ae_code = :ae_scope' if ae_scope else ''
    period_sql=f"""
        SELECT s.company_id, c.company_name, c.icris_number, c.customer_type AS segment,
               SUM({REVENUE_AMOUNT_SQL})::float AS revenue,
               COUNT(s.id)::int AS shipments,
               SUM(COALESCE(s.shipment_weight, s.actual_weight, 0))::float AS weight
        FROM shipments s
        JOIN companies c ON c.id = s.company_id
        WHERE s.company_id IS NOT NULL AND s.shipment_date IS NOT NULL AND s.shipment_date >= :start AND s.shipment_date <= :end
        {ae_filter_sql}
        GROUP BY 1,2,3,4
    """
    cur_rows=rows(db,period_sql,{'start':c_start,'end':c_end,**({'ae_scope':ae_scope} if ae_scope else {})})
    prev_by_company={r['company_id']:r[metric] for r in rows(db,period_sql,{'start':p_start,'end':p_end,**({'ae_scope':ae_scope} if ae_scope else {})})}
    ranked=sorted(cur_rows,key=lambda r:r[metric],reverse=True)[:limit]
    out=[]
    for rank,r in enumerate(ranked,1):
        prev_value=prev_by_company.get(r['company_id'],0)
        out.append({'rank':rank,'company_id':str(r['company_id']),'company_name':r['company_name'],'icris_number':r['icris_number'],
                     'segment':r['segment'],'revenue':round(r['revenue'],2),'shipments':r['shipments'],'weight':round(r['weight'],2),
                     'pct_growth':calc_pop(r[metric],prev_value)})
    return {'metric':metric,'bounds':{'c_start':c_start,'c_end':c_end,'p_start':p_start,'p_end':p_end},'items':out}
@app.get('/api/v1/analytics/customer-profitability')
def customer_profitability(
    timeframe:str|None=None,
    date_from:date|None=None,
    date_to:date|None=None,
    sort:Literal['profit','margin','bill','loss']='profit',
    limit:int=Query(15,le=100),
    db:Session=Depends(get_db),
    _user:User=Depends(require_role(['admin','sales_lead']))
):
    """Per-customer UPS profitability, from the per-shipment P&L grid (S_MenifestPrevUPS).

    Only shipments that carry a UPS cost contribute to profit/margin — a shipment billed but
    not yet costed by UPS has a real bill amount and an unknown cost, so folding it in as
    zero-cost would overstate margin. Those are reported separately as `awaiting_cost_*`.

    Accepts the same `timeframe` presets as the rest of the analytics suite (via
    get_timeframe_bounds) so the Profitability page can share the one DateRangeControl UI
    instead of its own bespoke date pair. Explicit `date_from`/`date_to` still win when given
    directly (used by the sync action, which always needs a literal range).
    """
    bounds=None
    if timeframe and timeframe!='custom':
        c_start,c_end,_,_=get_timeframe_bounds(timeframe)
        date_from=date_from or c_start;date_to=date_to or c_end
        bounds={'c_start':str(c_start),'c_end':str(c_end)}
    order={'profit':'profit_loss DESC','margin':'margin_percent DESC NULLS LAST','bill':'bill_amount DESC','loss':'profit_loss ASC'}[sort]
    # "Worst" (loss ASC) is the one sort where a customer with nothing costed yet (bill_amount
    # 0, profit_loss coalesced to 0) would otherwise rank as if $0 were a real loss — it isn't
    # a loss, it's no data. Excluded from that view specifically; the other sorts already put
    # them where they belong (bottom of margin/profit, since NULL/0 never outranks a real number).
    having='HAVING coalesce(sum(scoped.pnl_bill_amount) FILTER (WHERE scoped.pnl_ups_bill_amount IS NOT NULL),0) > 0' if sort=='loss' else ''
    rows_out=rows(db,f"""
        WITH scoped AS (
            SELECT s.company_id, s.pnl_bill_amount, s.pnl_ups_bill_amount, s.pnl_profit_loss
            FROM shipments s
            WHERE s.pnl_synced_at IS NOT NULL AND s.company_id IS NOT NULL
              AND (CAST(:date_from AS date) IS NULL OR s.shipment_date >= CAST(:date_from AS date))
              AND (CAST(:date_to   AS date) IS NULL OR s.shipment_date <= CAST(:date_to   AS date))
        )
        SELECT c.id::text AS company_id, c.company_name, c.icris_number, c.customer_type AS segment,
               count(*)::int AS shipments,
               count(*) FILTER (WHERE scoped.pnl_ups_bill_amount IS NULL)::int AS awaiting_cost_shipments,
               coalesce(sum(scoped.pnl_bill_amount) FILTER (WHERE scoped.pnl_ups_bill_amount IS NULL),0)::float AS awaiting_cost_bill,
               coalesce(sum(scoped.pnl_bill_amount) FILTER (WHERE scoped.pnl_ups_bill_amount IS NOT NULL),0)::float AS bill_amount,
               coalesce(sum(scoped.pnl_ups_bill_amount),0)::float AS ups_bill_amount,
               coalesce(sum(scoped.pnl_profit_loss),0)::float AS profit_loss,
               CASE WHEN coalesce(sum(scoped.pnl_bill_amount) FILTER (WHERE scoped.pnl_ups_bill_amount IS NOT NULL),0) > 0
                    THEN round((sum(scoped.pnl_profit_loss) / sum(scoped.pnl_bill_amount) FILTER (WHERE scoped.pnl_ups_bill_amount IS NOT NULL) * 100)::numeric, 1)
                    ELSE NULL END::float AS margin_percent
        FROM scoped JOIN companies c ON c.id = scoped.company_id
        GROUP BY c.id, c.company_name, c.icris_number, c.customer_type
        {having}
        ORDER BY {order}
        LIMIT :limit
    """,{'date_from':date_from,'date_to':date_to,'limit':limit})
    return {'sort':sort,'bounds':bounds,'date_from':date_from,'date_to':date_to,'items':rows_out}
@app.get('/api/v1/analytics/ae-performance')
def ae_performance(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    ae_code:str|None=None,
    segment:str|None=None,
    country:str|None=None,
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    from datetime import date as _date, timedelta as _timedelta
    if ae_scope:ae_code=ae_scope
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)

    where_extra=''; extra={}
    if country: where_extra+=" AND LOWER(COALESCE(s.import_country,'')) = LOWER(:country)"; extra['country']=country
    if segment: where_extra+=" AND LOWER(COALESCE(c.customer_type,'')) = LOWER(:segment)"; extra['segment']=segment

    period_sql=f"""
        SELECT COALESCE(NULLIF(TRIM(s.ae_code), ''), 'UNASSIGNED') AS ae,
               s.company_id, c.company_name, c.icris_number, c.customer_type AS segment,
               SUM({REVENUE_AMOUNT_SQL})::float AS revenue,
               COUNT(s.id)::int AS shipments,
               SUM(COALESCE(s.shipment_weight, s.actual_weight, 0))::float AS weight,
               SUM(COALESCE(s.pieces, 1))::int AS pieces
        FROM shipments s
        LEFT JOIN companies c ON c.id = s.company_id
        WHERE s.shipment_date IS NOT NULL AND s.shipment_date >= :start AND s.shipment_date <= :end
        {where_extra}
        GROUP BY 1,2,3,4,5
    """
    cur_rows=rows(db,period_sql,{'start':c_start,'end':c_end,**extra})
    prev_rows=rows(db,period_sql,{'start':p_start,'end':p_end,**extra})

    # Lifetime facts per company. Health and "new customer" must reflect the customer's real
    # history, not the slice of it that happens to fall inside the selected window — otherwise
    # every customer looks Active on a short window.
    life={r['company_id']:r for r in rows(db,"""
        SELECT company_id, MIN(shipment_date) AS first_shipment, MAX(shipment_date) AS last_shipment
        FROM shipments WHERE company_id IS NOT NULL AND shipment_date IS NOT NULL GROUP BY company_id
    """)}
    # Last shipment strictly before the window — drives reactivation detection.
    prior={r['company_id']:r['prior_last'] for r in rows(db,"""
        SELECT company_id, MAX(shipment_date) AS prior_last
        FROM shipments WHERE company_id IS NOT NULL AND shipment_date IS NOT NULL AND shipment_date < :start
        GROUP BY company_id
    """,{'start':c_start})}

    wanted={a.strip().upper() for a in ae_code.split(',') if a.strip()} if ae_code else None
    today=_date.today()
    reactivation_cutoff=c_start-_timedelta(days=AE_REACTIVATION_GAP_MONTHS*30)

    prev_by_ae={}
    for r in prev_rows:
        e=prev_by_ae.setdefault(r['ae'],{'revenue':0.0,'shipments':0,'companies':set()})
        e['revenue']+=r['revenue']; e['shipments']+=r['shipments']
        if r['company_id']: e['companies'].add(r['company_id'])

    ae_map={}
    for r in cur_rows:
        ae=r['ae']
        if wanted and ae.upper() not in wanted: continue
        e=ae_map.setdefault(ae,{
            'ae':ae,'revenue':0.0,'shipments':0,'weight':0.0,'pieces':0,'companies':0,
            'active':0,'warning':0,'dormant':0,'unknown':0,'reactivated':0,'new_customers':0,
            'segments':{s:0 for s in AE_SEGMENTS}|{'Unclassified':0},'customers':[]})
        e['revenue']+=r['revenue']; e['shipments']+=r['shipments']
        e['weight']+=r['weight']; e['pieces']+=r['pieces']; e['companies']+=1

        cid=r['company_id']; facts=life.get(cid) or {}
        true_last=facts.get('last_shipment'); first=facts.get('first_shipment')
        days_since=(today-true_last).days if true_last else None
        # No lifetime history means the shipment isn't linked to a company at all — that's an
        # unlinked-data problem, not customer dormancy, so it gets its own bucket. Folding it
        # into `dormant` made the leaderboard count disagree with the drill-down list.
        if days_since is None: status='Unknown'; e['unknown']+=1
        elif days_since<=AE_HEALTH_ACTIVE_DAYS: status='Active'; e['active']+=1
        elif days_since<=AE_HEALTH_WARNING_DAYS: status='Warning'; e['warning']+=1
        else: status='Dormant'; e['dormant']+=1

        is_new=bool(first and first>=c_start)
        if is_new: e['new_customers']+=1
        prior_last=prior.get(cid)
        is_reactivated=(not is_new) and (prior_last is None or prior_last<reactivation_cutoff)
        if is_reactivated: e['reactivated']+=1

        seg=r['segment'] if r['segment'] in AE_SEGMENTS else 'Unclassified'
        e['segments'][seg]+=1
        e['customers'].append({
            'company_id':r['company_id'],'company_name':r['company_name'] or 'Unlinked shipments',
            'icris_number':r['icris_number'],'segment':seg,
            'revenue':round(r['revenue'],2),'shipments':r['shipments'],
            'weight':round(r['weight'],2),'pieces':r['pieces'],
            'last_shipment_date':str(true_last) if true_last else None,
            'days_since_last_shipment':days_since,'status':status,
            'is_new':is_new,'is_reactivated':is_reactivated})

    grand_revenue=sum(e['revenue'] for e in ae_map.values()) or 0.0
    out=[]
    for e in ae_map.values():
        p=prev_by_ae.get(e['ae'],{'revenue':0.0,'shipments':0,'companies':set()})
        e['customers'].sort(key=lambda x:x['revenue'],reverse=True)
        e['revenue']=round(e['revenue'],2); e['weight']=round(e['weight'],2)
        e['prev_revenue']=round(p['revenue'],2)
        e['prev_shipments']=p['shipments']
        e['prev_companies']=len(p['companies'])
        e['revenue_growth_pct']=calc_pop(e['revenue'],p['revenue'])
        e['shipment_growth_pct']=calc_pop(e['shipments'],p['shipments'])
        e['revenue_share_pct']=round(100.0*e['revenue']/grand_revenue,1) if grand_revenue else 0.0
        e['avg_revenue_per_customer']=round(e['revenue']/e['companies'],2) if e['companies'] else 0.0
        e['avg_revenue_per_shipment']=round(e['revenue']/e['shipments'],2) if e['shipments'] else 0.0
        e['retained_companies']=len({c['company_id'] for c in e['customers'] if c['company_id']} & p['companies'])
        out.append(e)
    out.sort(key=lambda x:x['revenue'],reverse=True)
    return {'timeframe':timeframe,
            'bounds':{'c_start':str(c_start),'c_end':str(c_end),'p_start':str(p_start),'p_end':str(p_end)},
            'health_thresholds':{'active_days':AE_HEALTH_ACTIVE_DAYS,'warning_days':AE_HEALTH_WARNING_DAYS,
                                 'reactivation_gap_months':AE_REACTIVATION_GAP_MONTHS},
            'segments':list(AE_SEGMENTS)+['Unclassified'],
            'items':out}

@app.get('/api/v1/leaderboard')
def leaderboard(timeframe:str|None=None,date_from:date|None=None,date_to:date|None=None,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    """Deliberately unscoped — every role sees the same full board, unlike every other
    AE-facing endpoint which filters to ae_scope. This is the gamified, motivational
    view (rank/name/number only); Rankings' Top AEs tab stays the admin/sales_lead
    drill-down. Fixed to the current calendar month ('this_month') by default.

    Accepts the same `timeframe`/`date_from`/`date_to` shared by the rest of the
    analytics suite (via get_timeframe_bounds) so the Leaderboard can reuse the one
    DateRangeControl UI — but admin/super_admin only. Everyone else stays locked to
    the current month regardless of what's passed, since this is a motivational view
    of "how's this month going," not a report anyone should be able to dig through
    historically."""
    is_admin_tier=user.role in ('admin','super_admin')
    if is_admin_tier and (timeframe or (date_from and date_to)):
        c_start,c_end,_,_=get_timeframe_bounds(timeframe or 'custom',date_from,date_to)
    else:
        c_start,c_end,_,_=get_timeframe_bounds('this_month')

    period_sql=f"""
        SELECT COALESCE(NULLIF(TRIM(s.ae_code), ''), 'UNASSIGNED') AS ae,
               SUM({REVENUE_AMOUNT_SQL})::float AS revenue,
               COUNT(s.id)::int AS shipments,
               SUM(COALESCE(s.shipment_weight, s.actual_weight, 0))::float AS weight
        FROM shipments s
        WHERE s.shipment_date IS NOT NULL AND s.shipment_date >= :start AND s.shipment_date <= :end
        GROUP BY 1
    """
    period_rows=rows(db,period_sql,{'start':c_start,'end':c_end})

    # A "win" is a unique company (or CRM customer, when known) whose call log
    # stage is 'Win' at least once in the range, per AE — NOT a raw row count.
    # AEs frequently log the same won company multiple times (follow-ups, re-logs
    # of the same closed deal), so COUNT(*) overcounts by 6-11 wins/AE/month in
    # practice; COUNT(DISTINCT ...) counts each customer's win once. NOT
    # pipeline_items.win_loss — that field is always blank in practice, because
    # pipeline_items only ever holds the CRM's *active* (still-open) pipeline; a
    # deal leaves that table once it closes. The stage the CRM actually records a
    # closed-won call under is 'Win' on the call log itself (daily_call_logs.stage).
    wins_sql="""
        SELECT COALESCE(NULLIF(TRIM(d.ae_code), ''), 'UNASSIGNED') AS ae,
               COUNT(DISTINCT COALESCE(d.crm_customer_id, LOWER(TRIM(d.company_name))))::int AS wins
        FROM daily_call_logs d
        WHERE d.call_date >= :start AND d.call_date <= :end
          AND d.stage = 'Win'
        GROUP BY 1
    """
    wins_rows=rows(db,wins_sql,{'start':c_start,'end':c_end})
    wins_by_ae={r['ae']:r['wins'] for r in wins_rows}

    ae_names={a.ae_code:a.display_name for a in db.scalars(select(AccountExecutive)).all()}
    all_codes={r['ae'] for r in period_rows if r['ae']!='UNASSIGNED'} | {a for a in wins_by_ae if a!='UNASSIGNED'}
    shipment_stats={r['ae']:r for r in period_rows}

    entries=[]
    for ae in all_codes:
        r=shipment_stats.get(ae)
        entries.append({
            'ae_code':ae,
            'display_name':ae_names.get(ae) or ae,
            'revenue':round(r['revenue'],2) if r else 0.0,
            'shipments':r['shipments'] if r else 0,
            'weight':round(r['weight'],2) if r else 0.0,
            'wins':wins_by_ae.get(ae,0),
        })

    def ranked(metric:str)->list[dict]:
        ordered=sorted(entries,key=lambda e:e[metric],reverse=True)
        return [{**e,'rank':i+1} for i,e in enumerate(ordered)]

    metrics=('revenue','shipments','weight','wins')
    by_metric={m:ranked(m) for m in metrics}
    rank_of={m:{e['ae_code']:e['rank'] for e in by_metric[m]} for m in by_metric}
    for m in by_metric:
        for e in by_metric[m]:
            e['ranks']={other:rank_of[other][e['ae_code']] for other in by_metric}

    label=c_start.strftime('%B %Y') if c_start.year==c_end.year and c_start.month==c_end.month else f'{c_start:%b %-d, %Y} – {c_end:%b %-d, %Y}'
    return {'period':{'start':str(c_start),'end':str(c_end),'label':label},'leaderboards':by_metric}

@app.get('/api/v1/analytics/executive-dashboard')
def executive_dashboard(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    destination:str|None=None,
    ae_code:str|None=None,
    min_revenue:float|None=None,
    max_revenue:float|None=None,
    min_shipments:int|None=None,
    max_shipments:int|None=None,
    segment:str|None=None,
    status:str|None=None,
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    from datetime import date as _date,datetime as _datetime
    # An 'ae'-role caller can never widen past their own book — ae_scope replaces
    # whatever ae_code was requested rather than combining with it, since a comma
    # list here would otherwise let them ask for other AEs' rows alongside their own.
    if ae_scope:ae_code=ae_scope
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)
    is_all_time=timeframe=='all_time'

    cur_sql=f"""
        SELECT s.id shipment_id, s.company_id, c.company_name, c.icris_number, s.shipment_number, c.customer_type as segment, c.status as company_status,
               s.shipment_date, s.created_at,
               -- The company's own assignment wins when it has one — this is the same
               -- field customer_type/segment (Key Account/Reseller) is derived from
               -- (docs/customer-segmentation-rules.md), so "AE" here and "segment" never
               -- disagree about who owns a customer. Falls back to the shipment's own
               -- ae_code only for companies with no assignment on file at all.
               coalesce(nullif(c.assigned_ae_code,''), nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.value_currency, 'USD') currency,
               coalesce(s.pieces, 1)::int pieces, coalesce(s.shipment_weight, s.actual_weight, 0)::float weight,
               coalesce(s.bill_type, 'Not supplied') bill_type, coalesce(s.import_country, 'Unknown') import_country
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        WHERE (:is_all = true) OR (
            (s.shipment_date IS NOT NULL AND s.shipment_date >= :c_start AND s.shipment_date <= :c_end) OR
            (s.shipment_date IS NULL AND s.created_at >= :c_start_dt AND s.created_at <= :c_end_dt)
        )
    """
    cur_rows=rows(db,cur_sql,{'is_all':is_all_time,'c_start':c_start,'c_end':c_end,'c_start_dt':_datetime.combine(c_start,_datetime.min.time()),'c_end_dt':_datetime.combine(c_end,_datetime.max.time())})

    iso_map = {'australia': 'au', 'usa': 'us', 'united states': 'us', 'dubai': 'ae', 'uae': 'ae', 'china': 'cn', 'india': 'in', 'uk': 'gb', 'united kingdom': 'gb', 'nepal': 'np'}
    
    if destination:
        d_targets = set()
        for d_str in destination.split(','):
            d_clean = d_str.strip().lower()
            if d_clean:
                d_targets.add(d_clean)
                if d_clean in iso_map:
                    d_targets.add(iso_map[d_clean])
        cur_rows = [r for r in cur_rows if any(t in (r['import_country'] or '').lower() for t in d_targets)]
    if ae_code:
        ae_targets = {a.strip().lower() for a in ae_code.split(',') if a.strip()}
        cur_rows = [r for r in cur_rows if (r['ae_code'] or '').lower() in ae_targets]
    if min_revenue is not None:
        cur_rows = [r for r in cur_rows if r['amount'] >= min_revenue]
    if max_revenue is not None:
        cur_rows = [r for r in cur_rows if r['amount'] <= max_revenue]
    if segment:
        cur_rows = [r for r in cur_rows if (r['segment'] or '').lower() == segment.lower()]
    if status:
        cur_rows = [r for r in cur_rows if (r['company_status'] or '').lower() == status.lower()]

    prev_sql=f"""
        SELECT s.id shipment_id, s.company_id, c.company_name, c.icris_number, c.customer_type as segment, c.status as company_status,
               coalesce(nullif(c.assigned_ae_code,''), nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.shipment_weight, s.actual_weight, 0)::float weight, coalesce(s.pieces, 1)::int pieces,
               coalesce(s.import_country, 'Unknown') import_country
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        WHERE (:is_all = false) AND (
            (s.shipment_date IS NOT NULL AND s.shipment_date >= :p_start AND s.shipment_date <= :p_end) OR
            (s.shipment_date IS NULL AND s.created_at >= :p_start_dt AND s.created_at <= :p_end_dt)
        )
    """
    prev_rows=rows(db,prev_sql,{'is_all':is_all_time,'p_start':p_start,'p_end':p_end,'p_start_dt':_datetime.combine(p_start,_datetime.min.time()),'p_end_dt':_datetime.combine(p_end,_datetime.max.time())}) if not is_all_time else []
    if destination:
        d_targets = set()
        for d_str in destination.split(','):
            d_clean = d_str.strip().lower()
            if d_clean:
                d_targets.add(d_clean)
                if d_clean in iso_map:
                    d_targets.add(iso_map[d_clean])
        prev_rows = [r for r in prev_rows if any(t in (r['import_country'] or '').lower() for t in d_targets)]
    if ae_code:
        ae_targets = {a.strip().lower() for a in ae_code.split(',') if a.strip()}
        prev_rows = [r for r in prev_rows if (r['ae_code'] or '').lower() in ae_targets]
    if min_revenue is not None:
        prev_rows = [r for r in prev_rows if r['amount'] >= min_revenue]
    if max_revenue is not None:
        prev_rows = [r for r in prev_rows if r['amount'] <= max_revenue]
    if segment:
        prev_rows = [r for r in prev_rows if (r['segment'] or '').lower() == segment.lower()]
    if status:
        prev_rows = [r for r in prev_rows if (r['company_status'] or '').lower() == status.lower()]

    all_comp_rows=rows(db,f"""
        SELECT c.id company_id, c.company_name, c.icris_number, c.created_at company_created_at, c.customer_type as segment, c.status as company_status, c.is_provisional,
               coalesce(nullif(c.assigned_ae_code,''), 'UNASSIGNED') ae_code,
               count(s.id)::int total_shipments,
               coalesce(sum({REVENUE_AMOUNT_SQL}), 0)::float clv_amount,
               max(s.shipment_date) last_shipment_date,
               min(s.shipment_date) first_shipment_date
        FROM companies c
        LEFT JOIN shipments s ON s.company_id=c.id
        GROUP BY c.id, c.company_name, c.icris_number, c.created_at, c.customer_type, c.status, c.is_provisional, c.assigned_ae_code
    """)
    provisional_map={r['company_id']: r['is_provisional'] for r in all_comp_rows}

    cur_company_ids={r['company_id'] for r in cur_rows if r['company_id']}
    prev_company_ids={r['company_id'] for r in prev_rows if r['company_id']}

    cur_active_count=len(cur_company_ids)
    prev_active_count=len(prev_company_ids)

    cur_total_rev=round(sum(r['amount'] for r in cur_rows), 2)
    prev_total_rev=round(sum(r['amount'] for r in prev_rows), 2)

    cur_invoices=len(cur_rows)
    prev_invoices=len(prev_rows)

    cur_arpu=round(cur_total_rev/cur_active_count, 2) if cur_active_count else 0.0
    prev_arpu=round(prev_total_rev/prev_active_count, 2) if prev_active_count else 0.0

    cur_aiv=round(cur_total_rev/cur_invoices, 2) if cur_invoices else 0.0
    prev_aiv=round(prev_total_rev/prev_invoices, 2) if prev_invoices else 0.0

    comp_first_dates={r['company_id']: r['first_shipment_date'] or r['company_created_at'].date() for r in all_comp_rows if r['company_id']}
    cur_new_companies={cid for cid in cur_company_ids if comp_first_dates.get(cid) and comp_first_dates[cid] >= c_start}
    cur_new_customers_list=[{'company_id': c['company_id'], 'company_name': c['company_name']} for c in all_comp_rows if c['company_id'] in cur_new_companies]
    cur_new_count=len(cur_new_companies)
    cur_returning_count=cur_active_count - cur_new_count

    prev_new_count=len({cid for cid in prev_company_ids if comp_first_dates.get(cid) and comp_first_dates[cid] >= p_start and comp_first_dates[cid] <= p_end})
    prev_returning_count=prev_active_count - prev_new_count
    
    cur_reactivated_sql="""
        WITH company_shipments AS (
            SELECT s.company_id,
                   MAX(s.shipment_date) FILTER (WHERE s.shipment_date >= :c_start AND s.shipment_date <= :c_end) as current_period_shipment,
                   MAX(s.shipment_date) FILTER (WHERE s.shipment_date < :c_start) as previous_shipment
            FROM shipments s
            WHERE s.company_id = ANY(:c_ids)
            GROUP BY s.company_id
        )
        SELECT company_id 
        FROM company_shipments 
        WHERE current_period_shipment IS NOT NULL 
          AND (previous_shipment IS NULL OR previous_shipment < current_period_shipment - INTERVAL '6 months')
    """
    cur_reactivated_companies = set()
    if cur_company_ids:
        cur_reactivated_companies = {r['company_id'] for r in rows(db, cur_reactivated_sql, {'c_start': c_start, 'c_end': c_end, 'c_ids': list(cur_company_ids)})}
    cur_reactivated_count = len(cur_reactivated_companies)

    prev_reactivated_sql="""
        WITH company_shipments AS (
            SELECT s.company_id,
                   MAX(s.shipment_date) FILTER (WHERE s.shipment_date >= :p_start AND s.shipment_date <= :p_end) as current_period_shipment,
                   MAX(s.shipment_date) FILTER (WHERE s.shipment_date < :p_start) as previous_shipment
            FROM shipments s
            WHERE s.company_id = ANY(:p_ids)
            GROUP BY s.company_id
        )
        SELECT company_id 
        FROM company_shipments 
        WHERE current_period_shipment IS NOT NULL 
          AND (previous_shipment IS NULL OR previous_shipment < current_period_shipment - INTERVAL '6 months')
    """
    prev_reactivated_companies = set()
    if prev_company_ids:
        prev_reactivated_companies = {r['company_id'] for r in rows(db, prev_reactivated_sql, {'p_start': p_start, 'p_end': p_end, 'p_ids': list(prev_company_ids)})}
    prev_reactivated_count = len(prev_reactivated_companies)

    retention_count=len(prev_company_ids & cur_company_ids)
    retention_rate=round(100.0 * retention_count / prev_active_count, 1) if prev_active_count else 100.0

    comp_cur_totals={}
    for r in cur_rows:
        cid=r['company_id']
        if not cid: continue
        if cid not in comp_cur_totals:
            comp_cur_totals[cid]={'company_id':cid, 'company_name':r['company_name'], 'icris_number':r['icris_number'], 'revenue':0.0, 'shipments':0, 'currency':r['currency'], 'ae_code': r.get('ae_code', 'UNASSIGNED'), 'weight': 0.0, 'pieces': 0, 'country': r.get('import_country', 'Unknown'), 'last_shipment_date': str(r.get('shipment_date') or r.get('created_at').date()), 'segment': r.get('segment') or 'Small Customer'}
        comp_cur_totals[cid]['revenue']+=r['amount']
        comp_cur_totals[cid]['shipments']+=1
        comp_cur_totals[cid]['weight']+=r.get('weight', 0.0)
        comp_cur_totals[cid]['pieces']+=r.get('pieces', 0)
        dt_str = str(r.get('shipment_date') or r.get('created_at').date())
        if dt_str > comp_cur_totals[cid]['last_shipment_date']:
            comp_cur_totals[cid]['last_shipment_date'] = dt_str

    comp_cur_list=sorted(comp_cur_totals.values(), key=lambda x: x['revenue'], reverse=True)
    highest_spender=comp_cur_list[0] if comp_cur_list else {'company_name':'None', 'icris_number':'-', 'revenue':0.0, 'currency':'USD'}

    comp_prev_totals={}
    for r in prev_rows:
        cid=r['company_id']
        if not cid: continue
        if cid not in comp_prev_totals: comp_prev_totals[cid]={'revenue':0.0, 'shipments':0, 'weight':0.0, 'pieces':0}
        comp_prev_totals[cid]['revenue']+=r['amount']
        comp_prev_totals[cid]['shipments']+=1
        comp_prev_totals[cid]['weight']+=r.get('weight', 0.0)
        comp_prev_totals[cid]['pieces']+=r.get('pieces', 0)

    pareto_list=[]
    running_rev=0.0
    for idx, item in enumerate(comp_cur_list):
        running_rev+=item['revenue']
        pareto_list.append({
            'rank': idx+1,
            'company_name': item['company_name'],
            'icris_number': item['icris_number'],
            'revenue': round(item['revenue'], 2),
            'currency': item['currency'],
            'cum_revenue': round(running_rev, 2),
            'cum_pct': round(100.0 * running_rev / cur_total_rev, 1) if cur_total_rev else 0.0,
            'customer_pct': round(100.0 * (idx+1) / max(1, len(comp_cur_list)), 1)
        })

    growth_matrix=[]
    for cid, cur_data in comp_cur_totals.items():
        prev_data = comp_prev_totals.get(cid, {'revenue':0.0, 'shipments':0, 'weight':0.0, 'pieces':0})
        prev_rev = prev_data['revenue']
        diff=cur_data['revenue'] - prev_rev
        pct_growth=calc_pop(cur_data['revenue'], prev_rev)
        is_new = cid in cur_new_companies
        growth_matrix.append({
            'company_id': cid,
            'company_name': cur_data['company_name'],
            'icris_number': cur_data['icris_number'],
            'segment': cur_data['segment'],
            'cur_revenue': round(cur_data['revenue'], 2),
            'prev_revenue': round(prev_rev, 2),
            'diff': round(diff, 2),
            'pct_growth': pct_growth,
            'shipment_count': cur_data['shipments'],
            'prev_shipments': prev_data['shipments'],
            'weight': round(cur_data['weight'], 2),
            'prev_weight': round(prev_data['weight'], 2),
            'is_new': is_new,
            'is_returning': not is_new
        })

    fastest_growing=sorted([g for g in growth_matrix if g['diff']>0], key=lambda x: x['diff'], reverse=True)[:10]
    declining_customers=sorted([g for g in growth_matrix if g['diff']<0], key=lambda x: x['diff'])[:10]

    today_date=_date.today()
    dormant_customers=[]
    for c in all_comp_rows:
        last_dt=c['last_shipment_date']
        if not last_dt:
            days_inactive=999
        else:
            days_inactive=(today_date - last_dt).days
        if days_inactive >= 30:
            dormant_customers.append({
                'company_id': c['company_id'],
                'company_name': c['company_name'],
                'icris_number': c['icris_number'],
                'clv_amount': round(c['clv_amount'], 2),
                'total_shipments': c['total_shipments'],
                'last_shipment_date': str(last_dt) if last_dt else 'Never',
                'days_inactive': days_inactive
            })
    dormant_customers.sort(key=lambda x: x['clv_amount'], reverse=True)

    billing_trend_map={}
    for r in cur_rows:
        d_str=str(r['shipment_date'] or r['created_at'].date())
        if d_str not in billing_trend_map:
            billing_trend_map[d_str]={'period':d_str, 'total_amount':0.0, 'invoice_count':0, 'pieces':0, 'weight': 0.0}
        billing_trend_map[d_str]['total_amount']+=r['amount']
        billing_trend_map[d_str]['invoice_count']+=1
        billing_trend_map[d_str]['pieces']+=r['pieces']
        billing_trend_map[d_str]['weight']+=r.get('weight', 0.0)

    billing_trend=sorted(billing_trend_map.values(), key=lambda x: x['period'])

    prev_billing_trend_map={}
    for r in prev_rows:
        d_str=str(r.get('shipment_date') or r.get('created_at', _date.today()).date() if r.get('created_at') else _date.today())
        if d_str not in prev_billing_trend_map:
            prev_billing_trend_map[d_str]={'period':d_str, 'total_amount':0.0, 'invoice_count':0, 'pieces':0, 'weight': 0.0}
        prev_billing_trend_map[d_str]['total_amount']+=r['amount']
        prev_billing_trend_map[d_str]['invoice_count']+=1
        prev_billing_trend_map[d_str]['pieces']+=r.get('pieces', 0)
        prev_billing_trend_map[d_str]['weight']+=r.get('weight', 0.0)
        
    prev_billing_trend=sorted(prev_billing_trend_map.values(), key=lambda x: x['period'])
    for b in billing_trend:
        b['total_amount']=round(b['total_amount'], 2)
        b['avg_amount']=round(b['total_amount']/b['invoice_count'], 2) if b['invoice_count'] else 0.0
    for b in prev_billing_trend:
        b['total_amount']=round(b['total_amount'], 2)
        b['avg_amount']=round(b['total_amount']/b['invoice_count'], 2) if b['invoice_count'] else 0.0

    largest_bills=sorted(cur_rows, key=lambda x: x['amount'], reverse=True)[:10]
    largest_bills_fmt=[{
        'shipment_number': r['shipment_number'],
        'company_name': r['company_name'] or 'Unlinked',
        'icris_number': r['icris_number'] or '-',
        'amount': round(r['amount'], 2),
        'currency': r['currency'],
        'bill_type': r['bill_type'],
        'date': str(r['shipment_date'] or r['created_at'].date())
    } for r in largest_bills]

    bill_types_map={}
    for r in cur_rows:
        bt=r['bill_type']
        if bt not in bill_types_map: bill_types_map[bt]={'name':bt, 'value':0.0, 'count':0}
        bill_types_map[bt]['value']+=r['amount']
        bill_types_map[bt]['count']+=1
    bill_type_breakdown=[{'name':k, 'value':round(v['value'], 2), 'count':v['count']} for k,v in bill_types_map.items()]

    key_account_list = [c['company_name'] for c in comp_cur_list if c['segment'] == 'Key Account']
    reseller_list = [c['company_name'] for c in comp_cur_list if c['segment'] == 'Reseller']
    large_list = [c['company_name'] for c in comp_cur_list if c['segment'] == 'Large Account']
    sme_list = [c['company_name'] for c in comp_cur_list if c['segment'] == 'SME']
    small_list = [c['company_name'] for c in comp_cur_list if c['segment'] == 'Small Customer' or not c['segment']]

    revenue_tiers=[
        {'tier': 'Key Account', 'count': len(key_account_list), 'list': key_account_list},
        {'tier': 'Reseller', 'count': len(reseller_list), 'list': reseller_list},
        {'tier': 'Large Account', 'count': len(large_list), 'list': large_list},
        {'tier': 'SME', 'count': len(sme_list), 'list': sme_list},
        {'tier': 'Small Customer', 'count': len(small_list), 'list': small_list}
    ]

    country_map={}
    for r in cur_rows:
        cnt=r['import_country']
        if cnt not in country_map: country_map[cnt]={'name':cnt, 'value':0, 'revenue':0.0}
        country_map[cnt]['value']+=1
        country_map[cnt]['revenue']+=r['amount']
    country_segmentation=sorted([{'name':k, 'value':v['value'], 'revenue':round(v['revenue'], 2)} for k,v in country_map.items()], key=lambda x: x['value'], reverse=True)
    # Real distinct-country count, not the length of country_segmentation — that list is
    # capped to the top 8 for the chart, which silently caps "Countries Served" at 8 too
    # if a caller (wrongly) uses its length as the KPI. 'Unknown' (blank import_country)
    # isn't a real country a customer is in, so it doesn't count.
    countries_served_count=len([k for k in country_map if k and k!='Unknown'])

    total_packages_period=sum(r['pieces'] for r in cur_rows)
    avg_packages_per_shipment=round(total_packages_period/max(1, cur_invoices), 2)
    avg_revenue_per_shipment=round(cur_total_rev/max(1, cur_invoices), 2)
    avg_revenue_per_package=round(cur_total_rev/max(1, total_packages_period), 2)

    top10_rev=sum(x['revenue'] for x in comp_cur_list[:10])
    top10_share_pct=round(100.0 * top10_rev / cur_total_rev, 1) if cur_total_rev else 0.0

    top_driver=comp_cur_list[0] if comp_cur_list else None
    biggest_decline_comp=declining_customers[0] if declining_customers else None

    exec_summary_text=(
        f"In this period ({timeframe.replace('_',' ')}), total revenue reached {cur_total_rev:,.2f} across {cur_invoices:,} shipments and {cur_active_count} active customers. "
        f"The top 10 customers represent {top10_share_pct}% of total commercial volume. "
        f"Customer retention rate is standing strong at {retention_rate}%, with {cur_new_count} newly acquired accounts."
    )

    ae_cur_totals = {}
    for r in cur_rows:
        ae = r['ae_code'] or 'UNASSIGNED'
        if ae not in ae_cur_totals:
            ae_cur_totals[ae] = {'ae_code': ae, 'revenue': 0.0, 'shipments': 0, 'company_ids': set()}
        ae_cur_totals[ae]['revenue'] += r['amount']
        ae_cur_totals[ae]['shipments'] += 1
        if r['company_id']:
            ae_cur_totals[ae]['company_ids'].add(r['company_id'])

    ae_prev_totals = {}
    for r in prev_rows:
        ae = r['ae_code'] or 'UNASSIGNED'
        ae_prev_totals[ae] = ae_prev_totals.get(ae, 0.0) + r['amount']

    ae_comp_stats = {}
    for r in cur_rows:
        ae_val = r['ae_code'] or 'UNASSIGNED'
        cid_val = r['company_id']
        if cid_val:
            key = (ae_val, cid_val)
            if key not in ae_comp_stats:
                ae_comp_stats[key] = {'revenue': 0.0, 'shipments': 0}
            ae_comp_stats[key]['revenue'] += r['amount']
            ae_comp_stats[key]['shipments'] += 1

    comp_map = {c['company_id']: c for c in all_comp_rows}
    ae_performance = []
    for ae, data in ae_cur_totals.items():
        prev_rev = ae_prev_totals.get(ae, 0.0)
        c_count = len(data['company_ids'])
        accounts_list = []
        for cid in data['company_ids']:
            c_info = comp_map.get(cid, {})
            st = ae_comp_stats.get((ae, cid), {'revenue': 0.0, 'shipments': 0})
            accounts_list.append({
                'company_id': str(cid),
                'company_name': c_info.get('company_name', 'Unknown'),
                'icris_number': c_info.get('icris_number', '-'),
                'revenue': round(st['revenue'], 2),
                'shipments': st['shipments']
            })
        accounts_list.sort(key=lambda x: x['revenue'], reverse=True)
        ae_performance.append({
            'ae_code': ae,
            'revenue': round(data['revenue'], 2),
            'shipments': data['shipments'],
            'active_customers': c_count,
            'accounts': accounts_list,
            'avg_customer_spend': round(data['revenue'] / max(1, c_count), 2),
            'prev_revenue': round(prev_rev, 2),
            'pct_growth': calc_pop(data['revenue'], prev_rev)
        })

    ae_performance = sorted(ae_performance, key=lambda x: x['revenue'], reverse=True)

    cur_total_weight=round(sum(r['weight'] for r in cur_rows), 2)
    cur_total_pcs=round(sum(r['pieces'] for r in cur_rows), 1)
    mawb_fuel=rows(db, """
        SELECT coalesce(sum(fuel_surcharge), 0)::float fuel_surcharge
        FROM master_air_waybills
        WHERE (:is_all = true) OR (manifest_date >= :c_start AND manifest_date <= :c_end)
    """, {'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end})
    fuel_surcharge=round(mawb_fuel[0]['fuel_surcharge'] if mawb_fuel else 0.0, 2)

    sp_manifest_report={
        'report_title': 'SP Export Manifest Report',
        'total_weight': cur_total_weight,
        'total_pieces': cur_total_pcs,
        'total_bill_amount': cur_total_rev,
        'total_gross_amount': round(cur_total_rev * 0.816, 2) if cur_total_rev else 0.0,
        'total_fuel_surcharge': fuel_surcharge,
        'total_shipment_count': cur_invoices
    }

    full_comp_list = []
    growth_cids = {g['company_id'] for g in growth_matrix}
    for c in all_comp_rows:
        cid = c['company_id']
        if cid in comp_cur_totals:
            full_comp_list.append({**comp_cur_totals[cid], 'is_provisional': provisional_map.get(cid, False)})
        else:
            full_comp_list.append({
                'company_id': cid,
                'company_name': c['company_name'],
                'icris_number': c['icris_number'],
                'segment': c.get('segment') or 'Small Customer',
                'revenue': 0.0,
                'shipments': 0,
                'currency': 'USD',
                'ae_code': c.get('ae_code', 'UNASSIGNED'),
                'weight': 0.0,
                'pieces': 0,
                'country': c.get('import_country', 'Unknown'),
                'last_shipment_date': str(c.get('last_shipment_date')) if c.get('last_shipment_date') else '1970-01-01',
                'is_provisional': provisional_map.get(cid, False)
            })
            if cid not in growth_cids:
                prev_data = comp_prev_totals.get(cid, {'revenue':0.0, 'shipments':0, 'weight':0.0, 'pieces':0})
                prev_rev = prev_data['revenue']
                growth_matrix.append({
                    'company_id': cid,
                    'company_name': c['company_name'],
                    'icris_number': c['icris_number'],
                    'segment': c.get('segment') or 'Small Customer',
                    'cur_revenue': 0.0,
                    'prev_revenue': round(prev_rev, 2),
                    'diff': round(0.0 - prev_rev, 2),
                    'pct_growth': calc_pop(0.0, prev_rev),
                    'shipment_count': 0,
                    'prev_shipments': prev_data['shipments'],
                    'weight': 0.0,
                    'prev_weight': round(prev_data['weight'], 2),
                    'is_new': False,
                    'is_returning': False
                })

    cur_reactivated_list = [
        {'company_id': cid, 'company_name': comp_cur_totals[cid]['company_name'], 'revenue': comp_cur_totals[cid]['revenue']}
        for cid in cur_reactivated_companies if cid in comp_cur_totals
    ]
    cur_active_list = [
        {'company_id': c['company_id'], 'company_name': c['company_name'], 'revenue': c['revenue']}
        for c in comp_cur_list[:200]
    ]

    return {
        'timeframe': timeframe,
        'bounds': {'c_start': str(c_start), 'c_end': str(c_end), 'p_start': str(p_start), 'p_end': str(p_end)},
        'sp_manifest_report': sp_manifest_report,
        'ae_performance': ae_performance,
        'kpi_cards': {
            'active_customers': {'value': cur_active_count, 'prev': prev_active_count, 'pop_pct': calc_pop(cur_active_count, prev_active_count), 'list': cur_active_list},
            'new_customers': {'value': cur_new_count, 'prev': prev_new_count, 'pop_pct': calc_pop(cur_new_count, prev_new_count), 'list': cur_new_customers_list},
            'returning_customers': {'value': cur_returning_count, 'prev': prev_returning_count, 'pop_pct': calc_pop(cur_returning_count, prev_returning_count)},
            'reactivated_customers': {'value': cur_reactivated_count, 'prev': prev_reactivated_count, 'pop_pct': calc_pop(cur_reactivated_count, prev_reactivated_count), 'list': cur_reactivated_list},
            'total_billing': {'value': cur_total_rev, 'prev': prev_total_rev, 'pop_pct': calc_pop(cur_total_rev, prev_total_rev)},
            'total_invoices': {'value': cur_invoices, 'prev': prev_invoices, 'pop_pct': calc_pop(cur_invoices, prev_invoices)},
            'avg_revenue_per_customer': {'value': cur_arpu, 'prev': prev_arpu, 'pop_pct': calc_pop(cur_arpu, prev_arpu)},
            'avg_invoice_value': {'value': cur_aiv, 'prev': prev_aiv, 'pop_pct': calc_pop(cur_aiv, prev_aiv)},
            'highest_spending_customer': highest_spender,
            'retention_rate': {'value': retention_rate, 'pop_pct': 0.0},
            'growth_rate': {'value': calc_pop(cur_total_rev, prev_total_rev)}
        },
        'revenue_analytics': {
            'top_customers': comp_cur_list[:10],
            'all_customers': full_comp_list,
            'pareto_80_20': pareto_list[:20],
            'growth_matrix': growth_matrix
        },
        'customer_growth': {
            'fastest_growing': fastest_growing,
            'declining_customers': declining_customers,
            'dormant_customers': dormant_customers[:15],
            'new_count': cur_new_count,
            'returning_count': cur_returning_count
        },
        'billing_analytics': {
            'trend': billing_trend,
            'prev_trend': prev_billing_trend,
            'largest_bills': largest_bills_fmt,
            'bill_types': bill_type_breakdown
        },
        'customer_behavior': {
            'revenue_tiers': revenue_tiers,
            'country_segmentation': country_segmentation,
            'countries_served_count': countries_served_count,
            'repeat_purchase_rate': round(100.0 * cur_returning_count / max(1, cur_active_count), 1)
        },
        'operational_analytics': {
            'total_packages': total_packages_period,
            'avg_packages_per_shipment': avg_packages_per_shipment,
            'revenue_per_shipment': avg_revenue_per_shipment,
            'revenue_per_package': avg_revenue_per_package
        },
        'leaderboards': {
            'top_revenue': comp_cur_list[:10],
            'top_growth': fastest_growing[:10],
            'top_shipments': sorted(comp_cur_list, key=lambda x: x['shipments'], reverse=True)[:10],
            'top_declining': declining_customers[:10],
            'top_ae': ae_performance[:10]
        },
        'executive_insights': {
            'revenue_comparison': {'current': cur_total_rev, 'previous': prev_total_rev, 'pop_pct': calc_pop(cur_total_rev, prev_total_rev), 'diff': round(cur_total_rev - prev_total_rev, 2)},
            'customer_comparison': {'current': cur_active_count, 'previous': prev_active_count, 'pop_pct': calc_pop(cur_active_count, prev_active_count), 'diff': cur_active_count - prev_active_count},
            'top10_concentration_pct': top10_share_pct,
            'top_revenue_driver': top_driver,
            'biggest_decline': biggest_decline_comp,
            'summary_narrative': exec_summary_text
        }
    }

@app.get('/api/v1/companies/{company_id}/analytics')
def company_analytics(
    company_id:uuid.UUID,
    timeframe:str=Query('all_time'),
    date_from:date|None=None,
    date_to:date|None=None,
    destination:str|None=None,
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    scoped_company(db,company_id,ae_scope)
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to)
    is_all_time=timeframe=='all_time'

    sql=f"""
        SELECT s.id, s.shipment_date, s.created_at,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.shipment_weight, s.actual_weight, 0)::float weight,
               coalesce(s.pieces, 1)::int pieces,
               coalesce(s.import_country, 'Unknown') import_country,
               m.destination mawb_destination
        FROM shipments s
        LEFT JOIN master_air_waybills m ON m.id = s.mawb_id
        WHERE s.company_id = :id
          AND ((:is_all = true) OR (
              (s.shipment_date IS NOT NULL AND s.shipment_date >= :c_start AND s.shipment_date <= :c_end) OR
              (s.shipment_date IS NULL AND s.created_at::date >= :c_start AND s.created_at::date <= :c_end)
          ))
    """
    cur_rows = rows(db, sql, {'id': company_id, 'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end})

    prev_rows = []
    if not is_all_time:
        prev_rows = rows(db, sql, {'id': company_id, 'is_all': False, 'c_start': p_start, 'c_end': p_end})

    def dest_value(r):
        # The shipment's own import_country is the real (consignee) destination; the MAWB's
        # destination field is just the flight's transit airport and is also dirty in the
        # source data (stray text like 'Exchange Rate: 147.16' leaks in from bad CRM rows).
        return r['import_country'] if r['import_country'] and r['import_country'].lower() != 'unknown' else r['mawb_destination']

    def apply_filters(data):
        if not destination:return data
        return [r for r in data if destination.strip().lower() in (dest_value(r) or '').lower()]

    cur_filtered = apply_filters(cur_rows)
    prev_filtered = apply_filters(prev_rows)

    def totals(data):
        return sum(r['amount'] for r in data), len(data), sum(r['weight'] for r in data), sum(r['pieces'] for r in data)

    c_rev, c_ship, c_wt, c_pcs = totals(cur_filtered)
    p_rev, p_ship, p_wt, p_pcs = totals(prev_filtered)

    kpis = {
        'revenue': {'value': round(c_rev, 2), 'pop_pct': calc_pop(c_rev, p_rev)},
        'shipments': {'value': c_ship, 'pop_pct': calc_pop(c_ship, p_ship)},
        'weight': {'value': round(c_wt, 2), 'pop_pct': calc_pop(c_wt, p_wt)},
        'avg_shipment_value': {'value': round(c_rev / max(1, c_ship), 2), 'pop_pct': calc_pop(c_rev / max(1, c_ship), p_rev / max(1, p_ship))},
    }

    trend_map = {}
    for r in cur_filtered:
        dt = r['shipment_date'] or (r['created_at'].date() if r['created_at'] else None)
        if not dt: continue
        key = dt.strftime('%Y-%m')
        if key not in trend_map: trend_map[key] = {'month': key, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
        trend_map[key]['revenue'] += r['amount']
        trend_map[key]['shipments'] += 1
        trend_map[key]['weight'] += r['weight']
    trend = sorted(trend_map.values(), key=lambda x: x['month'])
    for t in trend: t['revenue'] = round(t['revenue'], 2); t['weight'] = round(t['weight'], 2)

    weight_map = {}
    for r in cur_filtered:
        if r['weight'] <= 0: continue
        weight_map['kg'] = weight_map.get('kg', 0.0) + r['weight']
    weights = [{'weight_unit': k, 'total': round(v, 2)} for k, v in weight_map.items()]

    def count_destinations(data):
        m = {}
        for r in data:
            d = dest_value(r)
            if not d or d.lower() == 'unknown': continue
            m[d] = m.get(d, 0) + 1
        return sorted([{'import_country': k, 'count': v} for k, v in m.items()], key=lambda x: x['count'], reverse=True)

    # Chart reflects the active filter; the dropdown's own option list does not — it's
    # always built from the FULL unfiltered current-period set (destination_options),
    # otherwise picking a destination narrows the very list you'd pick your next one from,
    # and a selection with zero matches would empty the dropdown entirely.
    destinations = count_destinations(cur_filtered)
    destination_options = count_destinations(cur_rows)

    return {
        'bounds': {'c_start': str(c_start), 'c_end': str(c_end), 'p_start': str(p_start), 'p_end': str(p_end)},
        'kpi_cards': kpis,
        'trend': trend,
        'weights': weights,
        'destinations': destinations,
        'destination_options': destination_options,
    }
@app.get('/api/v1/companies/{company_id}/activity')
def company_activity(company_id:uuid.UUID,db:Session=Depends(get_db)):return [serialize(x) for x in db.scalars(select(ActivityLog).where(ActivityLog.entity_id==company_id).order_by(ActivityLog.created_at.desc())).all()]
@app.get('/api/v1/shipments/{shipment_id}/activity')
def shipment_activity(shipment_id:uuid.UUID,db:Session=Depends(get_db)):return [serialize(x) for x in db.scalars(select(ActivityLog).where(ActivityLog.entity_id==shipment_id).order_by(ActivityLog.created_at.desc())).all()]
def call_log_payload(item):
    return {'id':str(item.id),'call_date':item.call_date.isoformat(),'company_name':item.company_name,'crm_customer_id':item.crm_customer_id,'stage':item.stage,'category':item.category,'contact_person':item.contact_person,'phone':item.phone,'call_type':item.call_type,'ae_code':item.ae_code,'remarks':item.remarks,'supervisor_comment':item.supervisor_comment,'follow_up_date':item.follow_up_date.isoformat() if item.follow_up_date else None,'scraped_at':item.scraped_at.isoformat()}
@app.get('/api/v1/companies/{company_id}/call-logs')
def company_call_logs(company_id:uuid.UUID,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    """Matches on normalized company name, not `Company.crm_customer_id` — that column is
    never populated by CRM sync (the call-log scrape and the manifest sync are separate CRM
    exports with no shared numeric ID), so matching on it always returned zero rows. The call
    log's own `crm_customer_id` is kept as a display field only."""
    company=db.get(Company,company_id)
    if not company:raise HTTPException(404,'Company not found')
    names={company.normalized_name}
    names.update(a.normalized_alias_name for a in db.scalars(select(CompanyAlias).where(CompanyAlias.company_id==company_id)).all())
    query=select(DailyCallLog).where(DailyCallLog.normalized_company_name.in_(names)).order_by(DailyCallLog.call_date.desc())
    if ae_scope:query=query.where(DailyCallLog.ae_code==ae_scope)
    rows=[call_log_payload(x) for x in db.scalars(query).all()]
    return {'items':rows,'total':len(rows)}

def describe_crm_schedule(cron:str)->str:
    """Human-readable schedule label derived from the actual cron value.

    The scheduler (crm_worker.check_auto_schedule) matches against the container's OS clock,
    which is UTC — never Nepal time (NPT, UTC+5:45). This renders the *NPT* time so the label
    in the UI matches when the sync actually runs from a Kathmandu desk, not the raw UTC cron.
    Falls back to the literal cron string for any shape this can't confidently describe,
    rather than guessing.
    """
    try:
        minute_f,hour_f,dom_f,month_f,dow_f=cron.split()
        if dom_f!='*' or month_f!='*' or dow_f!='*' or not minute_f.lstrip('-').isdigit():
            return cron
        minute=int(minute_f)
        hours=sorted(int(h) for h in hour_f.split(','))
        labels=[]
        for h in hours:
            total_min=(h*60+minute+345)%1440  # +5:45 NPT offset
            npt_h,npt_m=divmod(total_min,60)
            period='AM' if npt_h<12 else 'PM'
            display_h=npt_h%12 or 12
            labels.append(f"{display_h}:{npt_m:02d} {period}")
        joined=' & '.join(labels)
        return f"{cron} ({joined} NPT Daily, Both Import & Export)"
    except (ValueError,AttributeError):
        return cron

# Read-only legacy CRM synchronization queue. Credentials and cookies are never serialized.
@app.get('/api/v1/crm-sync/status')
def crm_status(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    state=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='manifest'))
    checks={'base URL':bool(settings.crm_base_url),'login URL':bool(settings.crm_login_url),'credentials':settings.credentials_configured,'Export manifest list URL':bool(settings.crm_export_manifest_list_url),'Export detail URL':bool(settings.crm_export_manifest_detail_url_template),'allowed hosts':bool(settings.allowed_hosts)}
    missing=[name for name,configured in checks.items() if not configured]
    ready=settings.crm_scraper_enabled and not missing
    message='CRM Export sync is ready' if ready else ('CRM connector is disabled' if not settings.crm_scraper_enabled else 'Missing server configuration: '+', '.join(missing))
    worker=db.scalar(select(CrmSyncState).where(CrmSyncState.entity_type=='worker'))
    worker_data=worker.cursor_json if worker else None
    causes=[]
    if not checks['credentials']:causes.append('CRM credentials are not configured')
    if not checks['Export manifest list URL']:causes.append('Export page is not configured')
    if not worker_data:causes.append('CRM worker is not running')
    import_preview_available=bool(settings.crm_import_manifest_list_url)
    if not import_preview_available:causes.append('Import synchronization is not available yet')
    earliest={direction:({'date':item.last_successful_date,'verified_at':item.last_successful_sync_at,'source':(item.cursor_json or {}).get('earliest_date_source')} if (item:=earliest_state(db,direction)) else None) for direction in ('export','import')}
    watermarks={direction:({'manifest_date':item.last_successful_date,'sync_at':item.last_successful_sync_at,'overlap_days':(item.cursor_json or {}).get('overlap_days',3)} if (item:=watermark_state(db,direction)) else None) for direction in ('export','import')}
    active_runs=db.scalars(select(CrmSyncRun).where(CrmSyncRun.status.in_({'queued','discovering','running'})).order_by(CrmSyncRun.created_at.desc())).all()
    active_backfills=[b for b in db.scalars(select(CrmBackfillRun).where(CrmBackfillRun.status.in_({'running','previewing'})).order_by(CrmBackfillRun.created_at.desc())).all()]
    active_by_direction={}
    for ar in active_runs:
        d=ar.direction or 'export'
        if d not in active_by_direction:
            entry={'run_id':str(ar.id),'status':ar.status,'direction':d,'sync_type':ar.sync_type,'created_at':ar.created_at.isoformat() if ar.created_at else None}
            entry['progress']=crm_progress(db,ar.id);active_by_direction[d]=entry
    for ab in active_backfills:
        d=ab.direction or 'export'
        if d not in active_by_direction:
            active_by_direction[d]={'backfill_id':str(ab.id),'status':ab.status,'direction':d,'chunk_progress':f'{ab.completed_chunks}/{ab.total_chunks}','manifests_discovered':ab.total_manifests_discovered}
    sched_desc = describe_crm_schedule(settings.crm_schedule_cron) if settings.crm_schedule_enabled and settings.crm_schedule_cron else "manual"
    return {'enabled':settings.crm_scraper_enabled,'ready':ready,'message':message,'configuration':checks,'safe_causes':causes,'base_url_configured':checks['base URL'],'login_url_configured':checks['login URL'],'credentials_configured':checks['credentials'],'export_list_configured':checks['Export manifest list URL'],'import_list_configured':import_preview_available,'import_preview_available':import_preview_available,'import_live_enabled':True,'export_live_enabled':True,'worker_running':bool(worker_data),'http_connector_available':True,'worker':worker_data,'last_successful_sync_at':state.last_successful_sync_at if state else None,'customer_master_ready':customer_master_ready(db),'earliest_dates':earliest,'watermarks':watermarks,'schedule_enabled':settings.crm_schedule_enabled,'schedule_cron':settings.crm_schedule_cron,'incremental_schedule':sched_desc,'active_sync_by_direction':active_by_direction}
def crm_progress(db,run_id):
    counts={status:count for status,count in db.execute(select(CrmSyncItem.status,func.count()).where(CrmSyncItem.run_id==run_id).group_by(CrmSyncItem.status))}
    processing=sum(counts.get(x,0) for x in ('claimed','fetching','parsing','validating','importing'))
    return {**{x:counts.get(x,0) for x in ('pending','succeeded','succeeded_with_warnings','retry_scheduled','quarantined','cancelled')},'processing':processing,'total':sum(counts.values()),'estimated_remaining':sum(counts.get(x,0) for x in ('pending','claimed','fetching','parsing','validating','importing','retry_scheduled'))}
def crm_item_payload(item):
    data=serialize(item);data.pop('source_detail_url',None);data.pop('discovery_metadata',None);return data
def crm_run_payload(db,run,include_items=False):
    data=serialize(run,{'progress':crm_progress(db,run.id)})
    if include_items:data['items']=[crm_item_payload(x) for x in db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id).order_by(CrmSyncItem.created_at)).all()]
    return data
@app.post('/api/v1/crm-sync/manifests',status_code=202)
def queue_crm_manifests(body:CrmManifestSyncIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    if body.date_to<body.date_from:raise HTTPException(422,'date_to must be on or after date_from')
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    run=CrmSyncRun(sync_type='manifest_range',status='queued',requested_from_date=body.date_from,requested_to_date=body.date_to,direction=body.direction,dry_run=body.dry_run,maximum_manifests=body.maximum_manifests,retry_failed=body.retry_failed,force_reparse=body.force_reparse);db.add(run);commit(db);return crm_run_payload(db,run)
@app.post('/api/v1/crm-sync/sync-now',status_code=202)
def sync_up_to_date_now(direction:str='both',overlap_days:int=3,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    existing=db.scalar(select(CrmSyncRun).where(CrmSyncRun.status.in_({'queued','discovering','running'})))
    if existing:return crm_run_payload(db,existing)
    run=create_incremental(db,direction,'import',overlap_days=overlap_days,force=False);db.commit();return crm_run_payload(db,run)
@app.post('/api/v1/crm-sync/export/{record_id}',status_code=202)
def queue_crm_export_id(record_id:int,dry_run:bool=False,force_reparse:bool=False,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    run=CrmSyncRun(sync_type='manifest_single',requested_mawb=f'ID:{record_id}',status='running',direction='export',dry_run=dry_run,force_reparse=force_reparse,started_at=now());db.add(run);db.flush();db.add(CrmSyncItem(run_id=run.id,manifest_direction='export',crm_manifest_id=str(record_id),status='pending',maximum_attempts=settings.crm_sync_max_attempts));commit(db);return crm_run_payload(db,run,True)
@app.post('/api/v1/crm-sync/export-record',status_code=202)
def queue_crm_export_reference(body:CrmSingleRecordIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    reference=body.record_reference.strip();record_id=None
    if reference.isdigit():record_id=int(reference)
    else:
        try:parsed=urlparse(reference)
        except ValueError as exc:raise HTTPException(422,'Enter a valid CRM Export Record ID or CRM detail-page URL') from exc
        host=(parsed.hostname or '').casefold()
        if parsed.scheme not in {'http','https'} or host not in settings.allowed_hosts:raise HTTPException(422,'This URL is not an approved CRM address')
        values=parse_qs(parsed.query);candidate=next(iter(values.get('ID') or values.get('id') or []),None)
        if candidate and candidate.isdigit():record_id=int(candidate)
    if record_id is None or record_id<1:raise HTTPException(422,'The CRM Export Record ID must be a positive number')
    return queue_crm_export_id(record_id,dry_run=body.dry_run,db=db)
def backfill_payload(db,backfill,include_chunks=False):
    totals=db.execute(text('SELECT coalesce(sum(r.mawbs_created),0)::int mawbs_created,coalesce(sum(r.mawbs_updated),0)::int mawbs_updated,coalesce(sum(r.shipments_created),0)::int shipments_created,coalesce(sum(r.shipments_updated),0)::int shipments_updated,coalesce(sum(r.matched_by_icris),0)::int companies_matched,coalesce(sum(r.companies_created),0)::int provisional_companies_created,coalesce(sum(r.missing_icris),0)::int blank_icris_shipments FROM crm_backfill_chunks c LEFT JOIN crm_sync_runs r ON r.id=c.sync_run_id WHERE c.backfill_id=:id'),{'id':backfill.id}).mappings().one()
    data=serialize(backfill,{'progress_percent':round(100*backfill.completed_chunks/backfill.total_chunks,2) if backfill.total_chunks else 0,'customer_master_ready':customer_master_ready(db),'existing_packages_preserved':db.scalar(select(func.count()).select_from(Package)),**dict(totals)})
    if include_chunks:data['chunks']=[serialize(x) for x in db.scalars(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==backfill.id).order_by(CrmBackfillChunk.sequence_number)).all()]
    return data
def start_backfill(body,mode,db):
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    try:backfill=create_backfill(db,body.direction,body.start_date,body.end_date,body.chunk_size_days,mode,body.confirm_start_date);db.commit();db.refresh(backfill);return backfill_payload(db,backfill,True)
    except ValueError as exc:db.rollback();raise HTTPException(422,str(exc)) from exc
@app.post('/api/v1/crm-sync/backfills/preview',status_code=202)
def preview_backfill(body:CrmBackfillIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return start_backfill(body,'preview',db)
@app.post('/api/v1/crm-sync/backfills',status_code=202)
def launch_backfill(body:CrmBackfillIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return start_backfill(body,'import',db)
@app.get('/api/v1/crm-sync/backfills')
def backfills(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [backfill_payload(db,x) for x in db.scalars(select(CrmBackfillRun).order_by(CrmBackfillRun.created_at.desc())).all()]
@app.get('/api/v1/crm-sync/backfills/{backfill_id}')
def backfill_detail(backfill_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return backfill_payload(db,one(db,CrmBackfillRun,backfill_id),True)
@app.post('/api/v1/crm-sync/backfills/{backfill_id}/pause')
def backfill_pause(backfill_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    item=one(db,CrmBackfillRun,backfill_id)
    try:pause_backfill(db,item);commit(db);return backfill_payload(db,item,True)
    except ValueError as exc:raise HTTPException(409,str(exc)) from exc
@app.post('/api/v1/crm-sync/backfills/{backfill_id}/resume')
def backfill_resume(backfill_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    item=one(db,CrmBackfillRun,backfill_id)
    try:resume_backfill(db,item);commit(db);return backfill_payload(db,item,True)
    except ValueError as exc:raise HTTPException(409,str(exc)) from exc
@app.post('/api/v1/crm-sync/backfills/{backfill_id}/cancel')
def backfill_cancel(backfill_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):item=one(db,CrmBackfillRun,backfill_id);cancel_backfill(db,item);commit(db);return backfill_payload(db,item,True)
@app.post('/api/v1/crm-sync/backfills/{backfill_id}/retry')
def backfill_retry(backfill_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    item=one(db,CrmBackfillRun,backfill_id)
    for chunk in db.scalars(select(CrmBackfillChunk).where(CrmBackfillChunk.backfill_id==item.id,CrmBackfillChunk.status=='needs_attention')).all():
        item.completed_chunks=max(0,item.completed_chunks-1);item.total_manifests_discovered=max(0,item.total_manifests_discovered-chunk.manifest_count);item.total_manifests_processed=max(0,item.total_manifests_processed-chunk.completed_manifest_count);item.warning_manifests=max(0,item.warning_manifests-chunk.warning_count);item.quarantined_manifests=max(0,item.quarantined_manifests-chunk.quarantined_count);chunk.status='pending';chunk.sync_run_id=None;chunk.completed_at=None;chunk.manifest_count=0;chunk.completed_manifest_count=0;chunk.warning_count=0;chunk.quarantined_count=0
    item.failed_chunks=0;item.completed_at=None;item.status='previewing' if item.mode=='preview' else 'running';activate_next_chunk(db,item);commit(db);return backfill_payload(db,item,True)
def start_update(body,mode,db):
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    try:run=create_incremental(db,body.direction,mode,body.overlap_days,body.force_recheck);commit(db);return crm_run_payload(db,run)
    except ValueError as exc:raise HTTPException(422,str(exc)) from exc
@app.post('/api/v1/crm-sync/updates/preview',status_code=202)
def preview_update(body:CrmUpdateIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return start_update(body,'preview',db)
@app.post('/api/v1/crm-sync/updates',status_code=202)
def launch_update(body:CrmUpdateIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return start_update(body,'import',db)
@app.get('/api/v1/crm-sync/runs')
def crm_runs(limit:int=Query(50,le=200),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return [crm_run_payload(db,x) for x in db.scalars(select(CrmSyncRun).order_by(CrmSyncRun.created_at.desc()).limit(limit)).all()]
@app.get('/api/v1/crm-sync/runs/{run_id}')
def crm_run(run_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):return crm_run_payload(db,one(db,CrmSyncRun,run_id),True)
@app.post('/api/v1/crm-sync/runs/{run_id}/retry',status_code=202)
def retry_crm_run(run_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    run=one(db,CrmSyncRun,run_id);eligible=db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.status.in_({'quarantined','retry_scheduled'}))).all()
    if not eligible:raise HTTPException(409,'No retryable manifest items')
    for item in eligible:item.status='pending';item.next_retry_at=None;item.claimed_by=None;item.lease_expires_at=None
    run.status='running';run.completed_at=None;commit(db);return crm_run_payload(db,run,True)
@app.post('/api/v1/crm-sync/items/{item_id}/retry',status_code=202)
def retry_crm_item(item_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    item=one(db,CrmSyncItem,item_id)
    if item.status not in ('quarantined','retry_scheduled'):raise HTTPException(409,'Only quarantined or scheduled items can be retried')
    item.status='pending';item.next_retry_at=None;item.claimed_by=None;item.lease_expires_at=None;run=one(db,CrmSyncRun,item.run_id);run.status='running';run.completed_at=None;commit(db);return crm_item_payload(item)
@app.post('/api/v1/crm-sync/runs/{run_id}/resume')
def resume_crm_run(run_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    run=one(db,CrmSyncRun,run_id)
    if run.status not in ('interrupted','completed_with_errors','cancelled'):raise HTTPException(409,'Run is not resumable')
    for item in db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.status.in_({'cancelled','retry_scheduled'}))).all():item.status='pending';item.next_retry_at=None
    run.status='running';run.completed_at=None;commit(db);return crm_run_payload(db,run,True)
@app.post('/api/v1/crm-sync/runs/{run_id}/reprocess',status_code=202)
def reprocess_crm_run(run_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    run=one(db,CrmSyncRun,run_id);run.force_reparse=True;run.status='running';run.completed_at=None
    for item in db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.status.in_({'succeeded','succeeded_with_warnings','quarantined'}))).all():item.status='pending';item.next_retry_at=None
    commit(db);return crm_run_payload(db,run,True)
@app.post('/api/v1/crm-sync/runs/{run_id}/cancel')
def cancel_crm_run(run_id:uuid.UUID,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    run=one(db,CrmSyncRun,run_id)
    for item in db.scalars(select(CrmSyncItem).where(CrmSyncItem.run_id==run.id,CrmSyncItem.status.in_({'pending','retry_scheduled'}))).all():item.status='cancelled';item.completed_at=now()
    run.status='cancelled';run.completed_at=now();commit(db);return crm_run_payload(db,run,True)
@app.post('/api/v1/crm-sync/rematch')
def crm_rematch(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    result=rematch(db);commit(db);return result
@app.post('/api/v1/crm-sync/pnl')
def sync_pnl(body:CrmPnlSyncIn,db:Session=Depends(get_db),_user:User=Depends(require_role('super_admin'))):
    from .crm_connector import CrmSessionManager,ConnectorError
    from .crm_parser import parse_pnl_grid,CrmParseError
    if body.date_to<body.date_from:raise HTTPException(422,'date_to must be on or after date_from')
    if (body.date_to-body.date_from).days>31:raise HTTPException(422,'The CRM P&L report times out on ranges wider than ~31 days — request smaller windows')
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    if not settings.crm_pnl_url:raise HTTPException(503,'CRM P&L URL is not configured')
    connector=CrmSessionManager()
    try:
        html=connector.pnl_list(body.date_from,body.date_to)
    except ConnectorError as exc:raise HTTPException(502,f'CRM P&L fetch failed: {exc}') from exc
    finally:connector.close()
    try:
        report=parse_pnl_grid(html)
    except CrmParseError as exc:raise HTTPException(502,f'CRM P&L page structure error ({exc.code}): {exc}') from exc
    stats=upsert_pnl(db,report,source_url=settings.crm_pnl_url,dry_run=body.dry_run)
    if not body.dry_run:commit(db)
    total=report.total or {}
    return {'dry_run':body.dry_run,'date_from':body.date_from,'date_to':body.date_to,'stats':stats,'warnings':report.warnings,'total':{k:(str(v) if v is not None else None) for k,v in total.items()},'source_checksum':report.source_checksum}
@app.post('/api/v1/crm-sync/ups-pnl')
def sync_ups_pnl(body:CrmUpsPnlSyncIn,db:Session=Depends(get_db),_user:User=Depends(require_role('super_admin'))):
    """Per-shipment UPS profit/loss: walk the UPS manifest list for a date range, then fetch
    each manifest's detail grid. One CRM request per manifest, so ranges are capped and the
    result reports per-manifest outcomes rather than failing the whole batch on one bad page."""
    from .crm_connector import CrmSessionManager,ConnectorError
    from .crm_parser import parse_ups_list,parse_ups_detail,CrmParseError
    if body.date_to<body.date_from:raise HTTPException(422,'date_to must be on or after date_from')
    if (body.date_to-body.date_from).days>31:raise HTTPException(422,'The CRM UPS report times out on ranges wider than ~31 days — request smaller windows')
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    if not settings.crm_ups_list_url or not settings.crm_ups_detail_url_template:raise HTTPException(503,'CRM UPS URLs are not configured')
    connector=CrmSessionManager()
    try:
        try:list_html=connector.ups_list(body.date_from,body.date_to)
        except ConnectorError as exc:raise HTTPException(502,f'CRM UPS list fetch failed: {exc}') from exc
        try:manifests=parse_ups_list(list_html,settings.crm_ups_list_url)
        except CrmParseError as exc:raise HTTPException(502,f'CRM UPS list structure error ({exc.code}): {exc}') from exc
        if body.maximum_manifests:manifests=manifests[:body.maximum_manifests]
        totals={'manifests':len(manifests),'succeeded':0,'failed':0,'rows':0,'matched':0,'unmatched':0,'mawb_matched':0,'mawb_unmatched':0}
        results=[]
        for item in manifests:
            entry={'mawb':item['MAWB'],'manifest_date':item['manifest_date'],'crm_record_id':item['crm_record_id']}
            try:
                detail_html,_=connector.ups_detail(item['crm_record_id'])
                detail=parse_ups_detail(detail_html)
            except (ConnectorError,CrmParseError) as exc:
                entry['error']=f'{type(exc).__name__}: {exc}'[:200];totals['failed']+=1;results.append(entry);db.rollback();continue
            stats=upsert_ups_detail(db,detail,item['MAWB'],item['manifest_date'],item['crm_record_id'],dry_run=body.dry_run)
            if not body.dry_run:db.commit()
            entry.update(stats);entry['warnings']=detail.warnings
            for key in ('rows','matched','unmatched','mawb_matched','mawb_unmatched'):
                totals[key]+=stats['total_rows'] if key=='rows' else stats[key]
            totals['succeeded']+=1;results.append(entry)
    finally:
        connector.close()
    return {'dry_run':body.dry_run,'date_from':body.date_from,'date_to':body.date_to,'totals':totals,'manifests':results}
@app.post('/api/v1/crm-sync/active-pipeline')
def sync_active_pipeline_route(body:CrmPipelineSyncIn,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Pull the CRM's Active Pipeline grid and replace pipeline_items with the current snapshot.

    Defaults to today through crm_pipeline_lookahead_days ahead, since the pipeline is
    inherently forward-looking (expected close/delivery dates), unlike manifest sync which
    looks backward over shipped history."""
    from .crm_connector import CrmSessionManager,ConnectorError,SessionExpired
    from .crm_parser import CrmParseError
    date_from=body.date_from or date.today()
    date_to=body.date_to or (date_from+timedelta(days=settings.crm_pipeline_lookahead_days))
    if date_to<date_from:raise HTTPException(422,'date_to must be on or after date_from')
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    if not settings.crm_active_pipeline_url:raise HTTPException(503,'CRM Active Pipeline URL is not configured')
    connector=CrmSessionManager()
    try:
        html=connector.active_pipeline_list(date_from,date_to)
    except ConnectorError as exc:raise HTTPException(502,f'CRM Active Pipeline fetch failed: {exc}') from exc
    finally:connector.close()
    try:
        run=run_active_pipeline_sync(db,html,settings.crm_active_pipeline_url,dry_run=body.dry_run)
    except (SessionExpired,CrmParseError) as exc:
        commit(db);raise HTTPException(502,f'CRM Active Pipeline sync failed ({getattr(exc,"code","parse_error")}): {exc}') from exc
    commit(db)
    return crm_run_payload(db,run)
@app.get('/api/v1/pipeline')
def list_pipeline(ae_code:str|None=None,overdue_only:bool=False,lost_only:bool=False,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    today=date.today()
    query=select(PipelineItem).order_by(PipelineItem.expected_date)
    effective_ae_code=ae_scope or ae_code
    if effective_ae_code:query=query.where(PipelineItem.ae_code==effective_ae_code)
    items=db.scalars(query).all()
    def payload(item):
        win_loss=(item.win_loss or '').strip()
        is_lost='loss' in win_loss.casefold()
        is_overdue=item.expected_date<today and not win_loss
        return {'id':str(item.id),'expected_date':item.expected_date.isoformat(),'company_name':item.company_name,'icris_number':item.icris_number,'country':item.country,'weight_kg':float(item.weight_kg) if item.weight_kg is not None else None,'revenue_usd':float(item.revenue_usd) if item.revenue_usd is not None else None,'pieces':item.pieces,'category':item.category,'ae_code':item.ae_code,'win_loss':item.win_loss,'remarks':item.remarks,'is_overdue':is_overdue,'is_lost':is_lost,'scraped_at':item.scraped_at.isoformat()}
    rows=[payload(x) for x in items]
    if overdue_only:rows=[r for r in rows if r['is_overdue']]
    if lost_only:rows=[r for r in rows if r['is_lost']]
    as_of=max((x.scraped_at for x in items),default=None)
    return {'items':rows,'total':len(rows),'overdue_count':sum(1 for r in rows if r['is_overdue']),'lost_count':sum(1 for r in rows if r['is_lost']),'as_of':as_of.isoformat() if as_of else None}
@app.get('/api/v1/crm-sync/diagnose')
def diagnose_crm_list(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    from datetime import timedelta
    from .crm_connector import CrmSessionManager,LoginFormError,UnexpectedRedirect
    from .crm_parser import parse_manifest_list,CrmParseError,LoginRequired
    from pathlib import Path
    status=crm_status(db)
    if not status['ready']:raise HTTPException(503,status['message'])
    report={'export':{},'import':{}}
    snapshot_dir=Path(settings.crm_snapshot_storage_path)
    try:snapshot_dir.mkdir(parents=True,exist_ok=True)
    except OSError:pass
    for direction in ('export','import'):
        section=report[direction]
        connector=CrmSessionManager()
        try:
            t0=__import__('time').monotonic()
            connector.login()
            section['login_ok']=True
            section['login_ms']=int((__import__('time').monotonic()-t0)*1000)
            t1=__import__('time').monotonic()
            if direction=='export':
                get_html=connector.export_list()
            else:
                get_html=connector.import_list()
            section['get_html_size']=len(get_html)
            section['get_ms']=int((__import__('time').monotonic()-t1)*1000)
            from bs4 import BeautifulSoup
            get_soup=BeautifulSoup(get_html,'html.parser')
            get_tables=get_soup.find_all('table')
            section['get_table_count']=len(get_tables)
            get_password_fields=get_soup.find_all('input',{'type':'password'})
            section['get_has_password']=bool(get_password_fields)
            get_rows_parsed=0
            get_headers_found=[]
            try:
                rows=get_manifest_list_rows(get_html,settings.crm_base_url)
                get_rows_parsed=len(rows)
                if rows:get_headers_found=list(rows[0].keys())[:5]
            except Exception as e:
                section['get_parse_error']=str(e)[:200]
            section['get_rows_parsed']=get_rows_parsed
            section['get_headers']=get_headers_found
            t2=__import__('time').monotonic()
            from datetime import date as _date
            today=_date.today()
            from_date=today-timedelta(days=7)
            to_date=today
            if direction=='export' and settings.crm_export_manifest_list_url:
                url=settings.crm_export_manifest_list_url
                from .crm_connector import webforms_payload
                fields={'ctl00$MainContent$txt_dateFrom':f'{from_date.month}/{from_date.day}/{from_date.year}','ctl00$MainContent$txt_DateTo':f'{to_date.month}/{to_date.day}/{to_date.year}','ctl00$MainContent$btn_Preview':'Show'}
                payload=webforms_payload(get_html,fields)
                post_response=connector.request('POST',url,data=payload)
                post_html=post_response.text
            elif direction=='import' and settings.crm_import_manifest_list_url:
                post_html=connector.request('GET',settings.crm_import_manifest_list_url).text
            else:
                section['skipped']=True
                continue
            section['post_html_size']=len(post_html)
            section['post_ms']=int((__import__('time').monotonic()-t2)*1000)
            post_soup=BeautifulSoup(post_html,'html.parser')
            post_tables=post_soup.find_all('table')
            section['post_table_count']=len(post_tables)
            post_password_fields=post_soup.find_all('input',{'type':'password'})
            section['post_has_password']=bool(post_password_fields)
            post_rows_parsed=0
            try:
                rows=get_manifest_list_rows(post_html,settings.crm_base_url)
                post_rows_parsed=len(rows)
                if rows:
                    section['post_headers']=list(rows[0].keys())[:5]
                    section['post_sample_row']={k:str(v)[:50] for k,v in list(rows[0].items())[:6]}
            except Exception as e:
                section['post_parse_error']=str(e)[:200]
            section['post_rows_parsed']=post_rows_parsed
            section['html_identical']=get_html==post_html
            section['html_similarity']=round(1-len(set(get_html)-set(post_html))/max(len(set(get_html)),1),3) if get_html and post_html else 0
            try:
                ts=__import__('datetime').datetime.now().strftime('%Y%m%d_%H%M%S')
                get_path=snapshot_dir/f'diagnose_{direction}_get_{ts}.html'
                post_path=snapshot_dir/f'diagnose_{direction}_post_{ts}.html'
                get_path.write_text(get_html,encoding='utf-8')
                post_path.write_text(post_html,encoding='utf-8')
                section['snapshots']=[str(get_path),str(post_path)]
            except OSError as e:
                section['snapshot_error']=str(e)[:100]
            section['result']='rows_found' if post_rows_parsed else 'zero_rows'
        except Exception as exc:
            section['error']=str(exc)[:300]
            section['error_type']=type(exc).__name__
        finally:
            connector.close()
    export_rows=report['export'].get('post_rows_parsed',0)
    import_rows=report['import'].get('post_rows_parsed',0)
    if export_rows==0 and import_rows==0:
        report['diagnosis']='BOTH_EMPTY'
        report['likely_cause']='List page postback is not returning data rows. Check snapshots for ASP.NET field name mismatch or ViewState staleness.'
    elif export_rows==0:
        report['diagnosis']='EXPORT_ONLY_EMPTY'
        report['likely_cause']='Export list page postback is not returning data rows. Import works.'
    elif import_rows==0:
        report['diagnosis']='IMPORT_ONLY_EMPTY'
        report['likely_cause']='Import list page has no parseable rows.'
    else:
        report['diagnosis']='BOTH_HAVE_ROWS'
        report['likely_cause']='List pages return data. The issue may be in date filtering or row selection.'
    return report
def get_manifest_list_rows(html,base_url):
    from .crm_parser import parse_manifest_list
    return parse_manifest_list(html,base_url)

def mawb_summary(m,db):
    summary=db.execute(text('SELECT * FROM vw_mawb_reconciliation WHERE mawb_id=:id'),{'id':m.id}).mappings().first()
    return serialize(m,dict(summary) if summary else {})
@app.get('/api/v1/mawbs')
def mawbs(q:str|None=None,manifest_date_from:date|None=None,manifest_date_to:date|None=None,flight_number:str|None=None,origin:str|None=None,destination:str|None=None,sync_status:str|None=None,has_pnl:bool|None=None,sort:str=Query('manifest_date',pattern='^(manifest_date|margin)$'),limit:int=Query(50,le=200),offset:int=0,db:Session=Depends(get_db),ae_scope:str|None=Depends(get_ae_scope)):
    stmt=select(MasterAirWaybill)
    if ae_scope:stmt=stmt.where(MasterAirWaybill.id.in_(select(Shipment.mawb_id).where(Shipment.ae_code==ae_scope,Shipment.mawb_id.is_not(None))))
    if q:stmt=stmt.where(MasterAirWaybill.mawb_number.ilike(f'%{q}%'))
    if manifest_date_from:stmt=stmt.where(MasterAirWaybill.manifest_date>=manifest_date_from)
    if manifest_date_to:stmt=stmt.where(MasterAirWaybill.manifest_date<=manifest_date_to)
    for field,value in [('flight_number',flight_number),('origin',origin),('destination',destination)]:
        if value:stmt=stmt.where(getattr(MasterAirWaybill,field).ilike(f'%{value}%'))
    if has_pnl is not None:stmt=stmt.where(MasterAirWaybill.pnl_synced_at.is_not(None) if has_pnl else MasterAirWaybill.pnl_synced_at.is_(None))
    total=db.scalar(select(func.count()).select_from(stmt.subquery()))
    if sort=='margin':
        # Sorts against the FULL filtered result set, not just the current page — the
        # frontend used to only re-sort the 25 rows already returned by the default
        # date-ordered page, which silently hid the true best/worst-margin MAWBs on
        # later pages. NULLIF guards MAWBs with a zero (or missing) bill amount from a
        # SQL division-by-zero error; those sort last regardless of direction via
        # nulls_last() rather than being dropped.
        margin_expr=MasterAirWaybill.pnl_profit_loss/func.nullif(MasterAirWaybill.pnl_bill_amount,0)
        order=margin_expr.desc().nulls_last()
    else:
        order=MasterAirWaybill.manifest_date.desc()
    items=[mawb_summary(m,db) for m in db.scalars(stmt.order_by(order).limit(limit).offset(offset)).all()]
    return {'items':items,'total':total,'limit':limit,'offset':offset}
def _pnl_range_filter(stmt,manifest_date_from,manifest_date_to):
    if manifest_date_from:stmt=stmt.where(MasterAirWaybill.manifest_date>=manifest_date_from)
    if manifest_date_to:stmt=stmt.where(MasterAirWaybill.manifest_date<=manifest_date_to)
    return stmt
@app.get('/api/v1/mawbs/pnl-summary')
def mawbs_pnl_summary(manifest_date_from:date|None=None,manifest_date_to:date|None=None,db:Session=Depends(get_db),_user:User=Depends(require_role(['admin','sales_lead']))):
    stmt=_pnl_range_filter(select(func.count().label('mawb_count'),func.coalesce(func.sum(MasterAirWaybill.pnl_bill_amount),0).label('bill_amount'),func.coalesce(func.sum(MasterAirWaybill.pnl_ups_bill_amount),0).label('ups_bill_amount'),func.coalesce(func.sum(MasterAirWaybill.pnl_profit_loss),0).label('profit_loss'),func.max(MasterAirWaybill.pnl_synced_at).label('last_synced_at')).where(MasterAirWaybill.pnl_synced_at.is_not(None)),manifest_date_from,manifest_date_to)
    row=dict(db.execute(stmt).mappings().one())
    base=_pnl_range_filter(select(MasterAirWaybill).where(MasterAirWaybill.pnl_synced_at.is_not(None),MasterAirWaybill.pnl_bill_amount>0),manifest_date_from,manifest_date_to)
    best=db.scalar(base.order_by((MasterAirWaybill.pnl_profit_loss/MasterAirWaybill.pnl_bill_amount).desc()).limit(1))
    worst=db.scalar(base.order_by((MasterAirWaybill.pnl_profit_loss/MasterAirWaybill.pnl_bill_amount).asc()).limit(1))
    # Highest-margin-% and highest-dollar-profit are frequently different MAWBs (a huge
    # low-margin manifest can out-earn a small high-margin one in raw dollars) — surfaced
    # as its own card rather than assuming "best margin" already covers it.
    highest_profit=db.scalar(base.order_by(MasterAirWaybill.pnl_profit_loss.desc()).limit(1))
    def mawb_margin_payload(m):
        if not m:return None
        margin=float(m.pnl_profit_loss)/float(m.pnl_bill_amount)*100 if m.pnl_bill_amount else 0
        return {'id':str(m.id),'mawb_number':m.mawb_number,'manifest_date':m.manifest_date,'bill_amount':m.pnl_bill_amount,'ups_bill_amount':m.pnl_ups_bill_amount,'profit_loss':m.pnl_profit_loss,'margin_percent':round(margin,1)}
    row['best_margin_mawb']=mawb_margin_payload(best);row['worst_margin_mawb']=mawb_margin_payload(worst)
    row['highest_profit_mawb']=mawb_margin_payload(highest_profit)
    row['avg_margin_percent']=round(float(row['profit_loss'])/float(row['bill_amount'])*100,1) if row['bill_amount'] else 0
    # Shipments billed to the customer but not yet costed by UPS. Their profit is unknown, not
    # zero — the CRM's own manifest Total excludes them, so they are reported separately rather
    # than folded into margin. See docs/03-data-rules.md rule 7c.
    pending=db.execute(_pnl_range_filter(select(
        func.count().label('awaiting_cost_shipments'),
        func.coalesce(func.sum(Shipment.pnl_bill_amount),0).label('awaiting_cost_bill'),
    ).select_from(Shipment).join(MasterAirWaybill,Shipment.mawb_id==MasterAirWaybill.id).where(
        Shipment.pnl_synced_at.is_not(None),Shipment.pnl_ups_bill_amount.is_(None),Shipment.pnl_bill_amount>0
    ),manifest_date_from,manifest_date_to)).mappings().one()
    row.update(dict(pending))
    row['shipment_detail_available']=bool(db.scalar(_pnl_range_filter(select(func.count()).select_from(Shipment).join(MasterAirWaybill,Shipment.mawb_id==MasterAirWaybill.id).where(Shipment.pnl_synced_at.is_not(None)),manifest_date_from,manifest_date_to)))
    return row
@app.get('/api/v1/mawbs/pnl-trend')
def mawbs_pnl_trend(manifest_date_from:date,manifest_date_to:date,granularity:Literal['day','week','month']='day',db:Session=Depends(get_db),_user:User=Depends(require_role(['admin','sales_lead']))):
    bucket={'day':'day','week':'week','month':'month'}[granularity]
    rows=db.execute(text(f"""
        SELECT date_trunc('{bucket}', manifest_date)::date AS period,
               count(*)::int AS mawb_count,
               coalesce(sum(pnl_bill_amount),0) AS bill_amount,
               coalesce(sum(pnl_ups_bill_amount),0) AS ups_bill_amount,
               coalesce(sum(pnl_profit_loss),0) AS profit_loss
        FROM master_air_waybills
        WHERE pnl_synced_at IS NOT NULL AND manifest_date BETWEEN :date_from AND :date_to
        GROUP BY period ORDER BY period
    """),{'date_from':manifest_date_from,'date_to':manifest_date_to}).mappings().all()
    return [dict(r) for r in rows]
@app.get('/api/v1/mawbs/pnl-routes')
def mawbs_pnl_routes(manifest_date_from:date|None=None,manifest_date_to:date|None=None,limit:int=Query(8,le=1000),db:Session=Depends(get_db),_user:User=Depends(require_role(['admin','sales_lead']))):
    stmt=text("""
        WITH mawb_real_destination AS (
            SELECT m.id,
                   coalesce(
                       (SELECT s.import_country FROM shipments s
                        WHERE s.mawb_id=m.id AND nullif(trim(s.import_country),'') IS NOT NULL
                        GROUP BY s.import_country ORDER BY count(*) DESC LIMIT 1),
                       nullif(trim(m.destination),'')
                   ) AS destination
            FROM master_air_waybills m
        )
        SELECT coalesce(nullif(trim(m.origin),''),'Unknown') || ' → ' || coalesce(d.destination,'Unknown') AS route,
               count(*)::int AS mawb_count,
               coalesce(sum(m.pnl_bill_amount),0) AS bill_amount,
               coalesce(sum(m.pnl_ups_bill_amount),0) AS ups_bill_amount,
               coalesce(sum(m.pnl_profit_loss),0) AS profit_loss
        FROM master_air_waybills m
        JOIN mawb_real_destination d ON d.id=m.id
        WHERE m.pnl_synced_at IS NOT NULL
          AND (CAST(:date_from AS date) IS NULL OR m.manifest_date>=CAST(:date_from AS date))
          AND (CAST(:date_to AS date) IS NULL OR m.manifest_date<=CAST(:date_to AS date))
        GROUP BY route ORDER BY profit_loss DESC LIMIT :limit
    """)
    rows=db.execute(stmt,{'date_from':manifest_date_from,'date_to':manifest_date_to,'limit':limit}).mappings().all()
    return [dict(r) for r in rows]
@app.get('/api/v1/mawbs/by-number/{mawb_number}')
def mawb_by_number(mawb_number:str,db:Session=Depends(get_db)):
    found=db.scalars(select(MasterAirWaybill).where(func.lower(MasterAirWaybill.mawb_number)==mawb_number.strip().casefold()).order_by(MasterAirWaybill.manifest_date.desc())).all()
    if not found:raise HTTPException(404,'Master Air Waybill not found')
    return [mawb_summary(x,db) for x in found]
@app.get('/api/v1/mawbs/{mawb_id}')
def mawb_detail(mawb_id:uuid.UUID,db:Session=Depends(get_db)):
    m=one(db,MasterAirWaybill,mawb_id);shipments=db.scalars(select(Shipment).options(selectinload(Shipment.company),selectinload(Shipment.packages)).where(Shipment.mawb_id==m.id).order_by(Shipment.shipment_number)).all()
    
    prefix = (m.mawb_number or '').split('-')[0] if '-' in (m.mawb_number or '') else (m.mawb_number or '')[:3]
    carrier_names = {
        '607': 'Royal Nepal Airlines (RA)',
        '157': 'Qatar Airways (QR)',
        '176': 'Emirates SkyCargo (EK)',
        '235': 'Turkish Airlines (TK)',
        '160': 'Cathay Pacific Cargo (CX)',
        '098': 'Air India Cargo (AI)',
        '217': 'Thai Airways (TG)',
        '074': 'KLM Cargo (KL)',
    }
    carrier = carrier_names.get(prefix, f"Carrier {prefix}" if prefix.isdigit() else (m.flight_number or "Scheduled Airline"))

    # Keyed on pay_term (the billable classification — PP/FC/FD/NON_REV/RTS), not bill_type
    # (which is a Document/Non-Doc/Letter customs classification and has nothing to do with billing).
    billing_counts = {'PP': {'count': 0, 'weight': 0.0}, 'FC': {'count': 0, 'weight': 0.0}, 'FD': {'count': 0, 'weight': 0.0}, 'NON_REV': {'count': 0, 'weight': 0.0}, 'RTS': {'count': 0, 'weight': 0.0}, 'OTHER': {'count': 0, 'weight': 0.0}}
    for s in shipments:
        pterm = (s.pay_term or '').strip().upper()
        if pterm not in billing_counts:
            pterm = 'OTHER'
        billing_counts[pterm]['count'] += 1
        w = float(s.actual_weight or s.shipment_weight or 0)
        billing_counts[pterm]['weight'] = round(billing_counts[pterm]['weight'] + w, 2)

    def shipment_row(s):
        return serialize(s, {
            'company': serialize(s.company) if s.company else None,
            'package_count': len(s.packages),
            'weight': float(s.actual_weight or s.shipment_weight or 0),
            'revenue': shipment_revenue(s),
        })

    return mawb_summary(m,db)|{
        'shipments':[shipment_row(s) for s in shipments],
        'carrier_name': carrier,
        'billing_breakdown': billing_counts
    }

@app.get('/api/v1/quality-issues/company-conflicts')
def company_conflicts(min_similarity:float=Query(0.6,ge=0.0,le=1.0),limit:int=Query(200,le=500),db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Provisional companies that look like an existing official company.

    Merging is the ONE hard-delete in this system, so this endpoint returns exactly one
    row per provisional company — its single best candidate — plus the evidence a reviewer
    needs to judge it: a similarity score, why it matched, how many other companies matched
    equally well, and how much data the merge would move.

    The previous version emitted one row per (source, candidate) pair with no score and no
    dedupe: a provisional company literally named "Nepal" produced 18 identical-looking
    "Possible Typo -> Master Record" rows, any of which would hard-delete it into an
    unrelated company. Bare prefix matches ("Nepal" vs "Nepal Airlines") are still surfaced
    but score low and are flagged, because they are usually distinct companies, not typos.
    """
    sql = """
    WITH pairs AS (
        SELECT
            c1.id AS source_id, c1.icris_number AS source_icris_number,
            c1.company_name AS source_company_name, c1.created_at AS source_created_at,
            c2.id AS target_id, c2.icris_number AS target_icris_number,
            c2.company_name AS target_company_name,
            similarity(c1.normalized_name, c2.normalized_name) AS score,
            CASE
                WHEN c1.normalized_name = c2.normalized_name THEN 'exact_name'
                WHEN c1.normalized_name LIKE c2.normalized_name || ' %'
                  OR c2.normalized_name LIKE c1.normalized_name || ' %' THEN 'prefix'
                ELSE 'fuzzy'
            END AS match_reason
        FROM companies c1
        JOIN companies c2
          ON c1.id <> c2.id
         AND (c1.normalized_name = c2.normalized_name
              OR c1.normalized_name LIKE c2.normalized_name || ' %'
              OR c2.normalized_name LIKE c1.normalized_name || ' %'
              OR similarity(c1.normalized_name, c2.normalized_name) > :min_similarity)
        WHERE c1.is_provisional = true
          AND c2.is_provisional = false
          AND c1.status <> 'archived' AND c2.status <> 'archived'
    ), ranked AS (
        SELECT p.*,
               count(*) OVER (PARTITION BY p.source_id) AS candidate_count,
               row_number() OVER (
                   PARTITION BY p.source_id
                   ORDER BY CASE p.match_reason WHEN 'exact_name' THEN 0 WHEN 'fuzzy' THEN 1 ELSE 2 END,
                            p.score DESC, p.target_company_name
               ) AS rn
        FROM pairs p
    )
    SELECT r.source_id, r.source_icris_number, r.source_company_name, r.source_created_at,
           r.target_id, r.target_icris_number, r.target_company_name,
           round(r.score::numeric, 3)::float AS score, r.match_reason,
           (r.candidate_count - 1)::int AS other_candidates,
           (SELECT count(*) FROM shipments s WHERE s.company_id = r.source_id)::int AS source_shipment_count,
           (SELECT count(*) FROM shipments s WHERE s.company_id = r.target_id)::int AS target_shipment_count,
           (SELECT count(*) FROM company_documents d WHERE d.company_id = r.source_id AND d.status <> 'archived')::int AS source_document_count
    FROM ranked r
    WHERE r.rn = 1
    ORDER BY CASE r.match_reason WHEN 'exact_name' THEN 0 WHEN 'fuzzy' THEN 1 ELSE 2 END,
             r.score DESC, r.source_created_at DESC
    LIMIT :limit
    """
    items = rows(db, sql, {'min_similarity': min_similarity, 'limit': limit})
    for it in items:
        # 'exact_name' is the only reason safe enough to merge without reading the two names.
        # Everything else is a suggestion — an ambiguous source (other_candidates > 0) never is.
        it['confidence'] = (
            'high' if it['match_reason'] == 'exact_name' and it['other_candidates'] == 0
            else 'low' if it['match_reason'] == 'prefix' or it['other_candidates'] > 0 or (it['score'] or 0) < 0.6
            else 'medium'
        )
    return items

@app.post('/api/v1/companies/{source_id}/merge/{target_id}')
def merge_companies(source_id:uuid.UUID, target_id:uuid.UUID, db:Session=Depends(get_db), admin:User=Depends(require_role('super_admin'))):
    source = one(db, Company, source_id)
    target = one(db, Company, target_id)
    if source.id == target.id: raise HTTPException(400, "Cannot merge into self")

    # Rule 3 (docs/03-data-rules.md): manual links are never overwritten by an automated
    # process. Merge is a human-triggered action, but a manually-linked shipment on the
    # source company was manually linked to THAT company specifically -- silently moving
    # it to target on someone else's merge click is the one place this rule used to be
    # bypassed. Those shipments stay on source; source is archived rather than deleted
    # (below) so they keep pointing at a real, still-queryable company row.
    reassigned = db.execute(update(Shipment).where(Shipment.company_id == source.id, Shipment.manually_matched == False, Shipment.is_manually_matched == False).values(company_id=target.id)).rowcount
    preserved_manual = db.scalar(select(func.count()).select_from(Shipment).where(Shipment.company_id == source.id, or_(Shipment.manually_matched == True, Shipment.is_manually_matched == True)))
    db.execute(update(CompanyDocument).where(CompanyDocument.company_id == source.id).values(company_id=target.id))
    db.execute(update(DataQualityIssue).where(DataQualityIssue.company_id == source.id).values(company_id=target.id))
    db.execute(update(ActivityLog).where(ActivityLog.entity_id == source.id).values(entity_id=target.id))

    if not db.scalar(select(CompanyAlias).where(CompanyAlias.company_id == target.id, CompanyAlias.normalized_alias_name == source.normalized_name)):
        db.add(CompanyAlias(company_id=target.id, alias_name=source.company_name, normalized_alias_name=source.normalized_name))

    # Archival, not a hard delete -- rule 11 (docs/03-data-rules.md): deletion is archival
    # everywhere else in the app; this was the one exception. Archiving also means the
    # manually-matched shipments preserved above keep a valid, inspectable company row.
    source.status = 'archived'
    log_activity(db, 'company', target.id, 'merged', f'Merged {source.company_name} ({source.icris_number}) into {target.company_name} ({target.icris_number}) by {admin.email}: {reassigned} shipment(s) reassigned, {preserved_manual} manually-matched shipment(s) left on the archived source', metadata={'source_id': str(source.id), 'target_id': str(target.id), 'reassigned_shipments': reassigned, 'preserved_manual_shipments': preserved_manual})
    commit(db)
    return {"status": "success", "reassigned_shipments": reassigned, "preserved_manual_shipments": preserved_manual}

ISSUE_STATUSES={'open','reviewed','resolved','ignored'}

@app.get('/api/v1/data-quality/summary')
def quality_summary(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Aggregate rollup of the data_quality_issues table.

    The inbox holds tens of thousands of rows (one per offending shipment), so a reviewer
    needs counts by type before any list is useful.
    """
    by_type=rows(db,"""
        SELECT issue_type,
               max(severity) AS severity,
               count(*) FILTER (WHERE status='open')::int      AS open_count,
               count(*) FILTER (WHERE status='reviewed')::int  AS reviewed_count,
               count(*) FILTER (WHERE status='resolved')::int  AS resolved_count,
               count(*) FILTER (WHERE status='ignored')::int   AS ignored_count,
               count(*)::int                                   AS total_count,
               count(DISTINCT company_id) FILTER (WHERE company_id IS NOT NULL)::int AS affected_companies,
               max(last_seen_at) AS last_seen_at
        FROM data_quality_issues
        GROUP BY issue_type
        ORDER BY count(*) FILTER (WHERE status='open') DESC, count(*) DESC
    """)
    totals=db.execute(text("""
        SELECT count(*)::int total,
               count(*) FILTER (WHERE status='open')::int open,
               count(*) FILTER (WHERE severity='error' AND status='open')::int open_errors,
               count(*) FILTER (WHERE severity='warning' AND status='open')::int open_warnings,
               count(*) FILTER (WHERE status IN ('resolved','ignored'))::int closed,
               count(DISTINCT company_id) FILTER (WHERE status='open' AND company_id IS NOT NULL)::int affected_companies,
               count(DISTINCT shipment_id) FILTER (WHERE status='open' AND shipment_id IS NOT NULL)::int affected_shipments
        FROM data_quality_issues
    """)).mappings().one()
    top_companies=rows(db,"""
        SELECT coalesce(c.company_name, i.source_company_name, 'Unlinked') AS company_name,
               c.id AS company_id, c.icris_number,
               count(*)::int AS open_count
        FROM data_quality_issues i
        LEFT JOIN companies c ON c.id = i.company_id
        WHERE i.status = 'open'
        GROUP BY c.id, c.company_name, c.icris_number, i.source_company_name
        ORDER BY count(*) DESC
        LIMIT 10
    """)
    # ICRIS Number Mismatch and Blank ICRIS are only truly "self-resolving" within the
    # normal accounts->CRM billing lag. Past ICRIS_BUFFER_DAYS neither is resolving on its
    # own — it's stuck, and (unlike the rest of this rollup) it's worth knowing how much
    # real revenue that represents, since these are otherwise invisible in every
    # customer-facing report. crm_icris_not_in_master is deliberately excluded — it isn't
    # waiting on accounting, it's waiting on a company-master import.
    icris_buffer_age=rows(db,f"""
        SELECT
          CASE WHEN s.shipment_date >= current_date - interval '{ICRIS_BUFFER_DAYS} days' THEN 'pending' ELSE 'stuck' END AS state,
          count(*)::int AS open_count,
          coalesce(sum({REVENUE_AMOUNT_SQL}),0)::float AS revenue_at_risk
        FROM data_quality_issues i
        JOIN shipments s ON s.id = i.shipment_id
        WHERE i.issue_type IN ('crm_blank_icris','crm_invalid_icris') AND i.status='open' AND s.shipment_date IS NOT NULL
        GROUP BY 1
    """)
    # Counts companies.is_provisional directly rather than the crm_icris_not_in_master issue
    # log: most provisional companies never got an issue row in the first place (the
    # customer_clean_list import path creates them without calling issue() at all, and older
    # crm_scrape-created ones predate that call), so the issue log undercounts badly. The
    # provisional flag itself is promoted/cleared by company_imports.py and is the only
    # reliable source of "still pending the customer master."
    icris_not_in_master=db.execute(text("SELECT count(*)::int FROM companies WHERE is_provisional=true")).scalar()
    return {'totals':dict(totals),'by_type':by_type,'top_companies':top_companies,'icris_buffer_age':icris_buffer_age,'icris_buffer_days':ICRIS_BUFFER_DAYS,'icris_not_in_master_open':icris_not_in_master}

@app.get('/api/v1/data-quality/issues')
def quality_issues(issue_type:str|None=None,severity:str|None=None,status:str|None=None,company_id:uuid.UUID|None=None,shipment_id:uuid.UUID|None=None,mawb_id:uuid.UUID|None=None,sync_run_id:uuid.UUID|None=None,q:str|None=None,icris_buffer_state:str|None=None,sort:str|None=None,limit:int=Query(100,le=500),offset:int=0,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Raw SQL rather than the ORM here specifically so ICRIS-buffer age and revenue at
    risk — both derived from the linked shipment, not stored columns — can be computed,
    filtered, and sorted on directly in the database instead of paginating in Python."""
    where=['1=1'];args:dict={}
    for field,value in [('severity',severity),('status',status),('company_id',company_id),('shipment_id',shipment_id),('mawb_id',mawb_id),('sync_run_id',sync_run_id)]:
        if value is not None:where.append(f'i.{field}=:{field}');args[field]=value
    if issue_type:
        # Comma-separated so the frontend can default the Issues tab to just the
        # ICRIS-buffer types (its priority-banner scope) without a second round trip.
        types=[t.strip() for t in issue_type.split(',') if t.strip()]
        if types:where.append('i.issue_type = ANY(:issue_types)');args['issue_types']=types
    if q and q.strip():
        where.append("(i.source_company_name ILIKE :q ESCAPE '\\' OR i.source_icris_number ILIKE :q ESCAPE '\\')")
        args['q']=f'%{escape_like(q.strip())}%'
    if icris_buffer_state in ('pending','stuck'):
        where.append(f"i.issue_type IN ('crm_blank_icris','crm_invalid_icris') AND s.shipment_date IS NOT NULL AND (CASE WHEN s.shipment_date >= current_date - interval '{ICRIS_BUFFER_DAYS} days' THEN 'pending' ELSE 'stuck' END)=:icris_buffer_state")
        args['icris_buffer_state']=icris_buffer_state
    where_sql=' AND '.join(where)
    order_sql='revenue_at_risk DESC NULLS LAST, i.last_seen_at DESC' if sort=='revenue' else 'i.last_seen_at DESC'
    base_from=f"FROM data_quality_issues i LEFT JOIN shipments s ON s.id = i.shipment_id WHERE {where_sql}"
    total=db.execute(text(f"SELECT count(*)::int {base_from}"),args).scalar()
    items=rows(db,f"""
        SELECT i.*,
               s.shipment_date AS linked_shipment_date,
               CASE WHEN i.issue_type IN ('crm_blank_icris','crm_invalid_icris') AND s.shipment_date IS NOT NULL
                    THEN (CASE WHEN s.shipment_date >= current_date - interval '{ICRIS_BUFFER_DAYS} days' THEN 'pending' ELSE 'stuck' END) END AS icris_buffer_state,
               coalesce({REVENUE_AMOUNT_SQL},0)::float AS revenue_at_risk
        {base_from}
        ORDER BY {order_sql}
        LIMIT :limit OFFSET :offset
    """,{**args,'limit':limit,'offset':offset})
    return {'items':items,'total':total,'limit':limit,'offset':offset}

@app.get('/api/v1/data-quality/resolution-log')
def quality_resolution_log(issue_type:str|None=None,resolved_by:str|None=None,days:int=Query(30,ge=1,le=365),limit:int=Query(100,le=500),offset:int=0,db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Before/after view of resolved issues — "before" is what the issue captured at
    creation time (source_icris_number/source_company_name, already stored, never
    mutated), "after" is the linked shipment's/company's current real state. No
    separate log table: everything needed already lives on data_quality_issues plus a
    live join, so there's nothing to keep in sync by hand."""
    where=["i.status='resolved'","i.resolved_at >= current_date - make_interval(days => :days)"]
    args:dict={'days':days,'limit':limit,'offset':offset}
    if issue_type:where.append('i.issue_type=:issue_type');args['issue_type']=issue_type
    if resolved_by:where.append('i.resolved_by=:resolved_by');args['resolved_by']=resolved_by
    where_sql=' AND '.join(where)
    base_from=f"""
        FROM data_quality_issues i
        LEFT JOIN shipments s ON s.id = i.shipment_id
        LEFT JOIN companies after_c ON after_c.id = coalesce(s.company_id, i.company_id)
        WHERE {where_sql}
    """
    total=db.execute(text(f"SELECT count(*)::int {base_from}"),args).scalar()
    items=rows(db,f"""
        SELECT i.id, i.issue_type, i.resolved_by, i.first_seen_at, i.resolved_at,
               i.source_icris_number AS before_icris, i.source_company_name AS before_company_name,
               after_c.icris_number AS after_icris, after_c.company_name AS after_company_name, after_c.is_provisional AS after_is_provisional,
               EXTRACT(EPOCH FROM (i.resolved_at - i.first_seen_at))/86400.0 AS days_to_resolve
        {base_from}
        ORDER BY i.resolved_at DESC
        LIMIT :limit OFFSET :offset
    """,args)
    return {'items':items,'total':total,'limit':limit,'offset':offset}

class QualityBulkPatch(BaseModel):
    status:str
    issue_type:str|None=None
    severity:str|None=None
    current_status:str|None=None
    company_id:uuid.UUID|None=None
    ids:list[uuid.UUID]|None=None
    reason:str|None=None

@app.post('/api/v1/data-quality/issues/bulk-status')
def bulk_patch_quality(body:QualityBulkPatch,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    """Resolve/ignore issues in bulk. A single blank-ICRIS defect can span thousands of
    shipment rows, so clearing them one PATCH at a time is not a usable workflow."""
    if body.status not in ISSUE_STATUSES:raise HTTPException(422,'Invalid issue status')
    if not body.ids and not any([body.issue_type,body.severity,body.current_status,body.company_id]):
        raise HTTPException(422,'Provide ids or at least one filter — refusing to update every issue')
    stmt=update(DataQualityIssue)
    if body.ids:stmt=stmt.where(DataQualityIssue.id.in_(body.ids))
    for field,value in [('severity',body.severity),('status',body.current_status),('company_id',body.company_id)]:
        if value is not None:stmt=stmt.where(getattr(DataQualityIssue,field)==value)
    if body.issue_type:
        types=[t.strip() for t in body.issue_type.split(',') if t.strip()]
        if types:stmt=stmt.where(DataQualityIssue.issue_type.in_(types))
    values={'status':body.status,'resolved_at':now() if body.status in {'resolved','ignored'} else None,'resolved_by':admin.email if body.status in {'resolved','ignored'} else None}
    updated=db.execute(stmt.values(**values)).rowcount
    commit(db)
    return {'status':'success','updated':updated}
@app.patch('/api/v1/data-quality/issues/{issue_id}')
def patch_quality(issue_id:uuid.UUID,body:QualityPatch,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    if body.status not in {'open','reviewed','resolved','ignored'}:raise HTTPException(422,'Invalid issue status')
    item=one(db,DataQualityIssue,issue_id);item.status=body.status;item.resolved_at=now() if body.status in {'resolved','ignored'} else None
    item.resolved_by=admin.email if body.status in {'resolved','ignored'} else None
    if body.reason:item.details_json={**(item.details_json or {}),'resolution_reason':body.reason}
    commit(db);return serialize(item)
@app.post('/api/v1/data-quality/issues/{issue_id}/fix')
def fix_quality(issue_id:uuid.UUID,body:QualityFixIn,db:Session=Depends(get_db),admin:User=Depends(require_role('super_admin'))):
    """Applies the actual data correction for an issue, then resolves it in the same
    transaction — the two must not drift apart (data fixed but issue still open, or
    resolved with nothing actually changed)."""
    item=one(db,DataQualityIssue,issue_id)
    if body.action=='assign_company':
        if item.issue_type not in {'crm_blank_icris','crm_invalid_icris'}:raise HTTPException(422,f'assign_company does not apply to {item.issue_type}')
        if not item.shipment_id or not body.company_id:raise HTTPException(422,'shipment_id on issue and company_id are required')
        s=one(db,Shipment,item.shipment_id);one(db,Company,body.company_id)
        s.company_id=body.company_id;s.match_status='manually_linked';s.matched_by_method='manual';s.manually_matched=True;s.is_manually_matched=True
        for sibling in db.scalars(select(DataQualityIssue).where(DataQualityIssue.shipment_id==s.id,DataQualityIssue.issue_type.in_({'crm_blank_icris','crm_invalid_icris'}),DataQualityIssue.status=='open')).all():
            sibling.status='resolved';sibling.resolved_at=now();sibling.resolved_by=admin.email
    elif body.action=='set_field':
        if item.issue_type not in {'crm_numeric_parse_error','crm_missing_pay_term','crm_missing_bill_type'}:raise HTTPException(422,f'set_field does not apply to {item.issue_type}')
        if not item.shipment_id or not body.field or body.value is None:raise HTTPException(422,'shipment_id on issue, field and value are required')
        s=one(db,Shipment,item.shipment_id);allowed={c.name for c in Shipment.__table__.columns}-{'id','shipment_number','created_at','updated_at'}
        if body.field not in allowed:raise HTTPException(422,f'Unknown or protected field: {body.field}')
        setattr(s,body.field,body.value);overrides=set(s.manual_override_fields or []);overrides.add(body.field);s.manual_override_fields=sorted(overrides)
    elif body.action=='save_alias':
        if item.issue_type!='crm_customer_name_mismatch':raise HTTPException(422,f'save_alias does not apply to {item.issue_type}')
        if not item.company_id:raise HTTPException(422,'issue has no company_id')
        c=one(db,Company,item.company_id);_add_alias(db,c,item.source_company_name)
    elif body.action=='rename_company':
        if item.issue_type not in {'crm_customer_name_mismatch','company_master_name_conflict'}:raise HTTPException(422,f'rename_company does not apply to {item.issue_type}')
        if not item.company_id or not body.company_name:raise HTTPException(422,'issue has no company_id, or company_name missing')
        c=one(db,Company,item.company_id);c.company_name=body.company_name.strip();c.normalized_name=normalize_name(c.company_name)
        overrides=set(c.manual_override_fields or []);overrides.add('company_name');c.manual_override_fields=sorted(overrides)
    elif body.action=='merge':
        if item.issue_type!='crm_icris_not_in_master':raise HTTPException(422,f'merge does not apply to {item.issue_type}')
        if not item.company_id or not body.target_id:raise HTTPException(422,'issue has no company_id, or target_id missing')
        merge_companies(item.company_id,body.target_id,db)
    elif body.action=='acknowledge':
        pass
    item.status='resolved';item.resolved_at=now();item.resolved_by=admin.email
    commit(db);return serialize(item)

@app.post('/api/v1/admin/customers/recompute-segments')
def recompute_customer_segments_endpoint(db:Session=Depends(get_db),user=Depends(require_role('super_admin'))):
    """Applies the rule in docs/customer-segmentation-rules.md to every company right
    now. Not yet wired to auto-run after CRM sync (that runs in a separate worker
    process/container that intentionally doesn't import this module, to avoid a second
    copy of REVENUE_AMOUNT_SQL drifting from this one) — admin-triggered only for now."""
    counts=recompute_customer_segments(db,REVENUE_AMOUNT_SQL)
    return {'tier_counts':counts}

@app.post('/api/v1/admin/tier-alerts/send-emails')
def send_tier_alert_emails_endpoint(db:Session=Depends(get_db),user=Depends(require_role('super_admin'))):
    """Manual trigger for the Resend digest that otherwise runs on
    tier_alert_email_schedule_cron inside the crm-scraper worker. Useful for testing and
    for 'send it right now' outside the schedule. Returns a summary even when sending is
    disabled (tier_alert_email_enabled=False or no RESEND_API_KEY configured) so an admin
    can see what's pending without needing Resend configured yet."""
    return send_tier_alert_digests(db)

@app.post('/api/v1/admin/weekly-report/send')
def send_weekly_report_endpoint(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    """Manual trigger for the weekly report email that otherwise fires on Monday 10 AM NPT.
    Returns a summary dict even when disabled, so you can test without SMTP configured."""
    return send_weekly_report(db)

@app.post('/api/v1/admin/backup')
def trigger_admin_backup(db:Session=Depends(get_db),_role:User=Depends(require_role('super_admin'))):
    import os,tarfile,shutil,json
    backup_dir="/data/backups"
    os.makedirs(backup_dir,exist_ok=True)
    timestamp=now().strftime("%Y%m%d_%H%M%S")
    bundle_name=f"customer360_backup_{timestamp}"
    archive_path=os.path.join(backup_dir,f"{bundle_name}.tar.gz")
    counts={
        'companies':db.scalar(select(func.count()).select_from(Company)),
        'shipments':db.scalar(select(func.count()).select_from(Shipment)),
        'mawbs':db.scalar(select(func.count()).select_from(MasterAirWaybill)),
        'packages':db.scalar(select(func.count()).select_from(Package)),
        'documents':db.scalar(select(func.count()).select_from(CompanyDocument))
    }
    temp_dir=os.path.join(backup_dir,bundle_name)
    os.makedirs(temp_dir,exist_ok=True)
    manifest_file=os.path.join(temp_dir,'manifest.json')
    with open(manifest_file,'w',encoding='utf-8') as f:
        json.dump({'timestamp':timestamp,'created_at':now().isoformat(),'row_counts':counts},f,indent=2)
    with tarfile.open(archive_path,"w:gz") as tar:
        tar.add(manifest_file,arcname=f"{bundle_name}/manifest.json")
        if os.path.exists("/data/company-documents"):
            tar.add("/data/company-documents",arcname=f"{bundle_name}/company_documents")
    shutil.rmtree(temp_dir,ignore_errors=True)
    file_size=os.path.getsize(archive_path) if os.path.exists(archive_path) else 0
    return {'filename':f"{bundle_name}.tar.gz",'archive_path':archive_path,'size_bytes':file_size,'timestamp':timestamp,'manifest':counts}

@app.get('/api/v1/admin/backups')
def list_admin_backups(_role:User=Depends(require_role('super_admin'))):
    import os
    backup_dir="/data/backups"
    os.makedirs(backup_dir,exist_ok=True)
    items=[]
    for fname in sorted(os.listdir(backup_dir),reverse=True):
        if fname.endswith('.tar.gz'):
            fpath=os.path.join(backup_dir,fname)
            stat=os.stat(fpath)
            items.append({'filename':fname,'size_bytes':stat.st_size,'created_at':datetime.fromtimestamp(stat.st_mtime).isoformat()})
    return items

@app.get('/api/v1/admin/backups/{filename}/download')
def download_admin_backup(filename:str,_role:User=Depends(require_role('super_admin'))):
    import os
    from fastapi.responses import FileResponse
    clean_name=os.path.basename(filename)
    fpath=os.path.join("/data/backups",clean_name)
    if not os.path.isfile(fpath):
        raise HTTPException(404,"Backup archive not found")
    return FileResponse(fpath,filename=clean_name,media_type="application/gzip")


@app.get('/api/v1/analytics/geography')
def geography_analytics(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    country:str|None=None,
    origin:str|None=None,
    destination:str|None=None,
    ae_code:str|None=None,
    segment:str|None=None,
    export_only:bool=Query(False),
    destinations_limit:int=Query(20,le=1000),
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    from datetime import date as _date,datetime as _datetime
    if ae_scope:ae_code=ae_scope
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)
    is_all_time=timeframe=='all_time'

    # Current period shipments
    sql_base = f"""
        SELECT s.id, s.company_id, c.company_name, c.icris_number,
               s.shipment_date, coalesce(nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.pieces, 1)::int pieces, coalesce(s.shipment_weight, s.actual_weight, 0)::float weight,
               coalesce(s.import_country, 'Unknown') import_country,
               coalesce(s.export_country, 'Unknown') export_country,
               m.origin as mawb_origin, m.destination as mawb_destination
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        LEFT JOIN master_air_waybills m ON m.id=s.mawb_id
        WHERE ((:is_all = true) OR (
            (s.shipment_date IS NOT NULL AND s.shipment_date >= :c_start AND s.shipment_date <= :c_end) OR
            (s.shipment_date IS NULL AND s.created_at::date >= :c_start AND s.created_at::date <= :c_end)
        ))
    """
    params = {'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end}
    cur_rows = rows(db, sql_base, params)

    prev_rows = []
    if not is_all_time:
        p_params = {'is_all': False, 'c_start': p_start, 'c_end': p_end}
        prev_rows = rows(db, sql_base, p_params)

    def apply_filters(rows_list):
        filtered = []
        for r in rows_list:
            if country:
                c_targets = {t.strip().lower() for t in country.split(',')}
                if not any(t in (r['import_country'] or '').lower() or t in (r['export_country'] or '').lower() for t in c_targets):
                    continue
            if origin:
                o_targets = {t.strip().lower() for t in origin.split(',')}
                if not any(t in (r['mawb_origin'] or '').lower() for t in o_targets):
                    continue
            if destination:
                d_targets = {t.strip().lower() for t in destination.split(',')}
                if not any(t in (r['mawb_destination'] or '').lower() for t in d_targets):
                    continue
            if ae_code:
                ae_targets = {a.strip().lower() for a in ae_code.split(',')}
                if not any(a in (r['ae_code'] or '').lower() for a in ae_targets):
                    continue
            if export_only and str(r['import_country']).lower() == 'nepal':
                continue
            filtered.append(r)
        return filtered

    cur_filtered = apply_filters(cur_rows)
    prev_filtered = apply_filters(prev_rows)

    def calc_metrics(data):
        total_rev = sum(r['amount'] for r in data)
        total_ship = len(data)
        total_wt = sum(r['weight'] for r in data)
        import_countries = {r['import_country'] for r in data if str(r['import_country']).lower() != 'nepal'}
        origins = {r['mawb_origin'] for r in data if r['mawb_origin']}
        destinations = {r['mawb_destination'] for r in data if r['mawb_destination']}
        return total_rev, total_ship, total_wt, import_countries, origins, destinations

    c_rev, c_ship, c_wt, c_ic, c_orig, c_dest = calc_metrics(cur_filtered)
    p_rev, p_ship, p_wt, p_ic, p_orig, p_dest = calc_metrics(prev_filtered)

    kpis = {
        'countries_served': {'value': len(c_ic), 'pop_pct': calc_pop(len(c_ic), len(p_ic))},
        'origins': {'value': len(c_orig), 'pop_pct': calc_pop(len(c_orig), len(p_orig))},
        'destinations': {'value': len(c_dest), 'pop_pct': calc_pop(len(c_dest), len(p_dest))},
        'international_revenue': {'value': c_rev, 'pop_pct': calc_pop(c_rev, p_rev)},
        'total_shipments': {'value': c_ship, 'pop_pct': calc_pop(c_ship, p_ship)},
        'total_weight': {'value': c_wt, 'pop_pct': calc_pop(c_wt, p_wt)},
        'avg_revenue_per_country': {'value': c_rev / max(1, len(c_ic)), 'pop_pct': calc_pop(c_rev / max(1, len(c_ic)), p_rev / max(1, len(p_ic)))},
        'avg_shipments_per_country': {'value': c_ship / max(1, len(c_ic)), 'pop_pct': calc_pop(c_ship / max(1, len(c_ic)), p_ship / max(1, len(p_ic)))}
    }

    # Case-fold the grouping key everywhere below (M-12): 'HK' and 'hk' are the same
    # destination and must not split into separate buckets just because of casing.
    def _fold(v):
        return str(v).strip().upper() if v else v

    country_map = {}
    for r in cur_filtered:
        cnt = _fold(r['import_country'])
        if str(cnt).lower() == 'nepal':
            cnt = _fold(r['export_country']) # use export if import is nepal
        if not cnt or str(cnt).lower() == 'unknown':
            continue
        if cnt not in country_map:
            country_map[cnt] = {'name': cnt, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        country_map[cnt]['revenue'] += r['amount']
        country_map[cnt]['shipments'] += 1
        country_map[cnt]['weight'] += r['weight']
        country_map[cnt]['customers'].add(r['company_id'])

    revenue_by_country = sorted([{'name': v['name'], 'value': round(v['revenue'], 2)} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    shipments_by_country = sorted([{'name': v['name'], 'value': v['shipments']} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    weight_by_country = sorted([{'name': v['name'], 'value': round(v['weight'], 2)} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    country_distribution = revenue_by_country

    dest_map = {}
    for r in cur_filtered:
        # The shipment's own import_country is the real (consignee) destination; the MAWB's
        # destination field is just the flight's transit airport (and is dirty in the source
        # data besides). Prefer import_country, falling back only when it's missing.
        dst = _fold(r['import_country']) if r['import_country'] and str(r['import_country']).lower() != 'unknown' else _fold(r['mawb_destination'])
        if not dst or str(dst).lower() == 'unknown': continue
        if dst not in dest_map:
            dest_map[dst] = {'name': dst, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        dest_map[dst]['revenue'] += r['amount']
        dest_map[dst]['shipments'] += 1
        dest_map[dst]['weight'] += r['weight']
        dest_map[dst]['customers'].add(r['company_id'])
    
    top_destinations = sorted([
        {'destination': v['name'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'],
         'weight': round(v['weight'], 2), 'customers': len(v['customers']), 'growth_pct': 0.0}
        for v in dest_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:destinations_limit]

    orig_map = {}
    for r in cur_filtered:
        org = _fold(r['mawb_origin'] or r['export_country'])
        if not org or str(org).lower() == 'unknown': continue
        if org not in orig_map:
            orig_map[org] = {'name': org, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        orig_map[org]['revenue'] += r['amount']
        orig_map[org]['shipments'] += 1
        orig_map[org]['weight'] += r['weight']
        orig_map[org]['customers'].add(r['company_id'])
    
    top_origins = sorted([
        {'origin': v['name'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 
         'weight': round(v['weight'], 2), 'customers': len(v['customers'])} 
        for v in orig_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    trade_lanes_map = {}
    for r in cur_filtered:
        org = _fold(r['mawb_origin'] or r['export_country'] or 'Unknown')
        dst = _fold(r['mawb_destination'] or r['import_country'] or 'Unknown')
        lane = f"{org} -> {dst}"
        if lane not in trade_lanes_map:
            trade_lanes_map[lane] = {'origin': org, 'destination': dst, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
        trade_lanes_map[lane]['revenue'] += r['amount']
        trade_lanes_map[lane]['shipments'] += 1
        trade_lanes_map[lane]['weight'] += r['weight']

    trade_lanes = sorted([
        {'origin': v['origin'], 'destination': v['destination'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2)}
        for v in trade_lanes_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    customers_by_country = []
    for cnt, data in country_map.items():
        customers_by_country.append({
            'country': cnt,
            'customers': len(data['customers']),
            'strategic': 0, 'large': 0, 'sme': 0, 'small': len(data['customers']),
            'revenue': round(data['revenue'], 2),
            'shipments': data['shipments'],
            'weight': round(data['weight'], 2),
        })
    customers_by_country = sorted(customers_by_country, key=lambda x: x['revenue'], reverse=True)

    export_map = {}
    import_map = {}
    for r in cur_filtered:
        if str(r['export_country']).lower() != 'nepal':
            exp = r['export_country'] or 'Unknown'
            if exp not in export_map: export_map[exp] = {'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
            export_map[exp]['revenue'] += r['amount']
            export_map[exp]['shipments'] += 1
            export_map[exp]['weight'] += r['weight']
        
        imp = r['import_country']
        if str(imp).lower() != 'nepal':
            imp = imp or 'Unknown'
            if imp not in import_map: import_map[imp] = {'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
            import_map[imp]['revenue'] += r['amount']
            import_map[imp]['shipments'] += 1
            import_map[imp]['weight'] += r['weight']

    top_export_countries = sorted([
        {'country': k, 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2), 'avg_shipment_value': round(v['revenue']/max(1, v['shipments']), 2)}
        for k, v in export_map.items()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    top_import_countries = sorted([
        {'country': k, 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2), 'avg_shipment_value': round(v['revenue']/max(1, v['shipments']), 2)}
        for k, v in import_map.items()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    country_performance = sorted([
        {'country': v['name'], 'revenue': round(v['revenue'], 2), 'growth_pct': 0.0, 'shipment_growth': 0.0, 'weight_growth': 0.0, 'customer_growth': 0.0}
        for v in country_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    return {
        'timeframe': timeframe,
        'bounds': {'c_start': str(c_start), 'c_end': str(c_end), 'p_start': str(p_start), 'p_end': str(p_end)},
        'kpi_cards': kpis,
        'revenue_by_country': revenue_by_country,
        'shipments_by_country': shipments_by_country,
        'weight_by_country': weight_by_country,
        'top_destinations': top_destinations,
        'top_origins': top_origins,
        'trade_lanes': trade_lanes,
        'country_distribution': country_distribution,
        'customers_by_country': customers_by_country,
        'top_export_countries': top_export_countries,
        'top_import_countries': top_import_countries,
        'country_performance': country_performance,
        'geographic_growth': []
    }


# CRM's own 'Bill Type' column classifies every shipment as content, not payment method —
# distinct from pay_term (PP/FC/FD). 'Letter' is a vanishingly rare fourth value (4 rows
# seen historically) that is document content just like 'Document'; anything blank is kept
# as its own 'unclassified' bucket rather than guessed into either side.
def _doc_type_bucket(bill_type:str|None)->str:
    bt=(bill_type or '').strip()
    if bt in ('Document','Letter'):return 'doc'
    if bt=='Non-Doc':return 'non_doc'
    return 'unclassified'

@app.get('/api/v1/analytics/document-type')
def document_type_analytics(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    ae_code:str|None=None,
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    if ae_scope:ae_code=ae_scope
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)
    is_all_time=timeframe=='all_time'

    sql_base = f"""
        SELECT s.id, s.company_id, c.company_name,
               s.shipment_date, s.bill_type, coalesce(nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               coalesce(nullif(s.import_country,''), 'Unknown') destination,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.shipment_weight, s.actual_weight, 0)::float weight
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        WHERE ((:is_all = true) OR (s.shipment_date >= :c_start AND s.shipment_date <= :c_end))
    """
    cur_rows = rows(db, sql_base, {'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end})
    prev_rows = [] if is_all_time else rows(db, sql_base, {'is_all': False, 'c_start': p_start, 'c_end': p_end})

    def apply_filters(rows_list):
        if not ae_code:return rows_list
        targets={a.strip().lower() for a in ae_code.split(',')}
        return [r for r in rows_list if (r['ae_code'] or '').lower() in targets]

    cur_filtered=apply_filters(cur_rows)
    prev_filtered=apply_filters(prev_rows)
    for r in cur_filtered:r['bucket']=_doc_type_bucket(r['bill_type'])
    for r in prev_filtered:r['bucket']=_doc_type_bucket(r['bill_type'])

    def bucket_metrics(data,bucket):
        rows_in=[r for r in data if r['bucket']==bucket]
        rev=sum(r['amount'] for r in rows_in);ship=len(rows_in);wt=sum(r['weight'] for r in rows_in)
        return rev,ship,wt

    kpis={}
    for bucket in ('doc','non_doc','unclassified'):
        c_rev,c_ship,c_wt=bucket_metrics(cur_filtered,bucket)
        p_rev,p_ship,p_wt=bucket_metrics(prev_filtered,bucket)
        kpis[bucket]={
            'shipments':{'value':c_ship,'pop_pct':calc_pop(c_ship,p_ship)},
            'revenue':{'value':round(c_rev,2),'pop_pct':calc_pop(c_rev,p_rev)},
            'weight':{'value':round(c_wt,2),'pop_pct':calc_pop(c_wt,p_wt)},
            'avg_revenue_per_shipment':{'value':round(c_rev/max(1,c_ship),2),'pop_pct':calc_pop(c_rev/max(1,c_ship),p_rev/max(1,p_ship))},
        }

    trend_map={}
    for r in cur_filtered:
        if not r['shipment_date']:continue
        period=str(r['shipment_date'])
        if period not in trend_map:trend_map[period]={'doc':0.0,'non_doc':0.0,'unclassified':0.0,'doc_count':0,'non_doc_count':0,'unclassified_count':0}
        trend_map[period][r['bucket']]+=r['amount']
        trend_map[period][f"{r['bucket']}_count"]+=1
    trend=[{'period':k,**v} for k,v in sorted(trend_map.items())]

    customer_map={}
    for r in cur_filtered:
        if not r['company_id']:continue
        key=r['company_id']
        if key not in customer_map:customer_map[key]={'company_id':str(key),'company_name':r['company_name'] or 'Unknown','doc_revenue':0.0,'non_doc_revenue':0.0,'unclassified_revenue':0.0,'doc_count':0,'non_doc_count':0,'unclassified_count':0}
        customer_map[key][f"{r['bucket']}_revenue"]+=r['amount']
        customer_map[key][f"{r['bucket']}_count"]+=1
    by_customer=sorted(
        [{**v,'doc_revenue':round(v['doc_revenue'],2),'non_doc_revenue':round(v['non_doc_revenue'],2),'unclassified_revenue':round(v['unclassified_revenue'],2),
          'total_revenue':round(v['doc_revenue']+v['non_doc_revenue']+v['unclassified_revenue'],2)} for v in customer_map.values()],
        key=lambda x:x['total_revenue'],reverse=True
    )[:50]

    ae_map={}
    for r in cur_filtered:
        key=r['ae_code']
        if key not in ae_map:ae_map[key]={'ae_code':key,'doc_revenue':0.0,'non_doc_revenue':0.0,'unclassified_revenue':0.0,'doc_count':0,'non_doc_count':0,'unclassified_count':0}
        ae_map[key][f"{r['bucket']}_revenue"]+=r['amount']
        ae_map[key][f"{r['bucket']}_count"]+=1
    by_ae=sorted(
        [{**v,'doc_revenue':round(v['doc_revenue'],2),'non_doc_revenue':round(v['non_doc_revenue'],2),'unclassified_revenue':round(v['unclassified_revenue'],2),
          'total_revenue':round(v['doc_revenue']+v['non_doc_revenue']+v['unclassified_revenue'],2)} for v in ae_map.values()],
        key=lambda x:x['total_revenue'],reverse=True
    )

    destination_map={}
    for r in cur_filtered:
        key=r['destination']
        if key not in destination_map:destination_map[key]={'destination':key,'doc_revenue':0.0,'non_doc_revenue':0.0,'unclassified_revenue':0.0,'doc_count':0,'non_doc_count':0,'unclassified_count':0}
        destination_map[key][f"{r['bucket']}_revenue"]+=r['amount']
        destination_map[key][f"{r['bucket']}_count"]+=1
    by_destination=sorted(
        [{**v,'doc_revenue':round(v['doc_revenue'],2),'non_doc_revenue':round(v['non_doc_revenue'],2),'unclassified_revenue':round(v['unclassified_revenue'],2),
          'total_count':v['doc_count']+v['non_doc_count']+v['unclassified_count']} for v in destination_map.values()],
        key=lambda x:x['doc_count'],reverse=True
    )

    return {
        'timeframe':timeframe,
        'bounds':{'c_start':str(c_start),'c_end':str(c_end),'p_start':str(p_start),'p_end':str(p_end)},
        'kpis':kpis,
        'trend':trend,
        'by_customer':by_customer,
        'by_ae':by_ae,
        'by_destination':by_destination,
    }


@app.get('/api/v1/analytics/operations')
def operations_analytics(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    origin:str|None=None,
    destination:str|None=None,
    ae_code:str|None=None,
    segment:str|None=None,
    mawb:str|None=None,
    export_only:bool=Query(False),
    db:Session=Depends(get_db),
    ae_scope:str|None=Depends(get_ae_scope)
):
    from datetime import date as _date,datetime as _datetime
    if ae_scope:ae_code=ae_scope
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)
    is_all_time=timeframe=='all_time'

    sql_base = f"""
        SELECT s.id, s.company_id, c.company_name, c.icris_number,
               s.shipment_number, s.shipment_date,
               coalesce(nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               {REVENUE_AMOUNT_SQL}::float amount,
               coalesce(s.pieces, 1)::int pieces,
               coalesce(s.shipment_weight, s.actual_weight, 0)::float weight,
               coalesce(s.dimensional_weight, 0)::float chg_weight,
               coalesce(s.import_country, 'Unknown') import_country,
               coalesce(s.export_country, 'Unknown') export_country,
               m.id as mawb_id, m.mawb_number, m.flight_number,
               m.origin as mawb_origin, m.destination as mawb_destination
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        LEFT JOIN master_air_waybills m ON m.id=s.mawb_id
        WHERE ((:is_all = true) OR (
            (s.shipment_date IS NOT NULL AND s.shipment_date >= :c_start AND s.shipment_date <= :c_end) OR
            (s.shipment_date IS NULL AND s.created_at::date >= :c_start AND s.created_at::date <= :c_end)
        ))
    """
    params = {'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end}
    cur_rows = rows(db, sql_base, params)

    prev_rows = []
    if not is_all_time:
        p_params = {'is_all': False, 'c_start': p_start, 'c_end': p_end}
        prev_rows = rows(db, sql_base, p_params)

    def apply_filters(rows_list):
        filtered = []
        for r in rows_list:
            if origin:
                o_targets = {t.strip().lower() for t in origin.split(',')}
                if not any(t in (r['mawb_origin'] or '').lower() for t in o_targets):
                    continue
            if destination:
                d_targets = {t.strip().lower() for t in destination.split(',')}
                if not any(t in (r['mawb_destination'] or '').lower() for t in d_targets):
                    continue
            if ae_code:
                ae_targets = {a.strip().lower() for a in ae_code.split(',')}
                if not any(a in (r['ae_code'] or '').lower() for a in ae_targets):
                    continue
            if mawb:
                m_targets = {m.strip().lower() for m in mawb.split(',')}
                if not any(m in (r['mawb_number'] or '').lower() for m in m_targets):
                    continue
            if export_only and str(r['import_country']).lower() == 'nepal':
                continue
            filtered.append(r)
        return filtered

    cur_filtered = apply_filters(cur_rows)
    prev_filtered = apply_filters(prev_rows)

    def calc_metrics(data):
        total_shipments = len(data)
        total_mawbs = len({r['mawb_id'] for r in data if r['mawb_id']})
        total_pieces = sum(r['pieces'] for r in data)
        total_weight = sum(r['weight'] for r in data)
        chargeable_weight = sum(r['chg_weight'] for r in data)
        total_revenue = sum(r['amount'] for r in data)
        return total_shipments, total_mawbs, total_pieces, total_weight, chargeable_weight, total_revenue

    c_ship, c_mawb, c_pcs, c_wt, c_chg, c_rev = calc_metrics(cur_filtered)
    p_ship, p_mawb, p_pcs, p_wt, p_chg, p_rev = calc_metrics(prev_filtered)

    kpis = {
        'total_shipments': {'value': c_ship, 'pop_pct': calc_pop(c_ship, p_ship)},
        'total_mawbs': {'value': c_mawb, 'pop_pct': calc_pop(c_mawb, p_mawb)},
        'total_pieces': {'value': c_pcs, 'pop_pct': calc_pop(c_pcs, p_pcs)},
        'total_weight': {'value': c_wt, 'pop_pct': calc_pop(c_wt, p_wt)},
        'chargeable_weight': {'value': c_chg, 'pop_pct': calc_pop(c_chg, p_chg)},
        'avg_shipment_weight': {'value': c_wt / max(1, c_ship), 'pop_pct': calc_pop(c_wt / max(1, c_ship), p_wt / max(1, p_ship))},
        'avg_shipment_value': {'value': c_rev / max(1, c_ship), 'pop_pct': calc_pop(c_rev / max(1, c_ship), p_rev / max(1, p_ship))},
        'avg_pieces': {'value': c_pcs / max(1, c_ship)},
        'avg_chargeable': {'value': c_chg / max(1, c_ship)},
    }

    # Trends
    trend_map = {}
    for r in cur_filtered:
        dt = r['shipment_date']
        if not dt: continue
        key = dt.strftime('%Y-%m-%d')
        if key not in trend_map:
            trend_map[key] = {'date': key, 'shipments': 0, 'weight': 0.0, 'pieces': 0}
        trend_map[key]['shipments'] += 1
        trend_map[key]['weight'] += r['weight']
        trend_map[key]['pieces'] += r['pieces']

    trend = sorted(trend_map.values(), key=lambda x: x['date'])

    # Monthly for Package/Piece Grouped bar & Monthly Operations table
    monthly_map = {}
    for r in cur_filtered:
        dt = r['shipment_date']
        if not dt: continue
        key = dt.strftime('%Y-%m')
        if key not in monthly_map:
            monthly_map[key] = {'month': key, 'shipments': 0, 'pieces': 0, 'weight': 0.0, 'revenue': 0.0}
        monthly_map[key]['shipments'] += 1
        monthly_map[key]['pieces'] += r['pieces']
        monthly_map[key]['weight'] += r['weight']
        monthly_map[key]['revenue'] += r['amount']

    # Revenue growth vs. the immediately preceding month in this same sorted series.
    # The first month in the window has nothing before it to compare to, so it's 0.0,
    # not because growth is unknown but because there is no prior month in scope.
    _monthly_sorted = sorted(monthly_map.values(), key=lambda x: x['month'])
    monthly_operations = [
        {**v, 'growth_pct': calc_pop(v['revenue'], _monthly_sorted[i-1]['revenue']) if i > 0 else 0.0}
        for i, v in enumerate(_monthly_sorted)
    ]

    # Top MAWBs
    mawb_map = {}
    for r in cur_filtered:
        if not r['mawb_number']: continue
        m = r['mawb_number']
        if m not in mawb_map:
            mawb_map[m] = {'mawb': m, 'flight_number': r['flight_number'], 'origin': r['mawb_origin'], 'destination': r['mawb_destination'],
                           'shipments': 0, 'weight': 0.0, 'revenue': 0.0, 'pieces': 0}
        mawb_map[m]['shipments'] += 1
        mawb_map[m]['weight'] += r['weight']
        mawb_map[m]['revenue'] += r['amount']
        mawb_map[m]['pieces'] += r['pieces']

    top_mawbs = sorted(mawb_map.values(), key=lambda x: x['weight'], reverse=True)[:50]

    # Top Shipments
    top_shipments = sorted([{
        'id': r['id'], 'awb': r['shipment_number'], 'customer': r['company_name'], 'company_id': r['company_id'],
        'shipment_date': r['shipment_date'].isoformat() if r['shipment_date'] else None,
        'weight': round(r['weight'], 2),
        'revenue': round(r['amount'], 2), 'pieces': r['pieces'],
        'origin': r['mawb_origin'] or r['export_country'], 'destination': r['mawb_destination'] or r['import_country']
    } for r in cur_filtered], key=lambda x: x['weight'], reverse=True)[:50]

    # Origin vs Destination
    route_map = {}
    for r in cur_filtered:
        org = r['mawb_origin'] or r['export_country'] or 'Unknown'
        dst = r['mawb_destination'] or r['import_country'] or 'Unknown'
        route = f"{org} -> {dst}"
        if route not in route_map: route_map[route] = 0
        route_map[route] += 1
    
    routes = sorted([{'route': k, 'shipments': v} for k, v in route_map.items()], key=lambda x: x['shipments'], reverse=True)[:20]

    # Top Operational Customers
    cust_map = {}
    for r in cur_filtered:
        if not r['company_name']: continue
        cid = r['company_id']
        if cid not in cust_map:
            cust_map[cid] = {'company_id': cid, 'customer': r['company_name'], 'shipments': 0, 'weight': 0.0, 'revenue': 0.0, 'last_shipment': None}
        cust_map[cid]['shipments'] += 1
        cust_map[cid]['weight'] += r['weight']
        cust_map[cid]['revenue'] += r['amount']
        if not cust_map[cid]['last_shipment'] or (r['shipment_date'] and r['shipment_date'] > cust_map[cid]['last_shipment']):
            cust_map[cid]['last_shipment'] = r['shipment_date']

    for c in cust_map.values():
        if c['last_shipment']: c['last_shipment'] = c['last_shipment'].isoformat()
    top_customers = sorted(cust_map.values(), key=lambda x: x['weight'], reverse=True)[:50]

    return {
        'bounds': {'c_start': str(c_start), 'c_end': str(c_end), 'p_start': str(p_start), 'p_end': str(p_end)},
        'kpi_cards': kpis,
        'trend': trend,
        'monthly_operations': monthly_operations,
        'top_mawbs': top_mawbs,
        'top_shipments': top_shipments,
        'routes': routes,
        'top_customers': top_customers,
    }



def _fmt_date(d) -> str:
    """Format a date object or ISO string as 'Sep 10' for alert descriptions."""
    if d is None:
        return ''
    if isinstance(d, str):
        d = datetime.strptime(d[:10], '%Y-%m-%d').date()
    return d.strftime('%b %-d')


def compute_alerts(db: Session, ae_scope: str | None):
    """Shared by GET /analytics/alerts (the full Alerts page) and the notification bell's
    key-insights feed. `id` is a deterministic hash of the alert's identity, not a random
    uuid — the same underlying condition (e.g. this company still dormant 180+ days) must
    produce the same id across requests, or "seen/unseen" tracking has nothing stable to
    compare against. When the condition resolves, the alert simply stops appearing."""
    alerts = []
    import hashlib
    from datetime import date, timedelta

    today = date.today()

    def add_alert(cat, type_, severity, title, desc, ent_type, ent_id=None, ent_name=None, metric=None, ae_code=None, occurred_at=None, hash_key=None):
        # hash_key lets a caller disambiguate alerts whose displayed entity_id is shared
        # (e.g. several DataQualityIssue rows against the same company_id) without changing
        # what's shown/linked to on the alert itself.
        stable_id = hashlib.sha256('|'.join(str(x) for x in (cat, type_, ent_type, hash_key if hash_key is not None else ent_id, ent_name)).encode()).hexdigest()[:24]
        alerts.append({
            'id': stable_id, 'category': cat, 'type': type_, 'severity': severity,
            'title': title, 'description': desc, 'entity_type': ent_type, 'entity_id': ent_id,
            'entity_name': ent_name, 'metric_value': metric, 'date': str(today), 'ae_code': ae_code,
            # When the underlying condition actually started, not when this request ran —
            # 'date' above is always today, which is useless for "what's new" sorting.
            # Falls back to today for alert types with no real originating date to point to.
            'occurred_at': str(occurred_at) if occurred_at else str(today),
        })

    # 1. CUSTOMER ALERTS
    comp_stats = db.execute(text("""
        SELECT c.id, c.company_name, c.customer_type, c.assigned_ae_code,
               MAX(s.shipment_date) as last_shipment,
               MIN(s.shipment_date) as first_shipment,
               COUNT(s.id) as total_shipments
        FROM companies c
        LEFT JOIN shipments s ON s.company_id = c.id
        GROUP BY c.id
    """)).fetchall()

    for c in comp_stats:
        if not c.last_shipment: continue
        days_since = (today - c.last_shipment).days

        # New Customer
        if c.first_shipment and (today - c.first_shipment).days <= 30:
            add_alert('Customer', 'New Customer', 'info', f"New Customer: {c.company_name}", f"First shipment was {(today - c.first_shipment).days} days ago.", 'company', str(c.id), c.company_name, c.total_shipments, c.assigned_ae_code, occurred_at=c.first_shipment)

        # Dormant Customers
        if days_since > 180:
            add_alert('Customer', 'Dormant (180+ days)', 'high', f"Dormant 180+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since, c.assigned_ae_code, occurred_at=c.last_shipment)
        elif days_since > 90:
            add_alert('Customer', 'Dormant (90+ days)', 'medium', f"Dormant 90+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since, c.assigned_ae_code, occurred_at=c.last_shipment)
        elif days_since > 30:
            add_alert('Customer', 'Dormant (30+ days)', 'low', f"Dormant 30+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since, c.assigned_ae_code, occurred_at=c.last_shipment)

    # Tier Shipping Gap — Key Account / Reseller get a 7-day SLA, Large Account 15 days,
    # SME / Small Customer 30 days (docs/customer-segmentation-rules.md). Accounts silent
    # past DORMANT_CUTOFF_DAYS are excluded as dormant, not "overdue." Shared with the
    # email digest (email_notifications.py) via tier_alerts.py, so both agree on "overdue."
    for b in get_tier_shipping_gap_breaches(db):
        add_alert('Customer', 'Tier Shipping Gap', 'high',
                  f"{b['customer_type']} is {b['days_overdue']}d overdue: {b['company_name']}",
                  f"{b['customer_type']} accounts are expected to ship at least every {b['sla_days']} days — this one is {b['days_overdue']} days overdue ({b['days_since']} days since its last shipment).",
                  'company', b['company_id'], b['company_name'], b['days_overdue'], b['assigned_ae_code'],
                  occurred_at=today - timedelta(days=b['days_since']))

    # REVENUE GAINER/DECLINER — month-to-date vs the *same number of days* into last month,
    # not vs last month's full total. Comparing 4 days of this month against all 30-31 days
    # of last month made every customer look like a decline for roughly the first three
    # weeks of every month, regardless of actual trend — an accounting-period mismatch, not
    # a real signal. Skipped for the first 3 days of the month: a 1-2 day sample is too
    # noisy for either direction to mean anything.
    days_elapsed = (today - today.replace(day=1)).days
    if days_elapsed >= 3:
        rev_stats = db.execute(text(f"""
            WITH monthly AS (
                SELECT company_id,
                       SUM(CASE WHEN shipment_date >= date_trunc('month', CURRENT_DATE) THEN {REVENUE_AMOUNT_SQL} ELSE 0 END) as cur_rev,
                       SUM(CASE WHEN shipment_date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month')
                                 AND shipment_date <= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') + (CURRENT_DATE - date_trunc('month', CURRENT_DATE))
                                THEN {REVENUE_AMOUNT_SQL} ELSE 0 END) as prev_rev
                FROM shipments s
                GROUP BY company_id
            )
            SELECT m.company_id, c.company_name, c.assigned_ae_code, m.cur_rev, m.prev_rev, (m.cur_rev - m.prev_rev) as diff
            FROM monthly m JOIN companies c ON c.id = m.company_id
            WHERE m.prev_rev > 0 OR m.cur_rev > 0
        """)).fetchall()

        for r in rev_stats:
            if r.diff > 5000 and r.cur_rev > float(r.prev_rev) * 1.5:
                add_alert('Customer', 'Revenue Gainer', 'info', f"Revenue Spike: {r.company_name}", f"Revenue is up ${r.diff:,.2f} vs the same {days_elapsed + 1} days last month.", 'company', str(r.company_id), r.company_name, float(r.diff), r.assigned_ae_code)
            elif r.diff < -5000 and r.cur_rev < float(r.prev_rev) * 0.5:
                add_alert('Customer', 'Revenue Decliner', 'high', f"Revenue Drop: {r.company_name}", f"Revenue is down ${abs(r.diff):,.2f} vs the same {days_elapsed + 1} days last month.", 'company', str(r.company_id), r.company_name, float(r.diff), r.assigned_ae_code)

    # 2. AE ALERTS — attributed by Company.assigned_ae_code (the current owner) with each
    # company's single most-recent shipment date, exactly matching the per-company dormancy
    # definition the Customer-category alerts use above. Grouping by shipments.ae_code
    # instead (the AE tagged on each individual shipment row, which can be stale after a
    # reassignment or vary CRM-manifest to CRM-manifest) previously made this count disagree
    # with what filtering the Alerts page to that AE actually shows.
    ae_stats = db.execute(text("""
        SELECT c.assigned_ae_code as ae_code,
               COUNT(*) FILTER (WHERE mx.last_shipment < CURRENT_DATE - 30) as dormant_count,
               COUNT(*) FILTER (WHERE mx.last_shipment >= CURRENT_DATE - 30) as active_count
        FROM companies c
        JOIN (SELECT company_id, MAX(shipment_date) as last_shipment FROM shipments GROUP BY company_id) mx ON mx.company_id = c.id
        WHERE c.assigned_ae_code IS NOT NULL AND c.assigned_ae_code != ''
        GROUP BY c.assigned_ae_code
    """)).fetchall()

    for ae in ae_stats:
        if ae.dormant_count > 10:
            add_alert('AE', 'High Dormancy', 'medium', f"AE Portfolio Risk: {ae.ae_code}", f"{ae.dormant_count} dormant accounts.", 'ae', ae.ae_code, ae.ae_code, ae.dormant_count, ae.ae_code)
        if ae.active_count == 0 and ae.dormant_count > 0:
            add_alert('AE', 'Portfolio Inactive', 'high', f"AE Portfolio Inactive: {ae.ae_code}", f"0 active accounts in the last 30 days.", 'ae', ae.ae_code, ae.ae_code, ae.active_count, ae.ae_code)

    # 3. OPERATIONS ALERTS
    ops_shipments = db.execute(text("""
        SELECT id, shipment_number, bill_amount, declared_value, coalesce(shipment_weight, actual_weight) as effective_weight, shipment_date, ae_code
        FROM shipments
        WHERE shipment_date >= CURRENT_DATE - 7
    """)).fetchall()

    for s in ops_shipments:
        val = float(s.bill_amount or s.declared_value or 0)
        if val > 10000:
            add_alert('Operations', 'High-Value Shipment', 'info', f"High Value: {s.shipment_number}", f"Value: ${val:,.2f}", 'shipment', str(s.id), s.shipment_number, val, s.ae_code, occurred_at=s.shipment_date)
        if s.effective_weight and s.effective_weight > 500:
            add_alert('Operations', 'Heavy Shipment', 'info', f"Heavy Shipment: {s.shipment_number}", f"Weight: {s.effective_weight:,.1f} kg", 'shipment', str(s.id), s.shipment_number, float(s.effective_weight), s.ae_code, occurred_at=s.shipment_date)

    # MAWB with highest volume
    mawb_stats = db.execute(text("""
        SELECT m.id, m.mawb_number, SUM(coalesce(s.shipment_weight, s.actual_weight)) as total_weight
        FROM master_air_waybills m
        JOIN shipments s ON s.mawb_id = m.id
        WHERE s.shipment_date >= CURRENT_DATE - 7
        GROUP BY m.id, m.mawb_number
        ORDER BY total_weight DESC NULLS LAST
        LIMIT 1
    """)).fetchall()

    if mawb_stats and mawb_stats[0].total_weight:
        add_alert('Operations', 'High Volume MAWB', 'info', f"Top MAWB: {mawb_stats[0].mawb_number}", f"Total weight: {mawb_stats[0].total_weight:,.1f} kg", 'mawb', str(mawb_stats[0].id), mawb_stats[0].mawb_number, float(mawb_stats[0].total_weight))

    # 4. PIPELINE ALERTS — mirrors the is_overdue / is_lost definitions on GET /api/v1/pipeline.
    # Needs Follow-up: Expected Date has passed with no Win/Loss recorded yet.
    followup_pipeline = db.scalars(select(PipelineItem).where(PipelineItem.expected_date<today,or_(PipelineItem.win_loss.is_(None),PipelineItem.win_loss==''))).all()
    for p in followup_pipeline:
        days_overdue = (today - p.expected_date).days
        severity = 'high' if days_overdue > 14 else ('medium' if days_overdue > 3 else 'low')
        revenue_note = f", ${float(p.revenue_usd):,.0f} at risk" if p.revenue_usd else ''
        add_alert('Pipeline', 'Needs Follow-up', severity, f"Needs Follow-up: {p.company_name}", f"Expected {_fmt_date(p.expected_date)} — {days_overdue} day{'s' if days_overdue != 1 else ''} overdue{revenue_note}. AE: {p.ae_code or 'unassigned'}.", 'pipeline', str(p.id), p.company_name, days_overdue, p.ae_code, occurred_at=p.expected_date)

    # Lost: Win/Loss came back from the CRM as a loss. Flagged regardless of Expected Date so
    # a loss recorded early doesn't quietly sit unnoticed until the row eventually ages out.
    lost_pipeline = db.scalars(select(PipelineItem).where(func.lower(PipelineItem.win_loss).like('%loss%'))).all()
    for p in lost_pipeline:
        revenue_note = f" — ${float(p.revenue_usd):,.0f}" if p.revenue_usd else ''
        severity = 'high' if (p.revenue_usd or 0) > 1000 else 'medium'
        add_alert('Pipeline', 'Lost Deal', severity, f"Lost: {p.company_name}{revenue_note}", f"Marked loss in CRM (expected {_fmt_date(p.expected_date)}). AE: {p.ae_code or 'unassigned'}.", 'pipeline', str(p.id), p.company_name, float(p.revenue_usd) if p.revenue_usd else None, p.ae_code, occurred_at=p.expected_date)

    # Date Pushed (No Follow-up): an overdue, unresolved deal reappeared on a later sync with
    # its Expected Date moved out and still no Win/Loss — the date got pushed instead of the
    # deal actually being followed up. Captured at sync time in crm_sync.sync_active_pipeline
    # (the pipeline table itself has no history to detect this after the fact).
    pushed = db.scalars(select(DataQualityIssue).where(DataQualityIssue.issue_type=='pipeline_date_pushed',DataQualityIssue.status=='open').order_by(DataQualityIssue.first_seen_at.desc())).all()
    for issue in pushed:
        d = issue.details_json or {}
        days_pushed = d.get('days_pushed')
        revenue_note = f", ${d['revenue_usd']:,.0f} at risk" if d.get('revenue_usd') else ''
        add_alert('Pipeline', 'Date Pushed (No Follow-up)', issue.severity, f"Date Pushed: {issue.source_company_name}", f"Expected date moved {_fmt_date(d.get('old_expected_date'))} → {_fmt_date(d.get('new_expected_date'))} (pushed {days_pushed} day{'s' if days_pushed != 1 else ''}) — no outcome recorded{revenue_note}. AE: {d.get('ae_code') or 'unassigned'}.", 'company', str(issue.company_id) if issue.company_id else None, issue.source_company_name, days_pushed, d.get('ae_code'), occurred_at=issue.first_seen_at.date() if issue.first_seen_at else None, hash_key=str(issue.id))

    # Sort alerts by severity (high > medium > low > info)
    severity_order = {'high': 0, 'medium': 1, 'low': 2, 'info': 3}
    alerts.sort(key=lambda x: severity_order.get(x['severity'], 4))

    # Cap per (category, AE) rather than per category alone — capping only by category still
    # let one AE's high dormancy count (e.g. 150 of 150) crowd out a different AE's much
    # smaller list before the loop ever reached it, so filtering the Alerts page to that AE
    # showed 3 accounts when the summary alert said 32. Grouping the cap by AE too means each
    # AE's own list survives regardless of how large other AEs' lists are.
    per_group_cap = 300
    seen_per_group: dict[tuple[str, str], int] = {}
    capped = []
    for a in alerts:
        # An 'ae'-role caller only ever sees alerts attributed to their own book — an
        # alert with no ae_code at all (e.g. the top-MAWB volume alert) isn't "theirs"
        # either, so it's dropped too rather than shown to everyone by default.
        if ae_scope and a['ae_code'] != ae_scope:continue
        key = (a['category'], a['ae_code'] or '')
        n = seen_per_group.get(key, 0)
        if n >= per_group_cap:continue
        seen_per_group[key] = n + 1
        capped.append(a)

    return capped

@app.get('/api/v1/analytics/alerts')
def get_alerts(db: Session = Depends(get_db), ae_scope: str | None = Depends(get_ae_scope)):
    return {"alerts": compute_alerts(db, ae_scope)}

class MarkSeenIn(BaseModel):
    ids: list[str]

class SnoozeIn(BaseModel):
    id: str
    days: int | None = None  # None = permanent dismiss

_PERMANENT_SNOOZE = '9999-12-31'

def _get_or_create_notification_state(db: Session, user: User) -> UserNotificationState:
    state = db.get(UserNotificationState, user.id)
    if not state:
        state = UserNotificationState(user_id=user.id, seen_alert_ids=[], snoozed={})
        db.add(state)
    return state

def _prune_notification_state(state: UserNotificationState, live_ids: set[str]) -> bool:
    """Drops seen/snoozed entries for ids no longer live, so a resolved-then-recurring
    condition (same stable id) re-alerts instead of staying "seen"/snoozed forever, and
    both structures stay bounded to roughly the live set's size. Returns True if changed."""
    pruned_seen = [i for i in state.seen_alert_ids if i in live_ids]
    pruned_snoozed = {i: d for i, d in state.snoozed.items() if i in live_ids}
    changed = len(pruned_seen) != len(state.seen_alert_ids) or len(pruned_snoozed) != len(state.snoozed)
    state.seen_alert_ids = pruned_seen
    state.snoozed = pruned_snoozed
    return changed

@app.get('/api/v1/notifications/key-insights')
def key_insights(category: str | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user), ae_scope: str | None = Depends(get_ae_scope)):
    """The notification-bell feed — high-severity alerts only (the full Alerts page stays
    the place for everything else), scoped the same way as /analytics/alerts. Sorted by
    `occurred_at` (when the underlying condition actually started) descending, most recent
    first — not insertion order, which was arbitrary. `unread` is whichever of these ids
    aren't yet in this user's seen_alert_ids. `category` optionally narrows to one of the
    values in the returned `categories` list (Customer/Pipeline/AE/Operations). Dismissed/
    snoozed-active items are excluded entirely."""
    all_high = [a for a in compute_alerts(db, ae_scope) if a['severity'] == 'high']
    categories = sorted({a['category'] for a in all_high})

    state = _get_or_create_notification_state(db, user)
    live_ids = {a['id'] for a in all_high}
    if _prune_notification_state(state, live_ids):
        commit(db)
    seen = set(state.seen_alert_ids)
    today_iso = date.today().isoformat()

    high = [a for a in all_high if state.snoozed.get(a['id'], '0000-00-00') < today_iso]
    if category:
        high = [a for a in high if a['category'] == category]
    high.sort(key=lambda a: a['occurred_at'], reverse=True)
    for a in high:
        a['seen'] = a['id'] in seen
    return {'items': high, 'unread_count': sum(1 for a in high if not a['seen']), 'categories': categories}

@app.post('/api/v1/notifications/mark-seen')
def mark_notifications_seen(body: MarkSeenIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    state = _get_or_create_notification_state(db, user)
    # Union rather than replace — an id that scrolled out of the current top-N shouldn't
    # become "unread" again the next time its condition happens to resurface it. Pruned
    # back to the live set on the next key-insights read (see _prune_notification_state).
    state.seen_alert_ids = list(set(state.seen_alert_ids) | set(body.ids))
    commit(db)
    return {'status': 'ok'}

@app.post('/api/v1/notifications/mark-all-seen')
def mark_all_notifications_seen(db: Session = Depends(get_db), user: User = Depends(get_current_user), ae_scope: str | None = Depends(get_ae_scope)):
    """Marks every current high-severity insight in this user's own scope as seen — not
    just whatever page of items the client happened to have fetched."""
    all_ids = [a['id'] for a in compute_alerts(db, ae_scope) if a['severity'] == 'high']
    state = _get_or_create_notification_state(db, user)
    state.seen_alert_ids = list(set(state.seen_alert_ids) | set(all_ids))
    commit(db)
    return {'status': 'ok', 'marked': len(all_ids)}

@app.post('/api/v1/notifications/snooze')
def snooze_notification(body: SnoozeIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Dismisses (days=None) or snoozes (days=N) one insight for this user. A snoozed/
    dismissed id disappears from key-insights until it expires or the underlying
    condition resolves and later recurs (which prunes it back out automatically)."""
    until = _PERMANENT_SNOOZE if body.days is None else (date.today() + timedelta(days=body.days)).isoformat()
    state = _get_or_create_notification_state(db, user)
    state.snoozed = {**state.snoozed, body.id: until}
    commit(db)
    return {'status': 'ok', 'snoozed_until': until}
