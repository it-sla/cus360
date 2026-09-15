"""High-speed parallel CRM synchronization engine for Customer 360.
Fetches and ingests both Export and Import manifests concurrently across 2017-2026.
"""
import asyncio
import hashlib
import json
import logging
import re
import time
import unicodedata
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import List, Dict, Any, Tuple

import httpx
from bs4 import BeautifulSoup
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core import settings
from app.db import SessionLocal
from app.models import (
    CrmSyncRun, CrmSyncItem, MasterAirWaybill, Shipment, Company, CrmRawManifestRow,
    CrmRawManifestHeader, DataQualityIssue, CrmSyncState, now
)
from app.crm_parser import (
    parse_manifest_list, parse_manifest_detail, ManifestDetail, CrmParseError
)
from app.crm_sync import upsert_detail, link_icris

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("fast-crm-sync")

CONCURRENCY = 10  # 10 parallel workers for maximum speed

class FastCrmSession:
    def __init__(self):
        timeout = httpx.Timeout(30.0, connect=10.0)
        self.client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=timeout,
            headers={'User-Agent': 'Customer360-FastSync/2.0', 'Accept': 'text/html,application/xhtml+xml'}
        )
        self.authenticated = False

    async def close(self):
        await self.client.aclose()

    async def login(self):
        if not settings.credentials_configured:
            raise RuntimeError("CRM credentials not configured in environment")
        
        log.info(f"Logging into legacy CRM at {settings.crm_login_url}...")
        resp = await self.client.get(settings.crm_login_url)
        soup = BeautifulSoup(resp.text, 'html.parser')
        form = soup.select_one('form')
        if not form:
            raise RuntimeError("CRM login form not found")
        
        hidden = {x.get('name'): x.get('value', '') for x in soup.select('input[type=hidden][name]')}
        inputs = form.select('input[name]')
        passwords = [x for x in inputs if x.get('type', '').lower() == 'password']
        if not passwords:
            raise RuntimeError("CRM password input not found")
        pwd_name = passwords[0]['name']
        
        user_name = next(
            (x['name'] for x in inputs if any(k in x.get('name', '').casefold() for k in ('user', 'login', 'txt')) and x != passwords[0]),
            'txt_Username'
        )
        
        submits = [x for x in inputs if x.get('type', '').lower() in ('submit', 'button')]
        submit_name = submits[0].get('name') if submits else None
        submit_val = submits[0].get('value', '') if submits else ''
        
        payload = dict(hidden)
        payload[user_name] = settings.crm_username.get_secret_value()
        payload[pwd_name] = settings.crm_password.get_secret_value()
        if submit_name:
            payload[submit_name] = submit_val
            
        action_url = httpx.URL(settings.crm_login_url).join(form.get('action') or settings.crm_login_url)
        post_resp = await self.client.post(str(action_url), data=payload)
        
        # Verify listing page
        listing = await self.client.get(settings.crm_export_manifest_list_url)
        if 'login' in str(listing.url).casefold() and not BeautifulSoup(listing.text, 'html.parser').select('table'):
            raise RuntimeError("CRM login authentication failed")
        
        self.authenticated = True
        log.info("CRM Authentication SUCCESSFUL!")

    async def fetch_list_range(self, direction: str, d_from: date, d_to: date) -> str:
        url = settings.crm_export_manifest_list_url if direction == 'export' else settings.crm_import_manifest_list_url
        if not url:
            raise ValueError(f"CRM {direction} list URL not configured")
        
        resp = await self.client.get(url)
        soup = BeautifulSoup(resp.text, 'html.parser')
        hidden = {x.get('name'): x.get('value', '') for x in soup.select('input[type=hidden][name]')}
        
        fields = {
            'ctl00$MainContent$txt_dateFrom': f'{d_from.month}/{d_from.day}/{d_from.year}',
            'ctl00$MainContent$txt_DateTo': f'{d_to.month}/{d_to.day}/{d_to.year}',
            'ctl00$MainContent$btn_Preview': 'Show'
        }
        hidden.update(fields)
        
        res = await self.client.post(url, data=hidden)
        return res.text

    async def fetch_detail(self, direction: str, manifest_id: str, detail_url: str = None) -> str:
        if direction == 'import':
            target = f"http://192.168.101.3:8040/Sales_WebForms/S_MenifestEditFormImport.aspx?ID={manifest_id}"
        else:
            template = settings.crm_export_manifest_detail_url_template
            target = template.format(id=manifest_id) if template and manifest_id else detail_url
        if not target:
            raise ValueError(f"CRM {direction} detail URL missing for manifest {manifest_id}")
        
        resp = await self.client.get(target)
        return resp.text, str(resp.url)


