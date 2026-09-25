# API Reference

Base URL `/api/v1`. All routes are defined in `backend/app/main.py` — there are no router modules.

**87 paths, ~100 operations.** Interactive docs at `http://localhost:8360/docs`.

> ## ⚠️ Authentication status
>
> **Exactly one route requires authentication: `GET /api/v1/auth/me`.**
>
> `require_role` is imported at `main.py:14` and applied to nothing. Every other route below — including all `POST`, `PATCH`, and `DELETE` — is reachable with **no cookie at all** [verified]. The frontend's `RequireAdmin` only hides UI.
>
> The "Auth" column below records what *should* be required, based on how the UI gates each page. Treat it as the target state, not current behaviour. See [10-known-issues.md](10-known-issues.md) B-1.

---

## Conventions

- IDs are UUIDs unless noted.
- List endpoints take `limit` (default 50, max 200) and `offset` — **except `/companies/{id}/shipments`, which is unbounded**.
- Errors: `404` not found · `409` unique conflict · `413` too large · `415` bad type · `422` validation.
- Responses are plain dicts built by `serialize()` (`main.py:44`), not Pydantic response models, so shapes are not enforced at the boundary.

---

## Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | — | Body `{email, password}`. Sets `c360_session` cookie |
| GET | `/auth/me` | **yes** | The only genuinely protected route |
| POST | `/auth/logout` | — | Clears the client cookie. **No server-side revocation** |

Cookie: `HttpOnly`, `SameSite=lax`, `Secure=false`, no expiry. Value is `{user_id}.{hmac_sha256(secret, user_id)}`.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Not under `/api/v1`. Returns `{"status":"ok"}` |

---

## Companies

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/companies` | user | Filters: `q`, `status`, `customer_type`, `inactivity_status`, `pay_term`, `has_shipments`, `has_documents`, `limit`, `offset` |
| POST | `/companies` | admin | Requires `icris_number` + `company_name` |
| GET | `/companies/{id}` | user | Detail + `vw_company_operational_summary` |
| PATCH | `/companies/{id}` | admin | **Every changed field is added to `manual_override_fields`** |
| DELETE | `/companies/{id}` | admin | Sets `status='archived'`. Does not delete |
| GET | `/companies/{id}/shipments` | user | ⚠️ **No pagination** — 16.3 MB for the largest customer |
| GET | `/companies/{id}/aliases` | user | |
| POST | `/companies/{id}/aliases` | admin | |
| DELETE | `/companies/{id}/aliases/{alias_id}` | admin | |
| GET | `/companies/{id}/documents` | user | Filters `q`, `category`, `status` (defaults to `active`) |
| POST | `/companies/{id}/documents` | user | Multipart. See [05-imports.md](05-imports.md) |
| GET | `/companies/{id}/storage-stats` | user | Bytes/count by category and extension |
| GET | `/companies/{id}/analytics` | user | ✅ Correctly groups by `weight_unit` and `value_currency` |
| GET | `/companies/{id}/activity` | user | |
| GET | `/companies/{id}/dossier-pdf` | user | ReportLab PDF. Params `date_from`, `date_to`, `timeframe_label` |
| POST | `/companies/{id}/assign-ae` | admin | Body `{ae_code}`. Updates **all** shipments for the company |
| POST | `/companies/{source_id}/merge/{target_id}` | admin | ⚠️ **HARD DELETE** of source. See below |

### `status` filter values

`official` → `is_provisional = false` · `provisional` → `is_provisional = true` · anything else → matched against `company_status`.

### `inactivity_status`

Derived in **Python**, not SQL (`main.py:82`), from `days_since_last_shipment`:

| Bucket | Days |
|---|---|
| `active` | < 30 |
| `quiet` | 30-59 |
| `inactive` | 60-89 |
| `dormant` | ≥ 90, or no shipments |
| `reactivated` | shipped this month, nothing in the prior 6 months (SQL-side) |

Because it is computed after the query, filtering happens as a list comprehension over all materialised rows.

### ⚠️ `merge_companies`

```
POST /api/v1/companies/{source_id}/merge/{target_id}
```
Reassigns shipments, documents, quality issues, and activity logs to the target, adds the source name as an alias, then `db.delete(source)` — **the only hard delete of a business entity in the codebase**. It does not check `manually_matched`, writes no audit record, and filters `ActivityLog` by `entity_id` without `entity_type`. Currently unauthenticated.

---

## Shipments

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/shipments` | user | Filters: `q`, `company_id`, `shipment_number`, `package_id`, `shipper_name`, `importer_name`, `importer_telephone`, `export_country`, `import_country`, `bill_type`, `billing_term`, `match_status`, `manifest_batch_id` |
| GET | `/shipments/stats` | user | Same filters. Totals + match-status breakdown |
| POST | `/shipments` | admin | Manual creation |
| GET | `/shipments/{id}` | user | Includes company, MAWB, packages |
| PATCH | `/shipments/{id}` | admin | Accepts any column except id/number/timestamps. **Adds each to `manual_override_fields`** |
| GET | `/shipments/{id}/packages` | user | |
| POST | `/shipments/{id}/packages` | admin | |
| GET | `/shipments/{id}/activity` | user | |
| POST | `/shipments/{id}/link-company` | admin | Body `{company_id, save_as_alias}`. Sets `manually_matched` |
| DELETE | `/shipments/{id}/company-link` | admin | Unlinks, sets `manually_matched=True` |

