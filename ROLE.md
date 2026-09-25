# Role-Based Access Control — Plan & Status

**Status:** implemented and verified live. Four roles: `super_admin` (full CRUD),
`admin` (read-only, everything), `sales_lead` (read-only, all AEs, no Profitability),
`ae` (own customers only, no Profitability, no pipeline history). See §8 for exactly
what shipped.

## 1. Roles

| Role | Who | Scope |
|---|---|---|
| `super_admin` | Ops/management with full power | Everything, all CRUD, Data & Integration, Administration |
| `admin` | Read-only oversight | Sees everything **except** Data & Integration / Administration; cannot write anything (enforced app-wide by `auth.access_guard` — any non-GET request 403s) except their own notification seen/snooze state |
| `sales_lead` | Sales management | Same page access as `admin` (minus Profitability) but **can** write: edit any company's contact info/notes/documents, same as an AE on their own book. Sees all AEs — no team/territory mapping exists, so "their AEs" means everyone's |
| `ae` | Individual account executives | **Only their own assigned customers/shipments/revenue, everywhere in the app.** Cannot see Profitability at all. Cannot see Pipeline "Past logs" (history/date-events) or pipeline history. Can see the full Leaderboard (all AEs, ranked) but locked to the current month. Can edit contact info/documents on their own assigned customers only |

`user` (default/fallback role) stays as the "nobody's assigned a real role yet" state.

## 2. Page-level access matrix

| Group | Page | super_admin | admin | sales_lead | ae |
|---|---|---|---|---|---|
| Executive | Executive Overview / Business Analytics / Universal Search | ✅ | ✅ | ✅ | ✅ (own data only) |
| Customers | Customer Directory | ✅ | ✅ | ✅ | ✅ (own customers only) |
| Operations | Air Waybills / Master Air Waybills | ✅ | ✅ | ✅ | ✅ (own shipments only, no P&L fields) |
| Intelligence | **Profitability** | ✅ | ✅ | ❌ | ❌ never |
| Intelligence | Rankings | ✅ | ✅ | ✅ | ✅ (own data; "Top Routes by Profit" tab hidden unless Profitability access) |
| Intelligence | Leaderboard | ✅ any period | ✅ any period | ✅ any period | ✅ **this month only**, all AEs ranked |
| Intelligence | Alerts | ✅ | ✅ (send-email buttons hidden) | ✅ (hidden) | ✅ own customers, hidden |
| Intelligence | Active Pipeline (live) | ✅ | ✅ | ✅ | ✅ own rows only, no AE picker |
| Intelligence | Active Pipeline "Past logs" (history / date-events) | ✅ | ✅ | ✅ | ❌ 403 |
| Intelligence | Call Logs (Customer 360 tab) | ✅ | ✅ | ✅ | ✅ own AE code only |
| Data & Integration | CRM Sync, Matching Review, Data Quality | ✅ | ❌ | ❌ | ❌ |
| Administration | Customer Management, AE Territory Assignment, AE Revenue Targets, Users, Audit Logs | ✅ | ❌ | ❌ | ❌ |

Everyday writes (upload/edit/archive a customer document, edit a company's contact
info/notes) are allowed for `super_admin` and `sales_lead` on any company, and for
`ae` only on their own assigned company (`require_company_write` in `main.py`).
Changing a company's `status` (archival) or creating/deleting a company stays
`super_admin`-only even for `sales_lead`/`ae`.

## 3. What "own data only" means for an AE

Every shared/aggregate page an AE can reach filters server-side to rows where
`ae_code`/`assigned_ae_code` matches the AE's own code (via `auth.get_ae_scope`) —
not hidden columns, not blanked values, rows actually excluded from the SQL. This
covers Companies, Shipments, MAWBs, documents, aliases, activity logs, the
Executive/Business Analytics dashboards, Rankings, Alerts, Pipeline and Call Logs.
`pnl_*` fields (Profitability) are stripped from every response (`main.py:strip_pnl`)
for any role that isn't `admin`/`super_admin`, not just hidden on the Profitability
page — this covers `/shipments`, `/mawbs`, and their detail routes too.

## 4. Backend implementation (`backend/app/`)

1. **`auth.py`**
   - `require_role(roles)` — `super_admin` bypasses any list.
   - `get_ae_scope(user)` — `None` for `admin`/`sales_lead`/`super_admin`, `user.ae_code`
     for `ae` (403 if unset).
   - `access_guard(request, db)` — registered app-wide via
     `FastAPI(dependencies=[Depends(access_guard)])`. Default-deny: every route needs a
     session unless in `PUBLIC_PATHS` (health, login, logout, set-password, docs). Also
     blocks any non-GET request from `admin`, except `/notifications/*` (own read
     state). This is what closed the ~45 previously-unguarded routes in one place,
     instead of an endpoint-by-endpoint pass.
