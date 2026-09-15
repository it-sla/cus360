# Session Handoff Pt.2 — 2026-08-10

Continuation of `HANDOFF.md` (2026-08-07 to 2026-08-10). Read `CLAUDE.md` and `docs/` first —
this file is a point-in-time summary of what changed, not a replacement for the permanent docs.
Update `docs/10-known-issues.md` and `docs/03-data-rules.md` if anything here turns out to be
stale by the time you read it (I already added several entries there — see §9 below).

## 1. Universal Search click-through was broken (backend + frontend)

**Problem found:** every non-company search result routed to the wrong place. Shipment/package
results linked to `/customers/{company_id}` (or just `/awb` if unmatched — the whole list, not
the shipment). MAWB results always linked to the bare `/mawb` list, discarding which MAWB was
searched. Document results linked to `?tab=documents` but `Customer360.tsx` never read that
param, so it always opened on Overview.

**Fix:**
- `main.py` `/search` — shipment/package results now link to `/awb?shipment={id}`, MAWB results
  to `/mawb?mawb={id}`. Archived documents excluded from results (the Documents tab hides them,
  so a document result was clickable into a tab that looked empty).
- `AirWaybills.tsx` / `MasterAirWaybills.tsx` — both now read `?shipment=`/`?mawb=`/`?search=`
  from the URL on mount and via a `useEffect` (route doesn't remount on query-param-only nav) and
  auto-open the correct detail drawer directly by ID.
- `Customer360.tsx` — now reads `?tab=` and initializes `activeTab` from it (validated against
  the known tab list).

Verified live: every result type opens the exact record searched for, including from a filtered
view (chip-filtered to AWBs only, still deep-links correctly).

## 2. Air Waybills filters — Date Range was completely dead

**Problem found:** the Date Range dropdown (Today/This Week/This Month/Custom Range) existed in
the UI but was never sent to the API — picking any preset changed nothing. The backend
`/shipments` endpoint didn't even accept a date param, so there was nothing to wire up.

**Fix:** added `date_from`/`date_to` to `GET /shipments` (filters on `created_at`, since that's
the column the table actually displays as "Date", not `shipment_date`). Added a
`resolveDateRange()` helper in `AirWaybills.tsx` that turns the preset/custom selection into real
dates sent on every request. Also fixed "Clear Filters" not appearing when only the date filter
was active.

Verified live: "This Week" narrowed 56,189 → 50 results (previously a no-op).

## 3. System-wide hover-effect cleanup

**Two related but distinct bugs**, both from the same root cause pattern (`hover:bg-X
dark:bg-Y` instead of `hover:bg-X dark:hover:bg-Y` — missing the `hover:` prefix on the dark
variant, so the dark background applied *unconditionally*, then hovering flashed a light
background on top of it):

- Fixed the technical bug (added `dark:hover:` prefix) on buttons where the hover state itself is
  wanted — Refresh buttons, pagination, drawer close buttons, row-menu items — across
  `AirWaybills.tsx`, `MasterAirWaybills.tsx`, `Customer360.tsx`. Also fixed several malformed
  classes with a typo'd double-opacity suffix (`dark:bg-slate-800/50/50`, `.../50/80`) that
  weren't applying any background at all.
- Per explicit instruction, **removed** the row-hover background wash entirely from every data
  table across the app (`AirWaybills`, `MasterAirWaybills`, `Customer360`, `OperationalAnalytics`,
  `GeographyAnalytics`, `BusinessAnalytics`, `CustomerAnalytics`, `ExecutiveOverview`,
  `CustomerDirectory`, `CrmSync`, `admin/Users`, `admin/AuditLogs`, `DataQuality`) — kept
  `cursor-pointer` for the clickability affordance, dropped the background. Selected/active row
  state (a different thing from hover) now uses a neutral `bg-slate-100 dark:bg-slate-800` or, on
  the Data Quality issue-type filter row, a thin colored left border + label instead of a full
  background wash.

## 4. Business Analytics filter cleanup (Geography, Operational KPIs)

Removed the Segment filter from both pages — it was never wired into the backend `apply_filters`
on either `/analytics/geography` or `/analytics/operations`, so picking a segment silently did
nothing. Removed the free-text AE Code input too — unlabeled, no validation, duplicates what AE
Performance already does properly. Kept everything functional: Date Range, Compare Mode,
Country/Origin/Destination (Geography) or Origin/Destination/MAWB (Operations), Export Only.

**Known data gaps surfaced, not fixed** (pre-existing, not caused by this): `export_country` is
blank for all 56,189 shipments (Geography's "Top Export Countries" is one "Unknown" bucket), and
`dimensional_weight` is populated but always `0` (Operational's "Chargeable Weight" is always 0).
Both trace back to the CRM manifest not carrying that data, not a bug in these pages.

## 5. Customer 360 — PDF export, Analytics tab, Documents tab

- **The "PDF" button did nothing real** — it called `window.print()` (screenshots whatever tab
  is open) instead of the actual backend dossier endpoint (`GET
  /companies/{id}/dossier-pdf`, which already existed and generates a proper multi-section
  report). Wired it up for real via a new `api.downloadCompanyDossier()`.
- The dossier endpoint itself had three real bugs, fixed: crashed on `CompanyDocument.created_at`
  (doesn't exist, it's `uploaded_at`); crashed on `c.ae_code` (not a Company column — AE is
  derived from shipments, queried it correctly); crashed on any company name containing `&`
  (unescaped XML in ReportLab `Paragraph` markup — several real companies have `&` in their
  name, e.g. "Iconic Nepal Tours & Treks"). Also enriched it: added Legal Name, Address, AE, and
  Total Revenue to the master details table, a real Documents Vault table, and a Recent Activity
  section.
- **Analytics tab was showing fabricated-looking empty charts** — "No weight data" / "No value
  data" for every company. Root cause: the query filtered on `shipment_weight` (NULL for literally
  every shipment in the DB) and `declared_value` (also NULL for all 56,189 rows — revenue actually
  comes from `bill_amount` + pay term). Rewrote the endpoint to use the same
  `coalesce(shipment_weight, actual_weight)` and `REVENUE_AMOUNT_SQL` logic used correctly
  elsewhere, added a date-range filter (reusing `AnalyticsFilterBar`'s `DateRangeControl`) and
  real KPI cards (Revenue, Shipments, Weight, Avg Shipment Value) with period-over-period deltas.
  Dropped the "Declared Values by currency" chart — the underlying column is empty everywhere,
  it could never have shown anything real.
- Documents tab's download link was hardcoded to `http://localhost:8000` — wrong port from the
  browser's perspective, bypasses the Vite proxy. Fixed to a relative path.

## 6. Customer Directory — Weight column + flexible filters

- Added a sortable **Weight** column (kg/tonnes) — backend `GET /companies` was missing
  `total_weight` entirely.
- Added a "More Filters" panel: Country, AE Code, Min/Max Revenue, Min/Max AWBs, Min/Max Weight
  — all debounced, all wired into new backend query params on the same endpoint. Verified live:
  Min Revenue = 5000 correctly cut matches from 1,003 → 199.

## 7. Master Air Waybills — MAWB drawer was showing wrong/broken data

- **Weight was always "—"** for every HAWB — same root cause as §5, read `shipment_weight`
  instead of `actual_weight`. Fixed with a computed `weight` field on the backend.
- **Billing Breakdown was silently wrong** — it bucketed by `bill_type` (only ever
  "Non-Doc"/"Document"/"Letter", a customs classification) into PP/FC/FD labels, so *every* MAWB
  showed 100% "OTHER" regardless of actual pay terms. Fixed to key on `pay_term` (the real
  billing classification) — verified a real MAWB now correctly shows Prepaid: 15/138kg, Freight
  Collect: 5/65kg instead of Other: 20/203kg.
- Added: Billable Revenue and Customers-linked stat cards, match-status badges per HAWB
  (Matched/Suggested/Unmatched/Invalid ICRIS), destination/pieces/revenue columns, a live HAWB
  search box, and — after a user follow-up — **why** an unlinked HAWB has no customer (e.g. `No
  ICRIS — manifest has "."` vs `ICRIS "R110019" matches no customer"`), since "INVALID ICRIS"
  alone didn't say what to go fix in the CRM. Found in the process: the "unmatched" rows almost
  all carry placeholder junk (`.`, `-`, `/`) in the ICRIS field, not blanks — 3,727 shipments have
  literally `.` as their ICRIS.

## 8. Data Quality page — was a thin, dangerous merge-suggestion list

**The `/quality-issues/company-conflicts` endpoint was a real hazard, not just thin UI.** It
emitted one row per (provisional-company, candidate-match) pair with no score, no ranking, no
dedup — a provisional company literally named "Nepal" produced **18 identical-looking "Possible
Typo → Master Record" merge buttons**, any of which would hard-delete it into an unrelated
company (merge is the one operation in this system that permanently deletes a record). Rewrote
the query to return one row per source company — its single best-scoring candidate — with a
similarity score, match reason (exact name / prefix / fuzzy), a confidence tier, and an
`other_candidates` count so an ambiguous match is flagged rather than silently offered as if it
were certain. "Nepal" now surfaces as one row, clearly marked ambiguous, with a warning that 17
other companies match equally well.

Also, for the `data_quality_issues` inbox (82,653 open rows): added a real summary endpoint
(counts by type/severity/status, affected customers/shipments), search + pagination on the issue
list (previously would have tried to render all 82k rows), bulk resolve/ignore by filter (with a
guard requiring at least one filter — refuses to blindly update every issue), and made the detail
column type-specific instead of dumping raw JSON keys (e.g. `Manifest says "X" · record says
"Y"` instead of `official_name: Y`).

Also removed a distracting hover-wash on the "Issues by Type" filter row per user follow-up (same
pattern as §3, this one specific to this page).

## 9. CRM sync schedule — was firing at 2:45 AM Nepal time, not 9 PM

**Real bug, not just a suboptimal setting.** `CRM_SCHEDULE_CRON="0 18,21 * * *"` was intended as
6pm/9pm, but `crm_worker.py`'s cron matcher compares against the container's OS clock, which is
**UTC**, not Nepal time (NPT, UTC+5:45). It was actually firing at **11:45 PM and 2:45 AM NPT** —
the middle of the night. Changed to `"15 8,14 * * *"` (2:00 PM and 8:00 PM NPT, chosen with the
user: early afternoon to catch the morning's entries in one pass, evening to catch the full day
after close of business) and documented the UTC requirement in `.env`, `.env.example`,
`docs/04-crm-sync.md`, `docs/09-development.md` so this doesn't drift again. Recreated the
`backend`/`crm-scraper` containers so the change actually took effect (docker compose only
re-reads `.env` on `up`, not `restart`) and verified against the worker's real matcher function.

Found two more bugs while wiring this up:
- `/crm-sync/status`'s human-readable schedule label was a **hardcoded string**
  (`"6:00 PM & 9:00 PM Daily"`) completely disconnected from the actual cron value — would have
  kept showing the wrong description forever regardless of config. Replaced with
  `describe_crm_schedule()`, which parses the real cron and converts UTC→NPT.
- `link_icris`'s auto-resolve path (clears `crm_blank_icris`/`crm_invalid_icris` when a later
  sync fills in the ICRIS) set `status='resolved'` but never `resolved_at` — 349 already-resolved
  issues had a null timestamp, so there was no way to measure how long an issue actually took to
  clear. Fixed to match the manual/bulk resolve paths.

**Not done:** the schedule isn't shown anywhere in the `CrmSync.tsx` frontend page —
`incremental_schedule` exists on the API but nothing renders it. Pre-existing gap, not touched.

## 10. AE Assignment — new feature, built from a real spreadsheet

User has a 565-row "AE Territory Assignment" workbook (Account Executive / Customer Name /
Location / Customer/ICRIS Code) they want imported, with AE reassignment and targets on the
roadmap. Investigated first: there was no AE roster at all (`ae_code` was a free string repeated
across `shipments` rows), a company's "assigned AE" was *inferred* from whichever shipment
happened to sync most recently, and the existing `assign-ae` endpoint did a blunt
`UPDATE shipments SET ae_code=...` with no audit trail and no protection against a future CRM
sync silently overwriting it.

**Confirmed with the user before building:** reassignment overwrites shipment history (not a
going-forward-only model), manual assignment always wins over CRM, and AE codes for the four
names in the sheet: `PS=Pratik, AS=Ankit, DN=Dinesh, PR=Prakash, RT=Rupesh, NT=Namuna, AJ=Akrit`.
Unmatched ICRIS rows are skipped and reported, never auto-created as provisional companies.

**Built** (migration `20260810_0011`):
- `account_executives` roster, `companies.assigned_ae_code` (the new stable "current AE" fact),
  `ae_reassignment_log` (audit trail), `ae_import_batches`/`ae_import_rows`.
- `ae_imports.py` — preview/commit import matching the user's exact headers (no reformatting
  required of them), resolving both code formats in their AE column (bare `SLR`, suffixed `DN
  (Key & Central)`, and the four names via the confirmed map).
- **"Manual always wins" reused existing plumbing** rather than adding new protection:
  `Shipment.manual_override_fields` already exists and CRM sync already respects it
  (`crm_sync.py:100`). Reassignment now stamps `'ae_code'` into it on every touched shipment, and
  `link_icris` independently re-forces `company.assigned_ae_code` onto shipments the CRM creates
  or updates later — verified live by simulating a CRM re-sync bringing a different AE code and
  confirming both layers block it.
- New `AeAssignment.tsx` page (Data & Integration nav) — Import tab (upload → preview with
  unmatched/unknown/duplicate breakdowns → confirm → history) and Roster tab (names, active
  toggle, per-AE customer counts).

**⚠️ Testing mistake, caught and fixed — know about this before touching AE data:** while
verifying the commit endpoint, I ran it against 5 real companies (Arihant Collection, Kantipur
Galaicha, Looksee Rugs, Trust Weave Rugs, Nepal Tea Collective) instead of disposable test data,
overwriting 401 real shipments' genuine historical `ae_code` with fabricated test values. Caught
it, recovered the original values from `crm_raw_manifest_rows.raw_values_json->>'AE'` (the
untouched raw CRM snapshot, distinct-on shipment_id ordered by most recent `created_at`), and
verified per-company the restored distribution matches what the reassignment log said was
touched (e.g. Looksee Rugs: 285 RT + 4 blank = 289, matching the logged `shipments_updated`).
Confirmed clean via `qa/test_data_rules.py` (17/17) and the full backend suite (98/98) afterward.
**If AE-related numbers look off for these 5 companies, that's the incident to check first** —
though it should be fully reverted.

**Not built yet** (explicitly deferred, in this order): AE Dashboard (revenue/shipments per AE,
customer roster, reassignment history in one view) and AE Targets (manual entry now, CRM import
later once the user finds the actual page in their CRM for it — did not guess at an unverified
CRM URL).

## Verification status as of end of session

- Backend: `docker exec customer360-backend-1 python -m pytest -q` → **98/98 passing** throughout
  every change in this session.
- Data rules probe: `qa/test_data_rules.py` → **17/17 passing**, re-run after every change that
  touched matching/sync/assignment logic.
- Frontend: `npx tsc -b --noEmit` → no new errors introduced (same pre-existing ~13 real errors
  in untouched files as documented in `docs/10-known-issues.md`).
- `npm run lint` → passes (warnings only, matches documented baseline, no new warnings).
- Live-tested in browser for every change: Universal Search (all result types + keyboard nav),
  Air Waybills date filter, Geography/Operational filter bars, Customer 360 PDF export + Analytics
  tab + Documents download, Customer Directory weight column + flexible filters, MAWB drawer
  billing breakdown + HAWB detail reasons, Data Quality issues/merge tabs, AE Assignment import
  (full upload→preview→commit→history flow via a programmatically-constructed File, since this
  remote browser sandbox can't drive a native OS file picker) and roster.

## Loose ends / things worth knowing for next session

- **AE Dashboard and AE Targets are the natural next piece** — schema and import are done, the
  read-side (per-AE revenue/shipments actuals vs targets, attainment %) isn't built yet.
- `docs/10-known-issues.md` D-12 and D-13 document the CRM schedule timezone bug and the missing
  `resolved_at` bug (§9) — both marked fixed with dates, keep that pattern going.
- The known data gaps from §4 (`export_country` and `dimensional_weight` always empty/zero) are
  still open — would need a CRM manifest/parser investigation, not a UI fix.
- `CrmSync.tsx` still doesn't display the configured schedule anywhere in the UI (§9) — small,
  deferred, not asked for yet.
- The broader auth gap noted in `HANDOFF.md` pt.1 (no `require_role` on ~100 routes, forgeable
  session cookie) is still open — this session added `RequireAdmin`-gated routes for
  `ae-assignment` matching the existing `sync`/`matching`/`quality` pattern, but that's
  frontend-only route gating, not real backend authorization (same caveat as everything else
  behind `RequireAdmin` per the existing known issue).
