# CRM Sync

The legacy CRM is an **ASP.NET Web Forms** application at `http://192.168.101.3:8040/`. Customer 360 reads its final manifests. This is the primary air-waybill feed.

> **Read-only, always.** Never invoke save/update/delete, never guess URLs or selectors, never log credentials or cookies.

---

## Modules

| Module | Role |
|---|---|
| `crm_connector.py` | HTTP session, login, throttling, host allowlist, Web Forms postbacks |
| `crm_parser.py` | Strict HTML parsing. Raises rather than returning partial data |
| `crm_sync.py` | Reconciliation: upsert MAWB + shipments, link ICRIS, manage aliases |
| `crm_worker.py` | The claim loop. Runs as the `crm-scraper` container |
| `crm_backfills.py` | Chunked historical backfill orchestration |

---

## 1. Connector (`crm_connector.py`)

`CrmSessionManager` wraps an `httpx.Client` with connection pooling and an in-memory cookie jar.

**Safety mechanisms:**

| Mechanism | Detail |
|---|---|
| Host allowlist | `_validate(url)` rejects any host not in `CRM_ALLOWED_HOSTS` |
| Response validation | `_validate_response` catches unexpected redirects → `UnexpectedRedirect` |
| Throttle | `_throttle()` enforces `CRM_REQUEST_DELAY_MS` (default 750ms) between requests |
| Auth renewal | Exactly **one** re-login attempt on session expiry, then fails |
| Bounded retries | Network errors retry a fixed number of times, then raise |
| Timeouts | `CRM_CONNECT_TIMEOUT_MS` (10s), `CRM_READ_TIMEOUT_MS` (30s) |

**Error hierarchy** — retryability is encoded in the class:

```
ConnectorError               retryable=False   code='crm_manifest_unavailable'
 └─ RetryableConnectorError  retryable=True
     └─ AuthenticationError                    code='crm_login_failed'
         └─ SessionExpired                     code='crm_session_expired'
 └─ UnexpectedRedirect                         code='crm_unexpected_redirect'
 └─ LoginFormError
```

**Web Forms helpers** — ASP.NET postbacks require replaying hidden state:
- `parse_hidden_fields(html)` — extracts `__VIEWSTATE`, `__EVENTVALIDATION`, etc.
- `webforms_payload(html, fields, event_target, event_argument)` — builds the POST body
- `postback(url, html, event_target, ...)` — performs it

Always derive hidden fields from the **current** page. Never hardcode or reuse them.

**Navigation:**

| Method | Target |
|---|---|
| `export_list()` | `CRM_EXPORT_MANIFEST_LIST_URL` → `MenifestPreview.aspx` |
| `import_list()` | `CRM_IMPORT_MANIFEST_LIST_URL` → `MenifestPreviewImport.aspx` |
| `list_range(direction, from, to)` | Date-range query via postback |
| `detail(direction, id, url)` | `S_MenifestPreview.aspx?ID=…` (export) / `S_MenifestEditFormImport.aspx?ID=…` (import) |

Export and import detail navigation are plain authenticated GETs. **Date-range postback behaviour must be handled through current hidden fields, not guessed URLs.**

---

## 2. Parser (`crm_parser.py`)

### The 17-column contract

```python
ROW_HEADERS = ['SN', 'Tracking No.', 'Bill Type', 'Icrisno', 'Shipper', 'Consignee',
               'Dest.', 'Act wt', 'Pcs', 'Dim wt', 'Pay Term', 'Bill no.', 'Bill amt',
               'Gross amt', 'Tarriff Rate', 'AE', 'Delivery']
PARSER_VERSION = '2.0.0'
```

**`Icrisno` and `Tarriff Rate` are the source's own misspellings. Do not correct them.** [verified] Substituting `ICRIS No` or `Tariff Rate` is rejected with `crm_header_mismatch`.

Validation is positional and strict (`:195`):
```python
if len(headers) < 17 or normalized[:17] != expected:
    raise CrmParseError('Shipment headers differ from the verified 17-column contract')
```

`normalize_header` (`:33`) tolerates only cosmetic variance: NFKC, non-breaking spaces, collapsed whitespace, case, and spacing around periods (`Dest .` → `dest.`). It does **not** tolerate different words.

### Entry points

| Function | Returns / raises |
|---|---|
| `parse_manifest_list(html, base_url)` | List rows with `Date`, `MAWB`, `FLIGHT`, `FROM`, `TO`, `detail_ref`, `crm_manifest_id` |
| `parse_manifest_detail(html, expected_id)` | `ManifestDetail(header, totals, rows, warnings, …)` |

