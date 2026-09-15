# Session Handoff — 2026-08-07 to 2026-08-10

Working session on Customer 360 (internal cargo customer directory for Shangrila Courier).
Read `CLAUDE.md` and `docs/` first — this file is a point-in-time summary of what changed,
not a replacement for the permanent docs. Update `docs/10-known-issues.md` and
`docs/03-data-rules.md` if anything here turns out to be stale by the time you read it.

## 1. Revenue / Pay Term fixes (backend)

**Problem found:** blank CRM `Pay Term` rows were excluded from revenue entirely. Per the
business owner, that undercounts real revenue.

**Fix (`backend/app/crm_sync.py`, `upsert_detail`):** blank Pay Term is now inferred at sync
time — `PP` if the row has a `Bill amt`, `FC` if it doesn't — tagged in
`crm_field_provenance` as `crm_inferred`, still raises `crm_missing_pay_term` for visibility.
Backfilled the 926 pre-existing historical rows via `qa/backfill_infer_pay_term.py` (already
run — don't re-run unless new blank-pay-term shipments need the same treatment).

This **supersedes** the old "exclude blank terms" rule described further down in
`docs/03-data-rules.md` §6b — that doc has been updated in place with a note, but re-check it
directly if you're touching revenue logic again.

**Also fixed — a real bug found while chasing this:** `_add_alias` in `crm_sync.py` could
double-insert a `CompanyAlias` and crash a sync whenever the same shipper name appeared twice
in one manifest (session runs with `autoflush=False`, so the exists-check didn't see its own
pending insert). Fixed with an explicit `db.flush()` after `db.add()`.

**Sync freshness:** the CRM finalizes bills *after* the manifest is first synced (observed a
$0 → real amount correction 5-6 days later). The scheduled incremental sync only re-checked
the trailing **3 days**, so those corrections were never picked up. Widened to **14 days** via
a new setting `CRM_SCHEDULE_OVERLAP_DAYS` (in `.env` and `.env.example`), wired into
`crm_worker.py:check_auto_schedule`. If corrections are observed even later than 14 days,
just bump that env var — no code change needed.

**Also observed but not fixed:** the `crm-scraper` container had restarted 11 times on
transient DB-connection errors and missed a ~2-day sync window (Aug 5→7). It's stable now but
if the dashboard goes stale again, check `docker logs customer360-crm-scraper-1` first.

## 2. Business Analytics filter unification (frontend)

All 6 analytics pages (`ExecutiveOverview`, `BusinessAnalytics`, `GeographyAnalytics`,
`OperationalAnalytics`, `CustomerAnalytics`, `AEPerformance`) had 5 different copy-pasted
filter-bar implementations with diverging timeframe presets, one page with **wrong hardcoded
segment values** (`Enterprise/SMB/VIP/Dormant` instead of the real
`Strategic Account/Large Account/SME/Small Customer`), and several filters that were sent to
the API but had no UI control (dead state) or were applied client-side-only while looking
global.

**New shared component:** `frontend/src/components/AnalyticsFilterBar.tsx` — exports
`TIMEFRAME_GROUPS`/`TIMEFRAME_LABELS` (canonical preset list matching every value
`get_timeframe_bounds()` in `backend/app/main.py` actually supports), `SEGMENTS` (canonical
4-value list — **must stay in sync with `AE_SEGMENTS` in `main.py`**), `FilterSelect`,
`CompareModeSelect`, `DateRangeControl` (viewport-clamped popover), `fmtShortDate`.

All 5 non-AE pages now use this shared bar. `AEPerformance` keeps its own dark-themed popover
(different visual system, not touched) but should still be checked if the canonical timeframe
list changes.

Backend: added `bounds` to the Geography and Operations analytics endpoint responses
(previously only Executive Dashboard and AE Performance had it) so the date-range label
resolves consistently everywhere.

## 3. Customer Directory + Customer Analytics fixes

- **Real bug:** the customer preview drawer (`CustomerDirectory.tsx`) read
  `company.revenue/shipment_count/country/ae_code` from the wrong response shape —
  `GET /companies/{id}` never returned those fields. Every customer showed $0 revenue,
  "Unknown" country, "UNASSIGNED" AE regardless of reality. Fixed by computing them in the
  backend endpoint (mirrors what the list endpoint already did).
- **Fake data removed:** a hardcoded "94.2% Repeat Rate" shown identically for every customer.
  Replaced with a real per-customer metric: `REPEAT_RATE_SQL` in `main.py` — % of calendar
  months between first/last shipment with at least one shipment (0% for single-shipment
  customers, not the degenerate 100% a 1-month span would give).
- **Pagination bug:** Customer Directory's "Showing X of Y accounts" used the client-side
  loaded-page count (`rawItems.length`, capped at 200) instead of the backend's real `total`,
  so it silently claimed only 200 accounts existed when 1,004 actually matched. Now shows both
  honestly: "...of 200 loaded · 1,004 accounts match these filters — narrow your search...".
- **"Total Customers" KPI clarified, not just relabeled:** it counts all official
  (non-provisional) company records, **including ones that have never shipped** (344 of 781
  currently). Added a separate **"Shipped Customers"** KPI (437) next to it on
  `CustomerAnalytics.tsx` rather than conflating the two — this was an explicit user decision,
  don't silently merge them back.

## 4. AE revenue reconciliation — methodology, for next time

Spent a while chasing an "AE RT revenue doesn't match CRM" report. Root cause both times:
**date-range mismatches**, not calculation bugs. Method that worked:

1. Get the exact row-level CRM report the user is comparing against (ask for it if not given —
   don't guess at CRM report semantics).
2. Sum it in Python/SQL, compare to the exact cent.
3. If it doesn't match, diff row-by-row (tracking number / ICRIS + date + weight) against our
   `shipments` table for the same AE/date range — the CRM report's row count vs ours is the
   fastest tell (we had 167 shipments, their report had 148 — 19 extra rows on our side, all
   dated one day past their report's cutoff).

Don't assume a revenue mismatch is a system bug — check date ranges and report scope first.

## 5. Administration pages (new)

Built out **Users** and **Audit Logs** for real; left **Roles** and **Settings** as stubs
(no Role or Settings data model exists — inventing one was explicitly out of scope this
session) and **removed them from the sidebar nav** (`app-shell.tsx`) since they're
unreachable-by-design now, though the stub routes/pages still exist for direct URL access.

Backend (`backend/app/main.py`):
- `log_activity(db, entity_type, entity_id, action, description, source, metadata)` helper —
  first time `ActivityLog` has ever been written to anywhere in the codebase (it existed as a
  model, read by 2 endpoints, written by none). Currently only called from the new
  user-management endpoints below — **not** retrofitted onto other mutations (out of scope).
- `GET/POST /api/v1/admin/users`, `PATCH /api/v1/admin/users/{id}`,
  `GET /api/v1/admin/audit-logs` — all behind `Depends(require_role('admin'))`. This is the
  **first and only** place `require_role` is actually applied in the whole app — everything
  else remains unauthenticated per the known issue in `docs/10-known-issues.md`. Don't assume
  this session fixed auth broadly; it didn't, on purpose (explicit scope decision).
- Guards: can't deactivate/demote yourself, can't deactivate the last active admin.
- No hard-delete endpoint for users — deactivation (`is_active=False`) only, matching the
  app's existing archival philosophy elsewhere.

Frontend: `frontend/src/pages/admin/Users.tsx` and `AuditLogs.tsx` rewritten from 1-line
stubs to real table/search/filter/modal pages. `frontend/src/api.ts` gained `adminApi`
(`getUsers`, `createUser`, `updateUser`, `getAuditLogs`) and `AdminUser`/`AdminUserPatch`
types.

## 6. Air Waybills / Master Air Waybills fixes

- Fixed a documented, real crash bug: `api.getShipment` didn't exist in `api.ts` at all
  (only `getShipments`, plural). Added it, hitting `GET /shipments/{id}`.
- Fixed two undefined-identifier crashes in JSX (`Check`, `Globe` icons used but never
  imported).
- `GET /shipments` and `GET /mawbs` now return a real `total` (previously absent — pagination
  fell back to `items.length`, which is wrong once there's more than one page). Both also gained
  proper filtered-count queries.
- `GET /shipments` gained `min_weight`/`max_weight` params — the weight-range filter on
  AirWaybills.tsx used to filter only the 50 already-loaded rows, not the full result set.
- Added a real `revenue` field to shipment responses (via the same `BILLABLE_PAY_TERMS`/
  `shipment_revenue()` logic used everywhere else) replacing a fake `weight * 12` placeholder
  in the UI.
- Destination filter changed from a hardcoded 5-country dropdown to a free-text input
  (matches how it's actually queried server-side — `ILIKE`, not an enum).
- Removed three inert row-menu actions (Track/Print/Duplicate — no backend behavior existed).
- Cleaned up dead copy-pasted imports in `MasterAirWaybills.tsx`.
- Incidentally fixed a pre-existing `Cannot find name 'Shipment'` type error in `api.ts` (the
  type was referenced in `MawbDetail` and `MatchingReview.tsx` but never defined) by adding a
  proper `Shipment` interface.

## Verification status as of end of session

- Backend: `docker exec customer360-backend-1 python -m pytest -q` → **98/98 passing**.
- Frontend: `npx tsc -b --noEmit` → no new errors introduced (pre-existing ~13 real errors in
  untouched files remain, per `docs/10-known-issues.md`'s documented 165-error build failure;
  `npm run build` is still known-broken, unrelated to this session).
- `npm run lint` → passes (warnings only, matches documented baseline).
- Live-tested in browser: all 6 analytics pages, Customer Directory + drawer, Customer
  Analytics KPIs, Users (create/edit/deactivate a test user, cleaned up after), Audit Logs
  (confirmed the above actions appear), Air Waybills (opened drawer — previously crashed, now
  doesn't), Master Air Waybills (opened MAWB drawer → drilled into nested shipment drawer).

## Loose ends / things worth knowing for next session

- **Docker Desktop crashed mid-session** (all containers exited) and had to be manually
  restarted (`docker compose up -d`). Not caused by this session's changes as far as we could
  tell — just noting in case it recurs.
- `docs/03-data-rules.md` §6b needs a fresh reconciliation run
  (`qa/reconcile_revenue_vs_crm.sql`) to establish a new baseline now that blank-Pay-Term
  inference changes monthly totals — the old "11/12 months match to the cent" reconciliation
  predates this change.
- The broader auth gap (no `require_role` on ~100 existing routes, forgeable session cookie,
  default `AUTH_SECRET`) is **still open** — only the 4 new admin endpoints got real
  server-side gating this session. See `docs/10-known-issues.md`.
- `Roles.tsx` and `Settings.tsx` are still 1-line stubs with routes reachable by direct URL
  (`/app/roles`, `/app/settings`) even though removed from nav — fine for now, but don't
  assume they're fully gone.
