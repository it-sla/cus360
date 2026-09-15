# Role-Based Access Control — Plan & Status

**Status:** implemented and verified live (backend enforcement + row-level scoping + frontend nav/route gating). See §8 for exactly what shipped vs. what's still open.
**Owns:** the rules for who sees what. See [docs/10-known-issues.md](docs/10-known-issues.md) B-1 for the prior state this replaces: before this work, the API was effectively unauthenticated except for 5 Profitability routes.

## 1. Roles

Three roles, replacing today's binary `admin` / `user`:

| Role | Who | Scope |
|---|---|---|
| `admin` | Ops/management, existing `admin` role | Everything, no restriction |
| `sales_lead` | Sales management | Everything **except** Administration and Data & Integration nav groups |
| `ae` | Individual account executives | **Only their own assigned customers/shipments/revenue, everywhere in the app.** Cannot see Profitability at all, in any form. Other AEs' rows/revenue never appear — not masked, not present. |

`user` (today's default/fallback role) stays as the "nobody's assigned a real role yet" state — same as an unconfigured account, no special behavior of its own.

## 2. Page-level access matrix

Based on the live sidebar nav ([app-shell.tsx:28-70](frontend/src/components/app-shell.tsx#L28)):

| Group | Page | admin | sales_lead | ae |
|---|---|---|---|---|
| Executive | Executive Overview | ✅ | ✅ | ✅ (own data only) |
| Executive | Business Analytics (+ Revenue/Customer/AE Perf/Geography/Operational subpages) | ✅ | ✅ | ✅ (own data only) |
| Executive | Universal Search | ✅ | ✅ | ✅ (own data only) |
| Customers | Customer Directory | ✅ | ✅ | ✅ (own customers only) |
| Operations | Air Waybills | ✅ | ✅ | ✅ (own shipments only) |
| Operations | Master Air Waybills | ✅ | ✅ | ✅ (own shipments only) |
| Intelligence | **Profitability** | ✅ | ✅ | ❌ never |
| Intelligence | Rankings | ✅ | ✅ | ✅ (own data only) |
| Intelligence | Alerts | ✅ | ✅ | ✅ (own customers only) |
| Intelligence | Active Pipeline | ✅ | ✅ | ✅ (own rows only) |
| Intelligence | Call Logs | ✅ | ✅ | ✅ (own AE code only — the AE-scoping decision on this page was made explicitly when it was built, so it's the natural first page to wire up) |
| Data & Integration | CRM Sync, Matching Review, Data Quality | ✅ | ❌ | ❌ |
| Administration | Customer Management, AE Territory Assignment, AE Revenue Targets, Users, Audit Logs | ✅ | ❌ | ❌ |

Key change from today: **Profitability's `adminOnly: true` flag needs to become a role list** (`['admin', 'sales_lead']`), not a boolean — sales_lead needs it, ae never does. Same for the backend routes currently gated with `require_role('admin')` ([main.py:2162](backend/app/main.py) area, 5 routes) — those need to become `require_role(['admin', 'sales_lead'])`.

## 3. What "own data only" means for an AE

Every shared/aggregate page an AE can reach must filter to rows where `ae_code` matches the AE's own code — not hide columns, not blank values, actually exclude the rows. Concretely:

- **Customer Directory / Customer 360**: only customers where `assigned_ae_code == user.ae_code`.
- **Air Waybills / Master Air Waybills**: only shipments/MAWBs belonging to their customers.
- **Business Analytics / Customer Analytics / Rankings / Alerts / Pipeline / Call Logs**: same filter applied server-side to the underlying query, not client-side after fetching everyone's data (client-side filtering would still leak the full dataset over the wire).
- **AE Performance page** specifically: today it shows every AE's leaderboard row. For an `ae` user this needs to become single-row (their own) or be hidden entirely — TBD, see open question in §6.
- **Executive Overview / dashboard totals**: KPI totals (revenue, shipment counts) must also be scoped to the AE's own book, not company-wide totals — otherwise "Total Revenue" on their dashboard would leak the whole company's number even if the row-level tables are filtered.

## 4. Backend implementation shape

1. **`auth.py`**
   - `require_role(role: str)` → `require_role(roles: str | list[str])`, checks membership instead of exact match. (Small, backward-compatible change — existing single-string callers keep working.)
   - `AuthUserOut` gains `ae_code: str | None`.
   - New dependency `get_ae_scope(user: User = Depends(get_current_user)) -> str | None`: returns `None` for `admin`/`sales_lead` (no restriction), returns `user.ae_code` for `ae` (raises 403 if an `ae`-role user has no `ae_code` set — an unconfigured AE account shouldn't silently see nothing *or* everything).

2. **Every list/analytics endpoint that can return cross-customer data** takes the `ae_scope` dependency and adds a `WHERE ae_code = :scope` (or equivalent join filter) when scope is not `None`. This is the bulk of the work — needs an endpoint-by-endpoint pass through `main.py`'s ~100 routes to identify which ones need it. Rough list from what this session touched or knows about:
   - `/companies` and `/companies/{id}` family
   - `/shipments`, `/mawbs`
   - `/analytics/executive-dashboard`, `/analytics/geography`, `/analytics/operations`
   - `/pipeline`
   - `/call-logs`, `/companies/{id}/call-logs` (already has an `ae_code` column ready for this — see [main.py:2394](backend/app/main.py#L2394) area)
   - `/alerts`
   - Profitability routes: **no scoping needed, since `ae` role is blocked entirely by `require_role`.**

3. **Route-level admin/sales_lead gating**: extend `require_role(['admin','sales_lead'])` to the Data & Integration and Administration routes that currently have no backend enforcement at all (today only Profitability is enforced — everything else is frontend-only `RequireAdmin`, a known gap, see [docs/10-known-issues.md](docs/10-known-issues.md) B-1). This plan is the natural point to close that gap for the two new groups, not just Profitability.

## 5. Frontend implementation shape

1. `useAuth()` / `/auth/me` response carries `ae_code` and `role` (role already there).
2. `app-shell.tsx` `NAV_ITEMS`: replace `adminOnly?: boolean` with `roles?: string[]` (omitted = everyone). Filter nav rendering by `roles.includes(currentUser.role)` instead of the current `adminOnly && !isAdmin` check.
3. Route guards: today only `RequireAdmin` exists (wraps `/app/profitability`). Needs a general `RequireRole(roles: string[])` wrapper, used for:
   - Profitability → `['admin', 'sales_lead']`
   - Data & Integration pages → `['admin']`
   - Administration pages → `['admin']`
4. Pages that need to render differently for `ae` (not just filtered data, but different UI) — e.g. AE Performance's leaderboard becomes a single-row "your performance" view instead of a table. Needs per-page review, not a blanket wrapper.
5. Call Logs standalone page (`pages/CallLogs.tsx`) already has the AE-picker-vs-locked-to-self design sketched from an earlier session decision — this is the first page that should get real scoping, since it's small and self-contained.

## 6. Open questions before implementation starts

- **AE Performance page**: single-row view for `ae`, or hide the whole page? (Leaderboard concept doesn't really work when you can only see one row.)
- **Executive Overview**: does an `ae` user get a version of this page at all, or does `ae` skip straight to Customer Directory as their landing page? Right now `/app` is Executive Overview for everyone.
- **Unassigned customers** (`assigned_ae_code IS NULL`): invisible to every `ae`, visible to `admin`/`sales_lead` — confirm this is right, since it affects the "N customers, M shipments have no AE assigned" banners already on some pages.
- **Alerts**: does an `ae` only see alerts for their own customers, or also see revenue-at-risk alerts that reference other AEs' accounts if those accounts feed into shared totals? (Affects whether Alerts needs the same filter as everything else or a bespoke rule.)
- Should `sales_lead` be able to *change* an AE's territory assignment (that's Administration → blocked) or only *view* it read-only somewhere in Intelligence? Today AE Territory Assignment only exists in Administration.

## 7. Suggested rollout order

Smallest-blast-radius first, so each step is independently testable:

1. `auth.py` changes (multi-role `require_role`, `ae_code` on `/auth/me`, `get_ae_scope` dependency) — no behavior change yet, just plumbing.
2. Wire `sales_lead` into the existing Profitability gate (both backend routes and frontend `RequireAdmin` → `RequireRole`) — proves the multi-role mechanism works end to end on a route that's already gated.
3. Gate Data & Integration + Administration nav/routes to `admin`-only (closes the pre-existing frontend-only gap for these two groups).
4. Scope Call Logs to `ae` (smallest, most self-contained dataset, already has `ae_code` on every row).
5. Scope Customer Directory / Customer 360 (the "everything else derives from who's assigned to whom" page).
6. Scope the remaining analytics pages (Business Analytics, Rankings, Alerts, Pipeline, AWB/MAWB) one at a time.
7. Decide and implement the AE Performance / Executive Overview open questions from §6.

Each step should ship with: backend enforcement + a probe test proving a non-privileged role gets 403/filtered data, not just a frontend hide.

## 8. Implementation status (as of this pass)

**Shipped:**
- `auth.py`: `require_role` accepts a list; `get_ae_scope` dependency (None for admin/sales_lead, `user.ae_code` for ae, 403 if an ae has no code set); `/auth/me` and login now return `ae_code`. Fixed a latent bug found along the way: `main.py` had its own duplicate `AuthUserOut` used as the actual `response_model` on login/me — the `auth.py` one adding `ae_code` was silently being ignored until this local copy was updated too.
- Profitability (6 routes + frontend route/nav) now `['admin','sales_lead']`, was `admin`-only.
- **36 previously-unguarded routes gated `admin`-only**: all of Matching Review, CRM Sync, Data Quality, plus AE Targets / AE Territory Assignment / Company Imports (Administration) — these had zero backend enforcement before, frontend `RequireAdmin` was the only gate.
- `ae_code` row-level scoping (real SQL/query filtering, not post-hoc hiding) applied to: Companies list + detail + shipments/documents/analytics sub-resources, Shipments list, MAWBs list, Executive Dashboard (backs Executive Overview/Business Analytics/Customer Analytics), AE Performance, Geography, Operations, Top Customers (Rankings), Active Pipeline, Alerts, Call Logs (both endpoints).
- Users admin page: role dropdown now offers all 4 roles; an AE Code field appears when role=`ae` (required, this is what the scoping above keys off); self-demotion and last-admin guards extended to cover the new roles, not just the old `admin`/`user` binary.
- Test suite: `conftest.py`'s shared `client` fixture now logs in as a seeded admin (was fully unauthenticated) so the 89→132 existing tests keep exercising the flows they were written for instead of hitting fresh 401s. All 132 pass.
- Verified live end-to-end with real admin/sales_lead/ae test accounts (created and torn down): Profitability 200/200/403, Data & Integration 200/403/403, ae-with-no-code 403 with a clear message, Companies/Call Logs/Alerts all confirmed zero cross-AE rows leaking.

**Also fixed along the way (found while implementing, not in the original plan):**
- `POST /companies/{id}/assign-ae` had **no role check at all** — any logged-in user, including the plain `user` role, could reassign any customer's AE. Now `admin`-only (not `sales_lead` — explicit call, since this is a write action on customer ownership, not a view). Verified live: `user` role 403, `admin` 200.
- The matching Customer 360 "Assigned AE" control (Settings tab) now only renders as an editable dropdown for admins; everyone else sees the current AE as plain read-only text.
- Removed the "Add Customer" button/modal from Customer Directory entirely (was open to any authenticated role, no gate at all, and duplicated Customer Management's own create flow).

**Deliberately not done (§6 open questions, still open):**
- AE Performance's "leaderboard" now naturally renders as a single row for an `ae` caller (scoping does this for free) but the page copy/layout wasn't adapted for that case — still says "Leaderboard."
- `sales_lead` read-only access to AE Territory Assignment — not built; that page stays Administration-only per §2.
- Air Waybills page pagination/company display, Universal Search, Rankings' other tabs (Top Destinations, Customers by Country) were not individually re-checked for ae_code scoping — Rankings' Top Customers tab is scoped since it shares the same endpoint, but the other tabs may use separate queries not yet audited.
- No migration/UI exists yet for an admin to bulk-assign `ae_code` to existing `ae`-role accounts beyond the Users page's own edit modal — fine for a handful of users, would want a bulk tool at real scale.