`ManifestDetail` carries `source_checksum` (SHA-256 over header + totals + raw rows), `parser_version`, `source_data_row_count`, and `duplicate_row_count`.

### Header extraction

Regex over table text first (`Date:`, `MAWB:`, `Flight No:`, `From:`, `TO:`, `Exchange Rate:`, `Fuel Surch[ar]ge:`), then a BeautifulSoup fallback reading `input[name*="txt_Date"]`, `txt_mawb`, `txt_FlightNo`, `txt_ExRate`, `txt_FuelSurchage` (`:136-156`). If MAWB or Date is still missing → `PartialManifestError`.

### Totals

PP / FC / FD rows are parsed into **separate** keys — `pp_weight`, `fc_pieces`, `fd_bill_amount`, … Two table layouts are supported: category-per-row and category-per-column (`:160-181`).

### Duplicate handling

Same tracking number twice in one manifest:
- **Identical values** → collapsed, `duplicate_row_count += 1`
- **Different values** → `DuplicateTrackingConflict` (permanent failure, quarantined)

### Fixture behaviour [verified]

| Fixture | Result |
|---|---|
| `crm_manifest_detail.html` | 3 rows, `Icrisno='R1100X'`, `Tarriff Rate='4.5'`, PP+FC+FD totals separate |
| `crm_export_live_structure.html` | 1 row, raw keys identical to `ROW_HEADERS` |
| `crm_manifest_list.html` | 2 rows, ids `['1','2']` |
| `crm_login.html`, `crm_webforms_login.html` | `LoginRequired(crm_session_expired)` |
| `crm_changed.html` | `PartialManifestError(crm_partial_page)` |
| `crm_invalid_numeric.html` | parses with a warning — does not crash |
| `crm_empty.html` | 0 rows + warning; worker converts to `EmptyManifestError` |

### Import-direction fallback

`:214-265` handles a different table shape for import manifests, mapping `Shipper Acc No` **or** `Consignee Acc. No.` to `Icrisno`.

> ⚠️ It **fabricates** `Dim wt='0'`, `Tarriff Rate='0'`, `Pcs='1'`, `Act wt='0'` for columns the source lacks, and silently `continue`s past blank tracking numbers where the strict path raises. Whether shipper-first precedence is even correct for imports is unverified. Currently inert: import direction is force-dry-run.

---

## 3. Sync engine (`crm_sync.py`)

### `upsert_detail(db, run, detail, url, item, direction, manifest_id, dry_run)`

1. **Dry run** — computes `_prediction()` (predicted creates/updates/links) and `_reconciliation()`, writes metrics to the item, **touches no business table**, returns.
2. **Resolve MAWB** — by `(direction, crm_manifest_id)`, else by `(mawb_number, manifest_date)`. Creates if absent.
3. **Change detection** — if `source_checksum` and `parser_version` both match and `force_reparse` is off, mark `unchanged` and **return early** (`:79`). This is what makes re-syncs cheap.
4. **Update MAWB header** — flight/origin/destination, exchange rate, fuel surcharge, and all nine PP/FC/FD totals.
5. **Archive raw header** into `crm_raw_manifest_headers`.
6. **Per row:**
   - Look up shipment by exact normalised tracking number
   - Create or update; set `mawb_id`, `shipment_date`, CRM provenance
   - Apply `field_map` (text) and `num_map` (numeric) **respecting `manual_override_fields`**
   - Record `crm_field_provenance` per field
   - Call `link_icris`
   - Archive the raw row with the exact 17 source headers
7. **Reconciliation** — compare summed row pieces/weight against displayed PP+FC+FD totals; mismatch → `crm_manifest_total_mismatch`. Weight tolerance from `CRM_RECONCILIATION_WEIGHT_TOLERANCE` (0.01).

> **Known bug:** step 6 sets `shipment_date` at `:96`, *outside* the override guard. A manually corrected date is overwritten every sync. See [03-data-rules.md](03-data-rules.md) rule 4.

### `link_icris(db, shipment, icris, name, run, item, create_provisional=True)`

The heart of customer matching. Returns one of `manual` · `missing` · `invalid` · `matched` · `unmatched`.