> `PATCH /shipments/{id}` records `shipment_date` in `manual_override_fields`, but CRM sync overwrites it anyway (`crm_sync.py:96`). See [03-data-rules.md](03-data-rules.md) rule 4.

## Packages

| Method | Path | Auth |
|---|---|---|
| GET | `/packages/{package_uuid}` | user |
| GET | `/packages/by-package-id/{package_id}` | user |
| PATCH | `/packages/{package_uuid}` | admin |

## MAWBs

| Method | Path | Auth |
|---|---|---|
| GET | `/mawbs` | user |
| GET | `/mawbs/{mawb_id}` | user |
| GET | `/mawbs/by-number/{mawb_number}` | user |

Returns PP/FC/FD totals **separately**. Do not sum them in new code.

---

## Search

| Method | Path | Notes |
|---|---|---|
| GET | `/search?q=&limit=` | Cross-entity: companies, aliases, shipments, packages, documents, MAWBs |

Results carry a `rank` (lower = better): exact ICRIS 1 · exact tracking 2 · exact package 3 · normalized name / exact MAWB 4 · exact alias 5 · … · documents 11.

> Two quirks: the exact-match rank compares against the **untrimmed** query (`:756`) while the `LIKE` uses `q.strip()` (`:743`), so padded input ranks badly; and MAWB metadata sums `pp+fc+fd` weight (`:790`).

---

## Matching review

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/matching-review` | admin | All `suggested` + `unmatched` shipments. **Unbounded** |
| GET | `/matching-review/{shipment_id}` | admin | |
| POST | `/matching-review/{shipment_id}/link` | admin | Body `{company_id, save_as_alias}` |
| POST | `/matching-review/{shipment_id}/reject-suggestion` | admin | Clears the suggestion, marks manual |

## Data quality

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/data-quality/issues` | admin | Filters `issue_type`, `severity`, `status`, `company_id`, `shipment_id`, `mawb_id`, `sync_run_id`, `limit` (100), `offset` |
| PATCH | `/data-quality/issues/{id}` | admin | Body `{status, reason}` |
| GET | `/quality-issues/company-conflicts` | admin | ⚠️ Fans out — 29 rows over 12 distinct `source_id` |

> The conflicts endpoint returns one row per (source, target) pair. The UI keys on `source_id` alone, which is **not unique**. See [10-known-issues.md](10-known-issues.md) M-2.

---

## CRM sync

