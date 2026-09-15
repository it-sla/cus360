# Frontend

React 19 · TypeScript 6 · Vite 8 · TanStack Query 5 · Axios · Tailwind CSS 4.

Root: `frontend/src/`.

> **The production build currently fails.** `npm run build` exits 2 with 165 TypeScript errors and emits no bundle. The dist nginx serves is from 2026-07-28. See [10-known-issues.md](10-known-issues.md) B-3.

---

## Entry points

| File | Role |
|---|---|
| `main.tsx` | React root, providers |
| `App.tsx` | **All routes.** `RequireAuth` / `RequireAdmin` wrappers |
| `auth.tsx` | `AuthProvider`, `useAuth()`. Calls `/auth/me` on mount to restore session |
| `api.ts` | Axios client + **all** API types and fetch functions (45 methods) |
| `index.css`, `App.css` | Tailwind entry + globals |

**No page bypasses `api.ts`** [verified] — every call goes through the shared client. Keep it that way.

```ts
export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,       // session cookie rides along
});
```

`withCredentials: true` is essential — without it the `c360_session` cookie is not sent.

---

## Routing (`App.tsx`)

```
/                       LandingPage          public
/login                  Login                public
/app                    EfferdDashboard2     RequireAuth  ← shell with <Outlet/>
  ├─ (index)            ExecutiveOverview
  ├─ analytics          BusinessAnalytics
  ├─ geography          GeographyAnalytics
  ├─ operations         OperationalAnalytics
  ├─ customer-analytics CustomerAnalytics
  ├─ ae-performance     AEPerformance
  ├─ search             UniversalSearch
  ├─ customers          CustomerDirectory
  ├─ customers/:id      Customer360
  ├─ awb                AirWaybills
  ├─ mawb               MasterAirWaybills
  ├─ imports            ManifestImports      ← stub
  ├─ profitability      Profitability        ← stub
  ├─ rankings           Rankings             ← stub
  ├─ alerts             Alerts
  ├─ sync               CrmSync              RequireAdmin
  ├─ matching           MatchingReview       RequireAdmin
  ├─ quality            DataQuality          RequireAdmin
  ├─ users              admin/Users          RequireAdmin  ← stub
  ├─ roles              admin/Roles          RequireAdmin  ← stub
  ├─ audit-logs         admin/AuditLogs      RequireAdmin  ← stub
  └─ settings           admin/Settings       RequireAdmin  ← stub
*                       → redirect to /
```

`RequireAuth` and `RequireAdmin` (`App.tsx:36`, `:51`) render a loading state while `status === 'loading'`, redirect to `/login` when unauthenticated, and `RequireAdmin` bounces non-admins to `/app`.

> **These guards are cosmetic.** They hide UI; they do not protect data. Every backend route they front is reachable directly. See [06-api-reference.md](06-api-reference.md).

---

## Page inventory [verified — all 21 routes rendered and checked]

| Page | State | Notes |
|---|---|---|
| `ExecutiveOverview` | working | KPI cards, revenue tiers, drill-downs |
| `BusinessAnalytics` | working | Largest page. Filter chips, Pareto, concentration |
| `CustomerAnalytics` | working | Health, segmentation, growth, reactivation |
| `GeographyAnalytics` | working | MapLibre destination map |
| `OperationalAnalytics` | working | Operational KPIs |
| `AEPerformance` | working | Per account-executive, with detail panel |
| `UniversalSearch` | working | Cross-entity search |
| `CustomerDirectory` | working | Paginated list, filters |
| `Customer360` | working | Company dossier, tabs, PDF export |
| `AirWaybills` | **partly broken** | List works; **detail drawer throws** — `api.getShipment` is undefined |
| `MasterAirWaybills` | working | PP/FC/FD shown separately |
| `Alerts` | working | Intelligence alerts |
| `CrmSync` | **degraded** | Works, but the diagnose panel is permanently empty — `api.getDiagnoseData` is undefined (guarded, so no crash) |
| `MatchingReview` | working | |
| `DataQuality` | **buggy** | Duplicate React keys; selection collapses 29 conflicts into 12. See below |
| `ManifestImports` | **stub** | Renders chrome only, zero API calls |
| `Profitability` | **stub** | |
| `Rankings` | **stub** | |
| `admin/Users` | **stub** | No backend exists |
| `admin/Roles` | **stub** | No backend exists |
| `admin/AuditLogs` | **stub** | No backend exists |
| `admin/Settings` | **stub** | No backend exists |

Stub pages render ~385-396 characters of shell chrome, no `<h1>`, and make no API calls.

### Console health [verified]