```
manually_matched?  ──yes──> return 'manual'   (issue: crm_manual_link_preserved)
       │no
normalize_icris → blank?  ──yes──> match_status='icris_missing', company=NULL
       │no                          (issue: crm_blank_icris)  return 'missing'
exact_company(icris) found?
       │no ── valid_icris()? ──no──> match_status='invalid_icris'
       │                              (issue: crm_invalid_icris)  return 'invalid'
       │      └─yes─> create provisional Company (begin_nested + IntegrityError fallback)
       ▼
link: company_id, match_status='matched', confidence=100, method='exact_icris'
  ├─ add alias from source shipper name (if it differs)
  ├─ resolve any open crm_blank_icris / crm_invalid_icris issues for this shipment
  └─ if source name ≠ official name: name_mismatch=True, issue crm_customer_name_mismatch
```

`valid_icris` (`:12`) requires ≤128 chars, at least one alphanumeric, and no control characters. An *existing* company always wins over the validity check — so historical odd-looking ICRIS values keep working.

> The alias step is unbounded and has produced 1,870 aliases on one company. See [10-known-issues.md](10-known-issues.md) M-7.

### `rematch(db)`

Idempotent re-linking of all shipments with a `source_icris_number`. Skips manual links. Exposed as `POST /api/v1/crm-sync/rematch`.

---

## 4. Worker (`crm_worker.py`)

Runs as the `crm-scraper` container: `python -m app.crm_worker`.

### Main loop — `run_once()`

```
recover_stale()          reclaim items whose lease expired
claim_discovery()        any run in 'queued'? → discover_run()  → return
claim_item()             any pending/retry item? → process_item() → finalize_runs() → return
finalize_runs() · recover_backfill_orchestration() · check_auto_schedule() · heartbeat()
```

Sleeps `CRM_SYNC_POLL_SECONDS` (10s) when idle.

### Claiming — the concurrency-safe part

```python
item = db.scalar(
    select(CrmSyncItem).join(CrmSyncRun)
    .where(CrmSyncRun.status.in_({'running','interrupted'}),
           CrmSyncItem.status.in_({'pending','retry_scheduled'}),
           or_(CrmSyncItem.next_retry_at.is_(None), CrmSyncItem.next_retry_at <= stamp))
    .order_by(CrmSyncItem.created_at)
    .with_for_update(skip_locked=True))
```

`FOR UPDATE SKIP LOCKED` lets multiple workers run without contention. On claim: status → `claimed`, `attempt_count += 1`, `lease_expires_at = now + CRM_SYNC_LEASE_SECONDS` (300s).

### Lease recovery

`recover_stale()` (`:51`) finds items in an in-flight status whose `lease_expires_at` has passed and resets them to `retry_scheduled` with `last_error_code='worker_lease_expired'`. A crashed worker's item is picked up automatically.

`heartbeat(item_id, stage)` extends the lease as processing advances through `fetching` → `parsing` → `validating` → `importing`.

### Failure classification — `classify(exc)` (`:29`)

| Exception | Code | Retryable |
|---|---|---|
| `DuplicateTrackingConflict` | `crm_duplicate_tracking_conflict` | no |
| `PartialManifestError`, `EmptyManifestError` | `crm_partial_page` / `crm_empty_manifest` | **yes** |
| Other `CrmParseError` | `crm_header_mismatch` | no |
| `AuthenticationError` | `crm_login_failed` | **yes** |
| `RetryableConnectorError` | `crm_manifest_unavailable` | **yes** |
| `ConnectorError` | `crm_manifest_unavailable` | no |
| `OperationalError`, `DBAPIError` | `temporary_database_failure` | **yes** |
| anything else | `unexpected_worker_error` | no |

**Backoff:** `(30, 120, 600, 1800, 7200)` seconds + 0-10s jitter, capped at `CRM_SYNC_MAX_ATTEMPTS` (5). Exhausted or non-retryable → `quarantined` + a `DataQualityIssue`.

**Every failure is redacted** before storage — `_summary` (`:24`) replaces text containing `password`, `cookie`, `viewstate`, or `eventvalidation` with a placeholder.

### Isolation guarantee

Each manifest is imported in **its own transaction** (`:141-148`). One failing manifest never rolls back a succeeding one — the core reliability property of the design.

### Import direction is always dry-run

```python
effective_dry = run.dry_run or direction == 'import'    # :144
```
Plus a warning: *"Import customer party role is unverified; business linking is disabled"* (`:140`). **Import manifests never write business tables.**

### Auto-schedule

`check_auto_schedule()` (`:201`) runs a hand-rolled 5-field cron matcher. Guards: 5-minute debounce, and skipped entirely if any run is already `queued`/`discovering`/`running`.