async def run_fast_sync(start_year=2017, end_year=2026, directions=('export', 'import')):
    session = FastCrmSession()
    await session.login()
    
    start_date = date(start_year, 1, 1)
    end_date = min(date.today(), date(end_year, 12, 31))
    
    log.info(f"=== FAST SYNC STARTED: {start_date} to {end_date} for directions: {directions} ===")
    t_start = time.time()
    
    db = SessionLocal()

    # Step 1: Create or get master sync run
    run = CrmSyncRun(
        sync_type='fast_parallel_sync',
        status='running',
        direction='both' if len(directions) > 1 else directions[0],
        requested_from_date=start_date,
        requested_to_date=end_date,
        started_at=now()
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    
    total_discovered = 0
    total_ingested = 0
    total_shipments_count = 0

    try:
        # Step 2: Discovery phase per quarter for high reliability
        quarter_chunks = []
        curr = start_date
        while curr <= end_date:
            next_curr = min(end_date, curr + timedelta(days=90))
            quarter_chunks.append((curr, next_curr))
            curr = next_curr + timedelta(days=1)

        discovered_items = []
        log.info(f"Starting discovery across {len(quarter_chunks)} date windows...")

        seen_discovered = set()
        for direction in directions:
            for q_start, q_end in quarter_chunks:
                try:
                    log.info(f"Discovering [{direction.upper()}] from {q_start} to {q_end}...")
                    html = await session.fetch_list_range(direction, q_start, q_end)
                    rows = parse_manifest_list(html, settings.crm_base_url)
                    log.info(f" -> Found {len(rows)} manifest headers for [{direction.upper()}] ({q_start} to {q_end})")
                    
                    for r in rows:
                        manifest_id = r['crm_manifest_id']
                        if not manifest_id:
                            continue
                        key = (direction, manifest_id)
                        if key in seen_discovered:
                            continue
                        seen_discovered.add(key)
                        discovered_items.append({
                            'direction': direction,
                            'manifest_id': manifest_id,
                            'manifest_date': r['manifest_date'],
                            'mawb_number': r['MAWB'],
                            'detail_ref': r['detail_ref']
                        })
                except Exception as e:
                    log.warning(f"Error discovering {direction} {q_start} to {q_end}: {e}")

        log.info(f"=== DISCOVERY COMPLETE: Total Manifests Found = {len(discovered_items)} ===")
        total_discovered = len(discovered_items)

        # Step 3: Deduplicate against DB existing MAWBs or process all un-ingested
        items_to_process = []
        for item in discovered_items:
            existing_item = db.scalar(
                select(CrmSyncItem).where(
                    CrmSyncItem.manifest_direction == item['direction'],
                    CrmSyncItem.crm_manifest_id == item['manifest_id']
                )
            )
            if not existing_item:
                sync_item = CrmSyncItem(
                    run_id=run.id,
                    manifest_direction=item['direction'],
                    crm_manifest_id=item['manifest_id'],
                    source_manifest_date=item['manifest_date'],
                    source_mawb_number=item['mawb_number'],
                    status='pending'
                )
                db.add(sync_item)
                items_to_process.append((sync_item, item))
            elif existing_item.status not in ('succeeded', 'succeeded_with_warnings'):
                items_to_process.append((existing_item, item))

        db.commit()
        log.info(f"Pending/Unprocessed Manifest Details to Ingest: {len(items_to_process)}")

        # Step 4: Parallel Manifest Detail Fetching & Ingestion
        semaphore = asyncio.Semaphore(CONCURRENCY)

        async def worker(item_tuple):
            nonlocal total_ingested, total_shipments_count
            sync_item, item_meta = item_tuple
            async with semaphore:
                try:
                    direction = item_meta['direction']
                    manifest_id = item_meta['manifest_id']
                    
                    html, actual_url = await session.fetch_detail(direction, manifest_id, item_meta['detail_ref'])
                    detail = parse_manifest_detail(html, manifest_id)
                    
                    # Database write in session
                    w_db = SessionLocal()
                    try:
                        w_run = w_db.get(CrmSyncRun, run.id)
                        w_item = w_db.get(CrmSyncItem, sync_item.id)
                        
                        mawb = upsert_detail(
                            w_db, w_run, detail, actual_url, w_item, direction, manifest_id, dry_run=False
                        )
                        w_item.status = 'succeeded_with_warnings' if detail.warnings else 'succeeded'
                        w_item.completed_at = now()
                        w_db.commit()
                        
                        total_ingested += 1
                        total_shipments_count += len(detail.rows)
                        if total_ingested % 25 == 0:
                            log.info(f"Progress: Ingested {total_ingested}/{len(items_to_process)} manifests ({total_shipments_count} total shipments)")
                    finally:
                        w_db.close()

                except Exception as exc:
                    w_db = SessionLocal()
                    try:
                        w_item = w_db.get(CrmSyncItem, sync_item.id)
                        w_item.status = 'quarantined'
                        w_item.last_error_summary = str(exc)[:250]
                        w_db.commit()
                    finally:
                        w_db.close()
                    log.warning(f"Failed manifest {item_meta['manifest_id']}: {exc}")

        # Run all workers
        tasks = [worker(it) for it in items_to_process]
        await asyncio.gather(*tasks)

        run.status = 'completed'
        run.completed_at = now()
        db.commit()

        duration = time.time() - t_start
        log.info(f"=== FAST SYNC FULLY COMPLETED in {duration:.2f}s ===")
        log.info(f"Discovered: {total_discovered} | Ingested Manifests: {total_ingested} | Shipments: {total_shipments_count}")

    except Exception as e:
        db.rollback()
        run.status = 'completed_with_errors'
        run.error_message = str(e)[:300]
        db.commit()
        log.error(f"Fast Sync Error: {e}")
    finally:
        db.close()
        await session.close()

if __name__ == '__main__':
    asyncio.run(run_fast_sync(start_year=2017, end_year=2026, directions=('export', 'import')))