Walking all 21 routes produced **exactly one** error class: React duplicate-key warnings on `/app/quality`, 17 occurrences.

Root cause: `/api/v1/quality-issues/company-conflicts` returns 29 rows with only 12 distinct `source_id` (one source company appears 18 times). `DataQuality.tsx:108` keys on `conflict.source_id` and `:40` builds selection state as `new Set(conflicts.map(c => c.source_id))`. Because the action behind it is `mergeCompanies` — a hard delete — this matters. Fix by keying on `` `${source_id}:${target_id}` ``.

---

## Components

| Path | Contents |
|---|---|
| `components/` | `KpiCard`, `Sidebar`, `TopHeader`, `AlertBanner`, `AEDetailPanel`, `ExecutiveLayout`, `app-shell`, `dashboard`, `shimmering-text` |
| `components/ui/` | Radix/Base UI primitives (shadcn-style) + `efferd-dashboard-2` (the app shell) |
| `components/charts/` | ~26 chart primitives: area, grid, legend hover, reveal clip, skeletons, formatters |
| `lib/` | `utils.ts` — `cn()` class merger |

**Two dead files with unresolvable imports** — they break `tsc` but are not reachable at runtime:
- `charts/chart-loading-label.tsx:5` imports `'../components/shimmering-text'`; from `charts/` that resolves to `src/components/components/`. Correct path is `'../shimmering-text'`.
- `ui/live-sales-dashboard.tsx:3` imports `@/demos/hooks/useRealtimeSalesData`, which does not exist.

---

## Data fetching pattern

TanStack Query throughout:

```tsx
const { data, isLoading } = useQuery({
  queryKey: ['executive-dashboard', filters.timeframe, filters.compareMode],
  queryFn: () => api.getExecutiveDashboard({ timeframe: filters.timeframe, ... }),
});
```

Conventions worth following:
- **Query keys include every filter** that affects the result, so changing a filter refetches.
- Heavy derivation happens in `useMemo` over the response, not in render.
- Mutations invalidate by key: `queryClient.invalidateQueries({ queryKey: ['company-conflicts'] })`.
- Most pages call **one** fat endpoint (`/analytics/executive-dashboard`) and derive many views client-side, rather than making many small calls.

---

## api.ts

45 exported methods. **All 46 call sites resolve to real backend routes** [verified] — there are no broken paths.

**Two methods pages call but that do not exist:**

| Called at | Method | Effect |
|---|---|---|
| `AirWaybills.tsx:494` | `api.getShipment` | **Unguarded** → `TypeError` when the AWB detail drawer mounts |
| `CrmSync.tsx:42` | `api.getDiagnoseData` | Guarded (`? … : Promise.resolve({})`) → panel silently empty |

Both backend routes exist (`GET /shipments/{id}`, `GET /crm-sync/diagnose`); only the client bindings are missing.

**Stale response types.** Several interfaces omit fields the backend actually returns — `all_customers`, `prev_trend`, `compare_mode`, and several `CompanyDetail` fields. This accounts for 22 of the build's `TS2339` errors. The runtime data is fine; the types lag.

---

## Styling

Tailwind CSS 4 via `@tailwindcss/postcss`. `tailwind.config.js` + `postcss.config.js`. Path alias `@/` → `src/` (declared in both `vite.config.ts` and `tsconfig`).

Dark mode is written with `dark:` variants throughout, but there is no theme toggle wired up.

---

## Build and tooling

```bash
npm run dev      # Vite dev server, proxies /api → localhost:8360
npm run build    # tsc -b && vite build     ← currently FAILS (exit 2)
npm run lint     # oxlint                   ← passes, warnings only
npm run preview  # serve built dist
```

**`npm run typecheck` does not exist**, despite being cited in `CLAUDE.md`, `AGENTS.md`, and `README.md`. Use `npx tsc -b --noEmit` instead.

`vite.config.ts:42-48` proxies `/api` to `process.env.BACKEND_URL || 'http://localhost:8360'` [verified] — older docs claiming "Vite proxies are not used" are wrong.

**There is no frontend test framework** — no unit, component, or e2e tests. This is why `api.getShipment` being undefined reached the codebase.

`index.html` still carries the scaffold title `<title>frontend_new</title>`.

---

## Testing the frontend locally

```bash
cd frontend && npm run dev -- --port 5199 --strictPort
```

Then open `http://localhost:5199`, log in with `admin@gmail.com` / `admin123`. The proxy handles the API, so no other setup is needed as long as the backend container is up.

To sweep every route for console errors, install a collector and drive React Router via the History API — the technique used for the audit is in `qa/QA-REPORT.md` §G.