Uses naive `datetime.now()` — the **container's OS clock**, which is UTC, not Nepal time (NPT,
UTC+5:45) and not "browser local time" either. `CRM_SCHEDULE_CRON` must be written in UTC.
The container previously ran on `CRM_DEFAULT_LOOKBACK_DAYS`. Historically `CRM_SCHEDULE_CRON`
was set to `"0 18,21 * * *"`, intended as 6pm/9pm — but since the container clock is UTC, that
actually fired at 11:45pm/2:45am NPT, not end-of-business-day as intended (found 2026-08-10).

Current value `CRM_SCHEDULE_CRON="15 8,14 * * *"` is **2:00 PM and 8:00 PM NPT**, expressed in
UTC (08:15 and 14:15 UTC). If you need to change the intended NPT time, convert it yourself:
`UTC = NPT - 5:45`. Don't paste an NPT time straight into this setting.

---

## 5. Backfills (`crm_backfills.py`)

Historical ingestion, split into date chunks so it can be paused and resumed.

| Function | Purpose |
|---|---|
| `chunk_ranges(start, end, size)` | Split a range into chunks (1/7/14/30 days) |
| `resolve_start(db, direction, requested)` | Determine start date, consulting `earliest:<direction>` state |
| `customer_master_ready(db)` | True if any company-master import completed — a **guard** so backfills don't run before official names exist, which would create provisional companies for everything |
| `create_backfill` / `create_incremental` | Build a backfill or an incremental catch-up run |
| `activate_next_chunk` | Promote the next `pending` chunk to `active` and create its `CrmSyncRun` |
| `pause` / `resume` / `cancel` | Lifecycle control |
| `watermark_state(db, direction)` | Read `watermark:<direction>` — the last successfully synced date |

**Watermark advances only when safe** (`crm_worker.py:164`): the run completed cleanly, was not a dry run, had a `requested_to_date`, and no sibling chunk is in `needs_attention`.

**Live state** [verified]: `watermark:both` = 2026-08-05, `watermark:export` = 2026-07-21, `earliest:export`/`earliest:import` = 2026-07-15.

---

## Operational notes

**Trigger a dry run** (parses, validates, matches, reconciles — writes nothing):
```bash
curl -X POST 'http://localhost:8360/api/v1/crm-sync/export/12345?dry_run=true'
```

**Queue a date range:**
```bash
curl -X POST http://localhost:8360/api/v1/crm-sync/manifests \
  -H 'Content-Type: application/json' \
  -d '{"direction":"export","date_from":"2026-07-16","date_to":"2026-07-16","dry_run":true,"maximum_manifests":25}'
```

**Watch the worker:**
```bash
docker compose logs -f crm-scraper
```
It emits structured JSON events: `worker_started`, `discovery_list_parsed`, `discovery_completed`, `manifest_completed`, `manifest_failed`, `stale_items_recovered`, `auto_sync_scheduled`.

**If login expires:** inspect the scraper logs first. Remove the `crm_session` volume **only** when an authorised fresh login is intended, then retry the failed run.

**If the CRM HTML changes:** the parser raises a structure-change failure and the item is quarantined with a `DataQualityIssue`. It will never silently treat a changed table as an empty result. Review the quarantined items, update `ROW_HEADERS` only if the source genuinely changed, and bump `PARSER_VERSION` so checksums re-evaluate.

**Confirmed permanent gaps in UPS P&L history** (see [10-known-issues.md](10-known-issues.md) D-14) — don't spend time re-attempting these:
- **Sep–Dec 2023** (81/81 manifests) and **Jan 2022** (19/20 manifests): `S_MenifestPrevUPS.aspx` returns a genuine server-side 500 (`Object cannot be cast from DBNull to other types`) [verified 2026-08-12]. This is a bug in the CRM's own rendering code on old records with a blank field it doesn't null-check — not our scraping, and not confined to these two windows; expect it scattered elsewhere in older history too. It also almost certainly explains why the MAWB-level Total report is empty for Sep–Dec 2023.
- **Apr–May 2020**: the UPS manifest list itself returns 0 rows — no error, just nothing recorded for that period.

**The two reports can disagree, and the per-shipment one is the more reliable source when they do** — the MAWB-level Total report (`POST /crm-sync/pnl`) times out on wide/heavy-volume ranges server-side (confirmed on Jan 2026: 50 MAWBs, and Feb 2026: 55 MAWBs — both consistently failed there), while the per-shipment sync (`POST /crm-sync/ups-pnl`) fetches one manifest per request and sailed through both months cleanly (26/26 and 22/22 manifests, 1045 and 1023 shipments matched respectively) [verified 2026-08-12]. When the Total report fails on a heavy month, retry with the per-shipment sync before assuming it's a permanent gap.