| Method | Path | Notes |
|---|---|---|
| GET | `/crm-sync/status` | Worker heartbeat, queue depth |
| GET | `/crm-sync/diagnose` | Connector diagnostics. **No frontend client method exists** |
| GET | `/crm-sync/runs` · `/crm-sync/runs/{id}` | Run list / detail |
| POST | `/crm-sync/runs/{id}/cancel` · `/retry` · `/resume` · `/reprocess` | Run control |
| POST | `/crm-sync/items/{id}/retry` | Retry one manifest |
| POST | `/crm-sync/manifests` | Queue a date range. Body: `direction`, `date_from`, `date_to`, `dry_run`, `maximum_manifests`, `retry_failed`, `force_reparse` |
| POST | `/crm-sync/export/{record_id}` | Queue one export manifest. `?dry_run=true` |
| POST | `/crm-sync/export-record` | Queue by record reference |
| POST | `/crm-sync/sync-now` | Immediate incremental |
| POST | `/crm-sync/updates` · `/updates/preview` | Incremental with overlap window |
| POST | `/crm-sync/rematch` | Idempotent ICRIS re-linking. Preserves manual links |
| GET/POST | `/crm-sync/backfills` · `/backfills/preview` · `/backfills/{id}` | Backfill create/inspect |
| POST | `/crm-sync/backfills/{id}/pause` · `/resume` · `/cancel` · `/retry` | Backfill control |
| POST | `/crm-sync/pnl` | UPS Profit/Loss sync (see below) |

**`dry_run=true` writes nothing to business tables** — it fetches, parses, validates, matches, and reconciles, recording predictions on the sync item. Use it first, always.

### UPS Profit/Loss (`POST /crm-sync/pnl`)

Pulls `MenifestPreview_UPSProLossTot.aspx` — a MAWB-level report (`MAWB, Date, Bill Amount, UPS Bill Amt, Profit/Loss`) — and writes `pnl_bill_amount`, `pnl_ups_bill_amount`, `pnl_profit_loss`, `pnl_source_checksum`, `pnl_synced_at` onto the matching `MasterAirWaybill` row. Body: `{date_from, date_to, dry_run}`.