2. **`main.py`**
   - `require_company_write(company_id, db, user)` — the shared write-scope check for
     documents/aliases/company PATCH: `super_admin`/`sales_lead` pass any company, `ae`
     only their own (404, not 403, if out of scope — same reasoning as `scoped_company`).
   - `scoped_company` / `scoped_shipment` / `scoped_document` / `scoped_mawbs` — the
     404-on-out-of-scope read helpers, reused across companies, shipments, documents,
     packages, activity logs and MAWBs.
   - `strip_pnl(data, user)` — recursively drops any `pnl_*` key from a response for a
     non-Profitability role. Applied to `/shipments`, `/shipments/{id}`, `/mawbs`,
     `/mawbs/{id}`, `/mawbs/by-number`.
   - Former `admin`-only routes (`assign-ae`, `bulk-assign-ae`, `bulk-set-category`,
     account-executives CRUD, company/shipment/package create-update-delete, aliases)
     are now `super_admin`-only.
   - Profitability routes (`customer-profitability`, `mawbs/pnl-*`) are `['admin']` —
     `sales_lead` no longer has Profitability (was `['admin','sales_lead']` before this
     pass).
   - `pipeline/history`, `pipeline/date-events`, `leaderboard/wins-detail` stay
     `['admin','sales_lead']`.
   - Leaderboard's `is_admin_tier` (controls whether a caller can pick a timeframe) now
     includes `sales_lead`, not just `admin`/`super_admin`; `ae` stays locked to
     `this_month` regardless of what it passes.
3. **Migration** `20260925_0002_promote_admin_to_super_admin.py` — one-time
   `UPDATE users SET role='super_admin' WHERE role='admin'` so nobody holding today's
   full-power `admin` role silently loses it; demote individual accounts to plain
   `admin` afterwards via the Users page.

## 5. Frontend implementation (`frontend/src/`)

- `auth.tsx` — `canWrite` (== `isSuperAdmin`), `canSeeProfit` (`admin`/`super_admin`),
  `canEditCompany(company)` (`super_admin`/`sales_lead` any company, `ae` only their own).
- `app-shell.tsx` — Profitability nav item is `roles: ['admin']` (was
  `['admin','sales_lead']`). Data & Integration / Administration groups stay
  `isSuperAdmin`-gated.
- `App.tsx` — `/app/profitability` route is `RequireRole roles={['admin']}`.
- `Customer360.tsx` — AE-assign dropdown is `isSuperAdmin`-only; Documents tab
  upload/edit/delete and Settings tab fields are gated by `canEditCompany(company)`;
  the `status` field is `isSuperAdmin`-only regardless.
- `Alerts.tsx` — the two "Send emails" buttons are `isSuperAdmin`-only.
- `Leaderboard.tsx` — timeframe picker and wins drill-down are
  `hasRole(['admin','sales_lead'])`.
- `Pipeline.tsx` — the AE picker is hidden unless `hasRole(['admin','sales_lead'])`
  (same condition as the existing "Past logs" gate).
- `Rankings.tsx` — "Top Routes by Profit" tab and its query are gated by
  `canSeeProfit`.
- MAWB detail's P&L card already only renders when `pnl_synced_at` is present, which
  `strip_pnl` now omits for non-Profitability roles — no extra frontend gate needed
  there.

## 6. Known simplifications (not built)

- **No sales_lead → AE team mapping.** A sales_lead sees every AE's data; there's no
  concept of "their team." Add a `reports_to`/team field on `AccountExecutive` if this
  is needed later.
- `admin`/`super_admin` naming: the frontend's `RequireAdmin` component actually means
  "super_admin only" (kept for now to minimize diff — do not confuse with the `admin`
  role).

## 7. Tests

`backend/tests/test_rbac.py` — parametrized role × endpoint matrix: anonymous 401,
admin write 403 (with notification-state exemption), Profitability role matrix,
`pnl_*` stripped from `/mawbs` for non-Profitability roles, pipeline history role
matrix, ae company scoping (200 on own, 404 on another AE's), ae write scope (can
edit own contact fields, 404 on another AE's company, 403 on status change),
sales_lead can edit any company, AE-roster/assign-ae are `super_admin`-only,
leaderboard timeframe lock for `ae` vs `sales_lead`. 22 tests, all passing alongside
the existing 231.
