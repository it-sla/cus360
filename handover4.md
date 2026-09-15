# Session Handover — Customer 360

**Date:** 2026-09-04
**Scope:** Two-tier admin/super_admin RBAC → Leaderboard wins fix + shared DateRangeControl → several small UI cleanups (Universal Search, Profitability, Customer Directory, Operational KPIs, Geography) → a real Daily Call Logs data bug (name-match fix + full historical backfill) → Data Quality page redesign (default-scope bug fix) → a brand-new notification-bell "Key Insights" feature built from scratch → a real false-positive alert bug (Revenue Decliner MTD-vs-full-month mismatch) → Customer Analytics export upgraded to real formatted `.xlsx`. Partial deploy happened mid-session (see §1) — most later work is **local only**.

---

## 1. What's actually deployed vs. not

**Deployed to `shangrila002` (early in this session, before most of the work below):**
- Only the super_admin/admin RBAC split (backend `require_role` changes, migration-free) and the frontend gating that goes with it.
- **Manual DB fix applied on remote**: both pre-existing admin accounts (`admin@gmail.com`, `adityap@gohimalaya.travel`) were promoted `admin` → `super_admin` so neither lost access to Data & Integration/Administration pages after the split shipped. Confirmed via live 403 checks against the real production API.

**NOT deployed — everything else in this doc:**
- Leaderboard Wins fix + DateRangeControl reuse
- Universal Search / Profitability / Customer Directory / Operational KPIs / Geography UI cleanups
- Daily Call Logs name-match fix + historical backfill (**local DB only** — the backfill script was run against the local database directly; production's `daily_call_logs` table has NOT been backfilled)
- Data Quality page redesign
- The entire Key Insights notification bell (new table + 3 endpoints + frontend)
- Revenue Decliner alert fix
- Customer Analytics `.xlsx` export

Standard deploy pipeline (tar-over-ssh, `handoversession.md` §1) needed for all of it. **One new migration this session** (`75a81879eeb5_add_user_notification_state.py`) — remember `alembic upgrade head` on the server, and it's additive-only (safe, no data risk).

**Also unresolved from this session**: if you deploy the Daily Call Logs fix, run the same historical backfill script (§6) against production too, or its call-log data stays stuck on the old ~17-day rolling window.

---

## 2. Two-tier RBAC: `super_admin` vs `admin` — the big structural change

**The ask:** super_admin can do anything; admin loses access to Data & Integration and Administration (CRM Sync, Matching Review, Data Quality, AE Assignment/Targets, Customer Management, Users, Audit Logs) but keeps everything else (Profitability, Customer 360 AE-assignment, directory, etc.).

**Backend (`auth.py`, `main.py`):**
- `require_role()` now has a **hard-coded bypass**: `if user.role == 'super_admin': return user` before checking the allowed-roles list at all. This guarantees the invariant even for future routes that forget to list `super_admin` explicitly.
- 58 of the 59 solo `require_role('admin')` call sites were changed to `require_role('super_admin')` — every Data & Integration / Administration backend route. The **one exception**: `POST /companies/{id}/assign-ae` stays `require_role('admin')` (it's a Customer 360 page action, not an Administration page, so plain admin keeps it; super_admin passes via the bypass regardless).
- `crm-sync/pnl` and `crm-sync/ups-pnl` (CRM sync triggers) moved from `['admin','sales_lead']` to `'super_admin'` — they're Data & Integration actions, distinct from the Profitability *read* endpoints which stayed `['admin','sales_lead']` (bypass covers super_admin automatically, no list changes needed there).
- `UserCreate`/`UserPatch` role `Literal` types extended to include `'super_admin'`.
- `email_notifications.py`: the tier-alert admin digest recipient query now matches `role IN ('admin','super_admin')` instead of just `'admin'`.

**Frontend:**
- `AuthRole` type gained `'super_admin'`.
- `useAuth()` now exposes both `isAdmin` (true for admin OR super_admin — used for things like Customer 360's AE-assignment dropdown, which stays available to plain admin) and `isSuperAdmin` (true only for super_admin — used to gate the Data & Integration/Administration sidebar groups and the `RequireAdmin` route wrapper).
- `hasRole()` in `auth.tsx` also bypasses for `super_admin`, mirroring the backend, so nav items with an explicit `roles` list (e.g. Profitability's `['admin','sales_lead']`) don't wrongly hide from a super_admin.
- Users admin page: role dropdown, badge colors/labels, and bulk-import parser all updated for the new role.

**Data migrations (real accounts, both environments):**
- Local: `admin@gmail.com` promoted to `super_admin` directly in the local DB.
- Remote: same for `admin@gmail.com` and `adityap@gohimalaya.travel` (see §1) — this required explicit user permission since it's a production DB write; the sandbox's auto-classifier blocks unattended remote DB mutations regardless of prior chat confirmation, so expect to re-approve any future one of these.

**Test fixture note:** the shared `client` pytest fixture (`conftest.py`) now logs in as `super_admin`, not `admin` — it was already implicitly "whatever the top admin-tier role is" for dozens of existing tests exercising CRM sync/matching/data-quality flows; renamed/promoted to keep those passing under the new split rather than rewriting every test's expected role.

**Verified:** live 403 checks (a plain-`admin` test account correctly blocked from `/admin/users`, `/crm-sync/status`, `/data-quality/summary`; correctly allowed into Profitability and Customer Directory). All 175 backend tests passing at the time (grew across the session, see §9).

---

## 3. Leaderboard — real Wins bug + shared DateRangeControl

**Bug found:** the "Wins" metric read `pipeline_items.win_loss`, which is **always blank** in this dataset — `pipeline_items` only ever holds the CRM's still-*open* pipeline; a deal leaves that table once it closes. The CRM actually records a closed-won call under `daily_call_logs.stage = 'Win'` (thousands of real rows). Fixed by rewriting the wins query to read from `daily_call_logs` instead.

**Also added, per explicit request:** the Leaderboard now reuses the exact same `DateRangeControl` component every other analytics page uses (all presets, custom range), instead of a bespoke month-only dropdown — **admin/super_admin only**; the backend silently ignores `timeframe`/`date_from`/`date_to` for every other role and stays pinned to the current month. Backend endpoint gained `period`/`timeframe` handling via the shared `get_timeframe_bounds()` helper.

Added tests for: wins reading the right table, `period` param role-gating, malformed-period 422 for the admin tier. Verified live — switching to "Last Month" correctly reloads different real standings.

---

## 4. Small UI cleanups (each was a separate explicit request)

- **Universal Search**: removed the "Quick Access Shortcuts" grid on the default (no-query) view — pure decoration duplicating the sidebar.
- **Profitability page**: removed the redundant "Key Insights" text-summary card (duplicated the KPI tiles above it); MAWB "Margin Leaders" section gained a third card — **highest dollar profit**, not just highest margin % — since a huge low-margin manifest can out-earn a small high-margin one in raw dollars (confirmed live: they're genuinely different MAWBs). Also fixed the "Worst" customer-profitability sort tab showing `$0.00`/no-margin noise for customers with nothing costed yet — added a `HAVING` clause excluding zero-costed customers from that specific sort mode only.
- **Customer Directory**: removed the "More Filters" expandable panel (Country/AE Code/Min-Max Revenue/Shipments/Weight) — 8 fields nobody asked to keep, per explicit request.
- **Operational KPIs**: "Top MAWBs" simplified to MAWB/Shipments/Weight/Revenue only (dropped Flight/Route); removed the fully-redundant "MAWB Utilization" table (same underlying data as Top MAWBs, just re-sorted, no real distinct metric); removed a redundant Avg Weight/Pieces/Revenue row that duplicated the main KPI strip; "Top Shipments" simplified to Date/AWB/Weight/Revenue (added `shipment_date` to the backend payload, which wasn't there before); "Top Operational Customers" table had a real overflow bug — percentage-based `table-fixed` columns were too narrow for real large numbers (`$1,070,769.71` got ellipsis-truncated) — fixed with fixed-pixel column widths sized for the actual data range plus `whitespace-nowrap`.
- **Geography page**: KPI cards were hard-clipping long values (`$11,155,808.31` → `$11,155,8`) because the "long text" style switch used `text-wrap` (a no-op on an unbroken numeric string) — fixed with `break-words` + `min-w-0` in the shared `KpiCard` component. Also fixed the "Top Countries by Weight" bar chart's data label getting clipped — `containLabel` doesn't reserve space for a `label` positioned outside the plot area, so widened the chart's right grid margin to a fixed 90px.

All verified live in the browser with real data (the "All Time" range was specifically used to reproduce the large-number clipping bugs).

---

## 5. Data Quality page — redesigned, plus a real default-scope bug found

**The redesign** (per explicit "too cluttered" request): merged two stacked, equal-weight bordered filter/action bands into one flat unboxed toolbar; shortened tab labels ("Sync & Import Issues" → "Issues", "Resolution Log" → "History"); aligned the History tab's filter row to the same unboxed style.

**The real bug underneath the clutter complaint:** the Issues tab's own code comment claimed it "defaults to the ICRIS buffer types... everything else tucked behind Show other issue types" — but the code never actually implemented that; `issue_type` defaulted to `''` (everything), so the default view dumped **all 83,814** open issues of every type, burying the one real signal (stuck ICRIS >30 days) under low-priority name-drift noise. Fixed: backend `issue_type` param now accepts a comma-separated list (`crm_invalid_icris,crm_blank_icris`), and the frontend defaults to exactly that pair. Default view dropped from 83,814 → 11,547 relevant rows.

---

## 6. Daily Call Logs — name-match bug + historical backfill (local DB only)

Two separate fixes, from two separate user questions ("what is provisional" led nowhere further, but a follow-up on Call Logs did):

1. **Match bug**: `GET /companies/{id}/call-logs` matched on `Company.crm_customer_id` — a column that's **never populated** anywhere in the app (0 of 1,042 companies). The call-log scrape and the manifest/customer sync are separate CRM exports with no shared numeric ID. Fixed to match on normalized company name (+ `CompanyAlias`), the same exact-match machinery already used elsewhere for company matching.
2. **Historical gap**: the scheduled sync only ever pulls a **rolling 7-day lookback** — no backfill mechanism existed for call logs (unlike manifests/PnL, which have `crm_backfills.py`). Local DB only had 237 rows (last ~17 days) while the live CRM holds **17,372** rows back to **2021-04-15**. Ran a one-off backfill script against the live CRM (read-only GET/POST, dedup via existing content-hash logic in `sync_daily_call_logs()`) — inserted 17,135 new rows. **This was a local-database data operation, not a code change** — if the same gap exists on production, someone needs to re-run the equivalent backfill there (the sync/dedup code itself needs no changes, just re-running it with a wide date range against prod).
3. Also removed the standalone global "Call Logs" sidebar page (`/app/call-logs`) per explicit request — call logs are now only reachable via a company's own Customer 360 tab, which is where they actually make sense.

---

## 7. Key Insights — new notification bell, built from scratch

**Planned collaboratively first** (per explicit request) before building: reuses the existing `/analytics/alerts` data (already role/AE-scoped) rather than a second insights engine, filtered to `severity=high`, with per-user server-side read tracking.

**Backend:**
- `compute_alerts()` extracted from the `/analytics/alerts` route so both it and the new feed share one source of truth.
- Alert `id` changed from a **random UUID per request** to a **deterministic sha256 hash** of `(category, type, entity_type, entity_id, entity_name)` — required for "seen/unseen" to mean anything across requests.
- Alert `occurred_at` added — a real originating date per alert type (last shipment date for dormancy, breach date for tier gaps, expected date for pipeline items, `first_seen_at` for date-pushed issues, etc.), used to sort the feed by actual recency instead of arbitrary insertion order.
- New table `user_notification_state` (migration `75a81879eeb5`, **not yet deployed** — see §1) — one row per user, JSONB `seen_alert_ids`.
- Three new endpoints: `GET /notifications/key-insights` (severity=high, sorted by `occurred_at` desc, optional `category` filter, per-item `seen` flag, `unread_count`), `POST /notifications/mark-seen` (unions ids into the seen set), `POST /notifications/mark-all-seen` (marks every current high-severity insight in the caller's scope, not just whatever page the client fetched).

**Frontend:** bell icon in the top header with a badge (capped "99+"), dropdown grouped by time bucket (Today/This Week/This Month/Earlier), category filter chips, "Mark all read." **Went through a deliberate visual correction mid-session**: the first pass used gradient badges, a sparkle-icon-in-gradient-tile header, an `animate-ping` pulse, and 4 arbitrary category accent colors — flagged as "looks AI sloppy" and rebuilt to match the app's *own* existing chrome (the plain `bg-zinc-900 border-zinc-800 rounded-md shadow-md` idiom the adjacent user-menu dropdown already uses, underline tabs matching the app's own tab convention, monochrome category icons, color reserved for unread state via the existing `border-l-2` accent idiom from Alerts/Profitability). Worth remembering for any future "make it look nice" UI ask on this codebase: **default to the app's existing materials before reaching for gradients/glows** — that's what reads as generic AI output here.

**Real bug found via this feature, not before it existed:** once the bell surfaced live data, a wall of "Revenue Drop" alerts appeared for nearly every customer — see §8.

---

## 8. Revenue Decliner/Gainer alert — real false-positive bug

**Root cause:** compared **month-to-date revenue against the entire previous month's total** (`SUM(... WHERE shipment_date >= this month start)` vs `SUM(... WHERE shipment_date >= last month start AND < this month start)`). Early in any month, 4 days of data trivially looks like a >50% "decline" against a full 30-day prior total for almost every customer — an accounting-period mismatch, not a real signal.

**Fix:** now compares the same number of elapsed days against the matching window in the previous month (day 1–4 of this month vs day 1–4 of last month), and is skipped entirely for the first 3 days of a month (sample too small either direction). Added a regression test with a "steady" company (same revenue both matched windows → must not fire) and a genuinely "dropped" company (real decline in the matched window → must fire) — also had to discover and work around the alerts endpoint's per-`(category, ae_code)` cap of 300, which was silently swallowing the test's synthetic alert behind the shared dev DB's ~700 real unassigned dormant-customer alerts (fixed by giving the test companies a unique `ae_code`, not a code change).

Verified live: the false "Revenue Drop" wall is gone from the bell; only genuine time-sensitive items remain.

---

## 9. Customer Analytics — verified, custom range confirmed correct, export upgraded

Per explicit request to "inspect" this page:
- All 9 pre-existing `test_executive_analytics.py` tests pass (this page's data comes from `getExecutiveDashboard`).
- **Custom range confirmed already correct** — unlike the historical Rankings/Profitability bug, this page was wired correctly from the start (`timeframe: 'custom'` key is present in the request). Added a 10th regression test locking this in, since the failure mode (silently dropping the custom range) has bitten this app before.
- **Export was a mislabeled CSV** (button said "Export," file was `.csv` with quoted-string cells, no real Excel semantics). Rebuilt as a genuine multi-sheet `.xlsx` (All Customers / Biggest Gainers / Biggest Decliners / By Segment), real numeric cells with `$#,##0.00`/percent Excel number formats (not pre-baked strings), auto-sized columns, autofilter — using the same `xlsx`/SheetJS library already used on Rankings, so it's consistent rather than a one-off. Verified via the exported blob's ZIP/OOXML signature (`PK\x03\x04`) and reasonable file size, since the sandboxed browser can't retrieve downloaded files directly for inspection.

---

## 10. Test suite growth this session

148 (start of prior session) → 173 (start of this session, per handover3) → **182 passing** by the end of this session. New test files/additions: `test_key_insights.py` (7 tests — stable ids, severity filter, category filter, occurred_at sort order, mark-seen, mark-all-seen, the Revenue Decliner regression), `test_leaderboard.py` additions (wins-from-call-logs, period param + role gating), `test_executive_analytics.py` (+1, custom-range regression).

---

## 11. Known issues / things to watch

- **Production DB**: the `super_admin` promotion for both admin accounts was applied directly on `shangrila002` — confirm it's still in place if anyone re-syncs or restores that database from an older snapshot.
- **Daily Call Logs backfill is local-only** (§6) — production's call-log table is still on the old ~17-day rolling window unless someone re-runs the equivalent backfill there.
- **New migration `75a81879eeb5`** is additive-only (new table, no risk to existing data) but still needs `alembic upgrade head` on the server before the Key Insights feature will work there.
- **Alerts endpoint's per-`(category, ae_code)` cap of 300** is a real, pre-existing characteristic (not something touched this session) that can silently hide alerts for very large unassigned-AE buckets — worth knowing if a future "why isn't X showing in the bell/Alerts page" investigation comes up.
- Nothing else outstanding from prior sessions was revisited — see `handoversession.md`/`handover2.md`/`handover3.md` for older unresolved items (e.g. `.env.example`'s committed CRM credentials, `master_air_waybills.destination` still dirty at the source).

---

## 12. Where to pick up

1. **Deploy everything in §3–§9** — only the RBAC split (§2) is live.
2. Run `alembic upgrade head` on the server for the new `user_notification_state` table.
3. If Daily Call Logs history matters on production, re-run the backfill there (§6) — same script, just point it at prod and use a wide date range.
4. Consider whether the Alerts endpoint's 300-per-group cap needs raising or restructuring now that the Key Insights bell also depends on `compute_alerts()` — a very large unassigned bucket could theoretically crowd out a real high-priority item in either surface.