- **Synchronous**, not queued through `CrmSyncRun`/`CrmSyncItem` — one date-range fetch per call, no worker involved.
- **Matches by `mawb_number` only, never creates a MAWB.** Manifests remain the sole source of MAWB existence. Unmatched (no MAWB row exists yet) and ambiguous (same `mawb_number` across multiple `manifest_date`s, none matching the P&L row's date) rows are counted in the response `stats` but not guessed at.
- **`date_to - date_from` is capped at 31 days** (422 if exceeded) — [verified] the CRM's own report times out on wide ranges (a full year times out even with zero matching data; a ~40-day range with real data returns in ~2s). Chunk wider backfills client-side, same as the existing 1/7/14/30-day backfill chunk sizes.
- History exists back to at least Jan 2020 [verified via a narrow window] — the earlier timeout is a range-width limit, not a data-depth one.
- Frontend: `api.syncPnl()`, surfaced on the dedicated **Profitability** page (`/app/profitability`) and on the Master Air Waybill detail drawer.

### Per-shipment UPS P&L (`POST /crm-sync/ups-pnl`)

Richer sibling of the above. Walks `MenifestPreview_UPS.aspx` for a date range, then fetches each
manifest's `S_MenifestPrevUPS.aspx?ID=<n>` detail grid — a **12-column per-shipment** contract:

```
SN | Tracking No. | Shipper | Dest. | Wt(KG) | Pcs | Icris No | Bill Number | Bill Amount | UPS Discount% | UPS BillAmt | Profit/Loss
```

> Source spellings again: `Icris No` here has a **space**, unlike the manifest's `Icrisno`. Do not correct them.

Body `{date_from, date_to, dry_run, maximum_manifests}`; range capped at 31 days.

- **One CRM request per manifest**, so it is much heavier than the MAWB-level sync. Use
  `maximum_manifests` to bound a run. Per-manifest failures are reported individually in the
  response rather than failing the batch.
- Writes `shipments.pnl_bill_amount / pnl_ups_discount_percent / pnl_ups_bill_amount /
  pnl_profit_loss / pnl_bill_number / pnl_synced_at`, and refreshes the MAWB totals from the
  grid's `Total` row plus `ups_crm_record_id` / `ups_detail_synced_at`.
- **Matches shipments by exact trimmed tracking number; never creates shipments or MAWBs.**
- Blank cost cells stay NULL — see [03-data-rules.md](03-data-rules.md) rule 7c.

This unlocks **per-customer profitability**: `GET /analytics/customer-profitability`
(`date_from`, `date_to`, `sort=profit|margin|bill|loss`, `limit`) returns bill / UPS cost / profit /
margin per company, with `awaiting_cost_shipments` and `awaiting_cost_bill` reported separately so
uncosted shipments never inflate margin. Surfaced as "Profit by Customer" on the Profitability page.

---

## Imports

| Method | Path | Notes |
|---|---|---|
| POST | `/company-imports/preview` | Multipart `.xlsx`. Analyses, writes nothing |
| POST | `/company-imports` | Multipart + `mapping_json`. Transactional |
| GET | `/company-imports` · `/{batch_id}` · `/{batch_id}/rows` | History |

There is **no manifest-import route** — see [05-imports.md](05-imports.md).

---

## Documents

| Method | Path | Notes |
|---|---|---|
| GET | `/documents/{id}` | Metadata |
| GET | `/documents/{id}/content` | Inline. **PDF and images only** (415 otherwise) |
| GET | `/documents/{id}/download` | Attachment, any type |
| PATCH | `/documents/{id}` | `title`, `category`, `description`, `tags`, `document_date`, `status` |
| POST | `/documents/{id}/archive` | |
| DELETE | `/documents/{id}` | Archives. Does not delete the file |
| POST | `/documents/{id}/replace` | New version, archives the old |

---

## Analytics

| Method | Path | Notes |
|---|---|---|
| GET | `/analytics/overview` | Headline counts, match rate, coverage |
| GET | `/analytics/dashboard` | Overview + trend + top customers + destinations + bill types |
| GET | `/analytics/executive-dashboard` | **The big one.** Params: `timeframe`, `date_from`, `date_to`, `compare_mode` (`pop`/`yoy`), `segment`, `status`, `destination`, `ae_code`, `min_revenue`, `max_revenue` |
| GET | `/analytics/ae-performance` | Per account-executive |
| GET | `/analytics/customers` · `/destinations` · `/bill-types` | From views |
| GET | `/analytics/values-by-currency` | ✅ Groups by `value_currency` |
| GET | `/analytics/weights-by-unit` | ✅ Groups by `weight_unit` |
| GET | `/analytics/import-quality` | Always empty (Excel import disabled) |
| GET | `/analytics/document-completeness` | |
| GET | `/analytics/data-quality` | |
| GET | `/analytics/geography` · `/operations` · `/alerts` | |
| ~~GET~~ | ~~`/analytics/{report}/export.csv`~~ | **Removed 2026-09-25** — unused, and it ignored AE scope. Excel exports are now built client-side per page (`frontend/src/lib/exportXlsx.ts`), except AWBs: `GET /shipments/export.xlsx` (same filters + AE scope as `GET /shipments`). |

### `timeframe` values

`today` · `yesterday` · `last_7_days` · `last_30_days` · `this_week` · `last_week` · `this_month` · `last_month` · `this_quarter` · `last_quarter` · `this_year` · `last_year` · `fiscal_year` (Jul-Jun) · `ytd` · `qtd` · `mtd` · `year_YYYY` · `year_range` · `custom` · `all_time`

Resolved by `get_timeframe_bounds` (`main.py:863`), which also computes the comparison period — previous equal-length span for `pop`, same dates last year for `yoy`.

> **Currency caveat:** `/analytics/executive-dashboard` and `/analytics/ae-performance` compute revenue as `COALESCE(bill_amount, declared_value, 0)` and label it `USD` via `coalesce(value_currency,'USD')`. Both assumptions are unsupported. See [03-data-rules.md](03-data-rules.md) rule 6.

---

## Admin

| Method | Path | Notes |
|---|---|---|
| POST | `/admin/backup` | Creates a backup |
| GET | `/admin/backups` | Lists them |
| GET | `/admin/backups/{filename}/download` | ⚠️ Unauthenticated database backup download |

**There are no user- or role-management endpoints.** The frontend's Users / Roles / Audit Logs / Settings pages are static mockups with no backend.
