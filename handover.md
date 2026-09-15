# Session Handover — Customer 360

**Date:** 2026-08-25
**Scope:** New CRM Daily Call Logs feature (backend + frontend, scheduled sync) → a long run of UI cleanup across Customer Directory, Business Analytics, Customer Analytics, AE Performance, Geography, Operational KPIs → a full role-based access control implementation (RBAC) → Data Quality issue messaging fix. Everything below is **local only** — nothing was deployed to the remote server this session. See `handoversession.md` (2026-08-24) for the deploy pipeline mechanics if you need them; that doc's "undeployed changes" list is now much longer after this session.

---

## 1. Local dev environment

Stack is up and healthy via a normal `docker compose up -d` — no hand-run containers, no port conflicts this time (the `cargo360-db` conflict from the prior session's handover is gone, that container is stopped). All 6 services running: `db`, `backend`, `frontend`, `web`, `pgadmin`, `crm-scraper`.

**Nothing deployed to the remote server this session.** Confirm current prod state before assuming anything below is live — it almost certainly isn't.

---

## 2. New feature: CRM Daily Call Logs

User wanted the CRM's `CRM_DairyAEList.aspx` page ("Daily Call Logs" — despite the URL name, it's not an AE roster, it's a log of sales calls) pulled into the app, scheduled like everything else in CRM Sync.

**Backend, fully built and tested against the live CRM:**
- `models.py`: new `DailyCallLog` table (`call_date`, `company_name`, `crm_customer_id`, `stage`, `category`, `contact_person`, `phone`, `call_type`, `ae_code`, `remarks`, `supervisor_comment`, `follow_up_date`, `source_row_hash` for dedup, `scraped_at`). Also added `User.ae_code` (nullable) — this is the field that later became the backbone of RBAC (§5).
- Two migrations: `83a020547ce8` (table + User.ae_code) and `75c1bf35d6b3` (added `source_row_hash` after realizing dedup needed a content hash — the CRM page has no per-row ID, only company+date+AE+remarks).
- `crm_connector.py`: `daily_call_logs(date_from, date_to)` method, same POST-date-range pattern as the existing `pnl_list`/`ups_list`.
- `crm_parser.py`: `parse_daily_call_logs()` — verified live against real CRM data, correctly extracts all 11 columns plus `crm_customer_id` from the `S_Entry2.aspx?ID2=` link.
- `crm_sync.py`: `sync_daily_call_logs()` — append-only insert, dedups via `source_row_hash` (content hash of customer+date+ae+type+contact+remarks), not truncate-and-replace like Pipeline.
- `crm_worker.py`: `check_daily_call_logs_auto_schedule()`, wired into the main loop tick alongside pipeline/pnl checks. Own cron (`CRM_DAILY_CALL_LOGS_SCHEDULE_CRON`, defaults `45 6,12,18 * * *`), own lookback window setting (`CRM_DAILY_CALL_LOGS_SCHEDULE_LOOKBACK_DAYS`, default 7).
- New endpoints: `GET /companies/{id}/call-logs` (per-company), `GET /call-logs` (standalone, filterable by `ae_code`/`category`/date range).
- `.env` / `.env.example`: `CRM_DAILY_CALL_LOGS_URL` set to the real CRM page.

**Frontend:**
- Customer 360 gets a new "Call Logs" tab (between Shipments and Documents) — per-company call history.
- New standalone page `pages/CallLogs.tsx` at `/app/call-logs`, in the Intelligence nav group — full list, filterable by AE and category.

**Known gap, not fixed:** no company in the DB has `crm_customer_id` populated (0 out of ~1000+), so the per-company Call Logs tab will show "No call logs found" for everyone until something starts writing that field during CRM sync. The standalone `/app/call-logs` page works fine since it doesn't need that join.

---

## 3. UI cleanup pass (many small fixes, all verified live)

- **Customer Directory**: removed the entire "Actions" column (Edit/Delete/View AWBs — all dead or duplicated Customer Management), then later in the session removed "Add Customer" too (open to any authenticated role, no gate, duplicated Customer Management's own flow). Directory is now pure browse/lookup — click a row to open Customer 360, nothing else.
- **Business Analytics**:
  - Found and fixed a real logic bug: the "Customer Status Distribution" pie's `Active` bucket was catching every customer that wasn't explicitly `New` or `Dormant` — including ~900 of ~1000 total customers that have **never shipped at all**. Added a proper `No Activity` bucket, excluded it from the pie (with a caption explaining why), kept it in the filter dropdown/data grid for anyone who wants to audit it.
  - Donut chart labels were getting clipped (`labelLine` overflow) — disabled on-chart labels on both donuts, legend + tooltip carry the info instead.
  - Interactive Customer Data Grid cut from 100 rows to top-10, Status/Action columns removed, whole row now clickable → Customer 360 (was a separate "View →" link before).
  - Added "View More" expand/collapse to Destination and AE revenue tables (previously silently capped at 10 with no way to see the rest).
- **Customer Analytics**: this one had the deepest bug of the session.
  - Removed Retention Rate and Shipped Customers as separate KPI cards per request, then **redefined Total Customers** to mean "ever shipped" instead of "every record on file" — but the first attempt broke because Total Customers came from a totally different API query (`getCompanies(status=official, has_shipments=true)` → 437) than Active/Dormant/New/Reactivated (all computed from `revenue_analytics.all_customers` → 1041, includes provisional companies). Fixed by computing everything from the same array.
  - Then found a second, sneakier bug on top: the backend never sends `null` for `last_shipment_date` — companies that have truly never shipped get an epoch sentinel (`1970-01-01`) instead. My first "everShipped" check used raw truthiness and got fooled into counting all 1041 as "shipped." Fixed by checking against the literal sentinel value. Final numbers: Total 656, Active 77, Dormant 498 — internally consistent, verified live.
  - KPI row cut from 9 cards to exactly 6, single dense row.
  - Explained (twice, in different framings) how Retention Rate's math actually works — it's `(this period active − new) / last period active`, a month-over-month churn number, completely unrelated to the Total Customers figure. Not a bug, just non-obvious.
  - Added "View More" to Biggest Gainers/Decliners tables (same pattern as Business Analytics — were secretly capped at 10).
  - Revenue/Shipment Comparison Trend charts had zero informative labeling (fake "Day 1, Day 2..." x-axis, hidden labels, generic tooltip) — now show real dates pulled from a field (`period`) the backend was already sending but the frontend never used, plus a caption stating the actual date range being compared.
- **AE Performance**: KPI row cut from 7 (awkward layout) to 4 (Revenue, Shipments, Customers, Active) — removed At Risk/Dormant, New/Reactivated, Target Attainment (and the now-dead `teamTarget` computation). Removed the "Insights" auto-generated callout panel entirely. Removed the amber "N customers have no AE assigned" banner (and its now-dead `unassigned` variable / `UserX` icon).
- **Geography Analytics**: removed Origins/Destinations KPIs, Geographic Insights panel, Revenue Concentration pie, Top Destinations table, Trade Lanes table, Top Export Countries table. Kept the three bar charts and Customers by Country table.
- **Operational KPIs**: removed Chargeable Weight and Avg Chargeable KPIs (both permanently showed 0 kg — dead), removed Operational Insights panel and Origin vs Destination Routes chart, cut filters from 6 controls down to 2 (date range + compare mode only — dropped Origin/Destination/MAWB/Export Only).

Every single change in this section was verified live in the browser (not just typechecked) — screenshots/DOM checks confirmed, not assumed.

---

## 4. Data Quality: ICRIS Number Mismatch messaging

- The 8,768 open "ICRIS Number Mismatch" issues all showed the exact same hardcoded string, `"invalid ICRIS structure"`, regardless of what was actually wrong. Dug into real data: overwhelming majority are CRM staff typing `.` or `-` into the Icrisno field as a placeholder instead of leaving it blank.
- Added `invalid_icris_reason()` in `crm_sync.py` — names the actual failure (blank, too long, control characters, or "no letters/digits, not a real ICRIS") with the real value quoted inline.
- **Backfilled all 8,880 existing rows** in the DB with the corrected message (not just future ones — otherwise the old vague text would've lingered for weeks).
- Made every Data Quality issue row clickable → deep-links to `/app/awb?shipment={id}` (or `/app/mawb?mawb={id}` as fallback), opening the exact shipment/manifest drawer that caused the issue. Reused deep-link support both pages already had but nothing was linking to. Resolve/Ignore buttons still work independently (`stopPropagation` added).

---

## 5. Role-Based Access Control (the big one)

Full plan + implementation status is in **[ROLE.md](ROLE.md)** — read that file, don't re-derive this from scratch. Summary:

- Two new roles added: `sales_lead` (everything except Data & Integration + Administration nav groups) and `ae` (own data only, everywhere, never Profitability). `admin` and `user` (fallback/unconfigured) unchanged.
- `auth.py`: `require_role()` now takes a list not just one string; new `get_ae_scope()` dependency (the thing every row-scoped query filters on); `/auth/me` now returns `ae_code`.
- **Found and fixed a real pre-existing security gap along the way**: 36 backend routes (all of Matching Review, CRM Sync, Data Quality, AE Targets, AE Territory Assignment, Company Imports) had **zero backend role enforcement** — only frontend `RequireAdmin` was gating them, meaning a direct API call from anyone logged in could hit them. All now `admin`-only server-side.
- Real row-level `ae_code` filtering (actual SQL `WHERE` clauses, not display hiding) wired into: Companies (list + detail + shipments/documents/analytics sub-resources), Shipments, MAWBs, Executive Dashboard (covers Executive Overview/Business Analytics/Customer Analytics for free since they share one backend engine), AE Performance, Geography, Operations, Rankings' Top Customers, Active Pipeline, Alerts, Call Logs.
- Users admin page: role dropdown now offers all 4 roles; picking "AE" shows an AE Code **dropdown** (not free text) sourced from the real `AccountExecutive` table, with backend validation (`422 Unknown AE code`) so nobody can create an AE account pointed at a code that doesn't exist.
- Also fixed two related gaps found while working on this: `POST /companies/{id}/assign-ae` had no role check at all (any `user`-role account could reassign any customer's AE) — now `admin`-only, both backend and the Customer 360 UI (non-admins see the AE as read-only text, not an editable dropdown).
- Test suite: `conftest.py`'s shared `client` fixture was fully unauthenticated before (existing admin-flow tests were implicitly "admin" only because nothing checked). Now logs in as a real seeded admin test user. **132 tests pass** (was 89 in the old CLAUDE.md doc, which is stale — the real baseline was already 132, just never exercised with real auth before).
- Verified live end-to-end with real throwaway admin/sales_lead/ae accounts (created and torn down each time, nothing left in the DB): role gating 200/403 as expected, `ae`-with-no-code gets a clear 403 not silent failure, zero cross-AE data leakage confirmed on Companies/Call Logs/Alerts.

**Open items, listed in ROLE.md §6 and §8, not done:**
- AE Performance's "Leaderboard" naturally renders as one row for an `ae` caller now (scoping does this automatically) but the page copy/title still says "Leaderboard."
- No `sales_lead` read-only access to AE Territory Assignment (stays Administration-only, admin-only).
- Rankings' other tabs (Top Destinations, Customers by Country) weren't individually re-audited for `ae_code` scoping — only Top Customers is confirmed scoped since it shares the audited endpoint.
- No bulk tool for assigning `ae_code` to many existing users at once — fine for a handful via the Users page modal, not at real scale.

---

## 6. Where to pick up

- Nothing is deployed. If any of this needs to go live, the deploy pipeline from `handoversession.md` §1 still applies (tar-over-ssh, watch the `venv`/rsync/port-3600 gotchas documented there).
- The `crm_customer_id` gap (§2) blocks the per-company Call Logs tab from ever showing data until CRM sync starts writing that field somewhere — worth checking whether `crm_sync.py`'s manifest linking already captures a CRM customer ID anywhere it could be threaded through.
- RBAC open items above are the natural next chunk of work if the role system needs to go further than "implemented and correct" into "fully polished everywhere."
- Everything in §3 was cleanup/simplification by explicit request — no half-finished states, but worth a final visual pass across all the touched pages together (they were fixed one at a time, never looked at side-by-side).
