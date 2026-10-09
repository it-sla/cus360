# Paste-ready prompt — build a new dashboard in the Customer 360 style

Copy everything below the line into the first message of the new session. Fill in the
`<<...>>` placeholders first (domain, KPIs, data source). Everything else describes the
look, components, and flow to reproduce exactly.

---

I'm building a new internal analytics dashboard. Reproduce the frontend architecture, look,
and UX flow of my previous project (described in full below) — same stack, same component
shapes, same conventions. Don't invent a different design system or add libraries beyond
this list. Domain for this one: **<<describe the business / data here>>**.
Backend API: **<<base URL / framework / "mock it with static JSON for now">>**.

## Stack (exact)

- React 19 + TypeScript + Vite
- Tailwind CSS 4 (CSS-first `@theme` config, no `tailwind.config.js`)
- `@tanstack/react-query` v5 for ALL data fetching; `@tanstack/react-table` for big tables
- `axios` client in a single `src/api.ts` — every type and fetch function lives there; no page calls axios directly
- `react-router-dom` v7 (nested routes, `<Outlet />`)
- `echarts` + `echarts-for-react` for every chart (no other chart lib)
- `@radix-ui/react-*` primitives (dropdown-menu, collapsible, tooltip, dialog, popover, tabs, select, scroll-area, separator) with local shadcn-style wrappers in `src/components/ui/`
- `lucide-react` icons, `motion` (`motion/react`) for animation, `xlsx` for Excel export
- `clsx` + `tailwind-merge` → `cn()` helper in `src/lib/utils.ts`

## Theme & typography

`src/index.css`:

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

@theme {
  --color-border: #e4e4e7; --color-input: #e4e4e7; --color-ring: #3b82f6;
  --color-background: #ffffff; --color-foreground: #09090b;
  --color-primary: #3b82f6; --color-primary-foreground: #ffffff;
  --color-secondary: #f4f4f5; --color-secondary-foreground: #09090b;
  --color-muted: #f4f4f5; --color-muted-foreground: #71717a;
  --color-accent: #f4f4f5; --color-accent-foreground: #09090b;
  --color-card: #ffffff; --color-card-foreground: #09090b;
  --color-popover: #ffffff; --color-popover-foreground: #09090b;
  --color-destructive: #ef4444;
  --color-success: #059669; --color-warning: #d97706; --color-danger: #dc2626;
  --radius-lg: 0.5rem; --radius-md: 0.375rem; --radius-sm: 0.25rem;
  --font-sans: 'Inter', sans-serif;
}
.dark {
  --color-border: #27272a; --color-input: #27272a; --color-ring: #60a5fa;
  --color-background: #09090b; --color-foreground: #fafafa;
  --color-primary: #60a5fa; --color-primary-foreground: #09090b;
  --color-secondary: #27272a; --color-muted: #18181b; --color-muted-foreground: #a1a1aa;
  --color-accent: #27272a; --color-card: #18181b; --color-popover: #18181b;
  --color-success: #34d399; --color-warning: #fbbf24; --color-danger: #f87171;
}
body { background: var(--color-background); color: var(--color-foreground);
       font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
/* thin 6px scrollbars; zinc-700 thumb in dark */
```

- **Actually load Inter** (`@fontsource-variable/inter` or a Google Fonts `<link>`) — the old project declared it but never loaded it.
- Zinc neutral hierarchy, blue accent, emerald/amber/rose for good/warn/bad. Use semantic tokens (`bg-card`, `text-muted-foreground`), never raw `bg-white`/`text-slate-*`.
- Typography scale is small and dense: page title `text-xl sm:text-2xl font-black tracking-tight`; subtitle `text-xs sm:text-sm text-muted-foreground font-medium`; section/group labels `text-[10px] font-bold uppercase tracking-widest`; KPI values `text-2xl font-black tabular-nums`; table/body `text-xs`/`text-[12px]`.
- **Dark mode = `.dark` class on `<html>`**. Inline script in `index.html` `<head>` sets it before React mounts (read `localStorage.theme`, else `prefers-color-scheme`) to avoid a flash. `src/theme.tsx` exposes `ThemeProvider` + `useTheme()` → `{ theme, toggleTheme }`, persisting to localStorage. Sun/Moon toggle in the header.

## App shell & navigation

- Routes: public `/`, `/login`; everything else nested under `/app` inside `<RequireAuth><Layout/></RequireAuth>`, where `Layout` = `<AppShell><Outlet/></AppShell>`.
- `src/components/app-shell.tsx`:
  - **Left sidebar**, dark zinc-950, ~240px, collapsible to icon-only via one `sidebarOpen` boolean (toggle button with `PanelLeftClose/PanelLeftOpen` icon + Radix Tooltip in the header). Icon-only mode shows Tooltips with the label.
  - Nav driven by ONE array: `NAV_ITEMS: { label, path, icon, group, subItems?, roles? }[]`. Grouped by `group` into Radix `Collapsible` sections; group trigger is `text-[10px] font-bold uppercase tracking-widest` with a rotating `ChevronDown`, and a tiny emerald dot when a child route is active. Items filtered by `roles` against `useAuth().user.role`.
  - Active item: brighter text + subtle bg + accent left border; inactive icons at reduced opacity.
  - Sidebar footer: green dot + "All systems operational".
  - **Top header** (`h-14`, sticky, bottom border): collapse button · global search · spacer · notification bell · theme toggle · user dropdown (Radix DropdownMenu: name/role, Change password dialog, Log out).
  - **Global search**: input with `useDebounce(value, 300)` → `useQuery(['search', q])`, results dropdown grouped by entity type with an icon map, Enter/click navigates to the entity page.
- Main area: `flex-1 overflow-hidden`, each page scrolls itself.

## Page anatomy (every dashboard page follows this)

```tsx
export default function SomePage() {
  const [timeframe, setTimeframe] = useState('this_month');
  const [startDate, setStartDate] = useState(''); const [endDate, setEndDate] = useState('');
  const [compareMode, setCompareMode] = useState('pop');
  const [segment, setSegment] = useState('');
  const { data: d, isLoading, error } = useQuery({
    queryKey: ['some-page', timeframe, startDate, endDate, compareMode, segment],  // every filter in the key
    queryFn: () => api.getSomePage({ timeframe, date_from: timeframe==='custom'?startDate:undefined,
                                     date_to: timeframe==='custom'?endDate:undefined, compare_mode: compareMode, segment }),
    refetchInterval: 300_000,
  });
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="animate-spin text-primary" size={32}/></div>;
  if (error || !d) return <div className="p-8 text-danger">Failed to load. Backend might be unreachable.</div>;
  return (
    <motion.div initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} transition={{duration:0.3}}
      className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-w-[1600px] mx-auto w-full space-y-5">
      {/* 1. Header row: title + subtitle (+ "data as of <date>" emerald chip) left; filter bar + ExportButton right */}
      {/* 2. KPI grid: grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 of <KpiCard/> */}
      {/* 3. Chart cards: grid lg:grid-cols-2/3, each a Card with title row + <ReactECharts/> at fixed height */}
      {/* 4. Detail tables: top-N with "Show all" toggle that enables a second lazy query */}
    </motion.div>
  );
}
```

- Lazy secondary queries: `useQuery({ ..., enabled: showAll, staleTime: 300_000 })` for "show all" lists.
- Drill-down: clicking a KpiCard sets `selectedKpi` state → opens a Dialog/side panel with the breakdown list.
- No skeletons, no Suspense — spinner + error line is the convention.

## Filters (`src/components/AnalyticsFilterBar.tsx`) — shared by every page

- `TIMEFRAME_GROUPS` (rendered as grouped options in a popover):
  - Quick Ranges: Today, Yesterday, Last 7/30/90 Days
  - Calendar Period: This Week, This Month (MTD), Last Month, This Quarter (QTD), Last Quarter, This Year (YTD), Last Year
  - By Year: one entry per year back to the data's floor (`year_2026`, `year_2025`, …)
  - All History: All Time
  - plus `custom` (from/to date inputs)
- `TIMEFRAME_LABELS` map derived from the groups.
- `resolveTimeframeDates(tf, from?, to?)` → `{from, to}` client-side, **mirroring the backend's resolver exactly**; uses a local-date ISO helper (NOT `toISOString()`, which shifts days in UTC+ timezones). Unknown preset → last 30 days.
- `DateRangeControl`: button showing the preset label + the resolved date range underneath in tiny muted text; a clear-X appears when not on the default preset; popover is `position: fixed`, clamped to the viewport, repositions on resize/scroll, with a click-outside backdrop.
- `FilterSelect`: themed native `<select>` (h-9, rounded-lg, text-xs font-semibold, optional left icon, custom ▼), supports optgroups. Used for segment / owner / country / region / compare mode.
- `CompareModeSelect`: `pop` = "vs Previous Period", `yoy` = "vs Same Period Last Year". Backend returns `pop_pct` on every KPI accordingly.
- Canonical enum lists (e.g. `SEGMENTS`) are exported constants that must match the backend.
- Filter bar layout: `flex flex-wrap items-center gap-2`, right-aligned in the header row.

## KPI card (`src/components/KpiCard.tsx`)

Props: `title, value, icon, trend?, trendLabel?, subValue?, sparkline?, target?: {actual,target,label?,format?} | [...], className?, onClick?`.

- Card: `p-4 rounded-lg border bg-card shadow-md flex flex-col justify-between relative overflow-hidden group`, top accent `border-t-2 border-t-<color>-500` passed per card via className (emerald=revenue, blue=counts/customers, indigo, purple=averages, cyan/amber=weight, rose, sky=new, amber=dormant/warning).
- Header: uppercase 10–11px bold muted title + 14px icon right; both brighten on hover.
- Value: `text-2xl font-black tabular-nums`; if the value is free text (regex `!/^[\$€£¥₹\d,.\-+%\s]+$/`), drop to `text-base font-bold` and allow wrapping.
- Target attainment: pill badge `pct%` — ≥100 emerald, ≥70 amber, else rose (`text-x-400 bg-x-400/10`), with "<label> <target>" left of it. Pills, not progress bars.
- Footer (border-top): trend pill with `ArrowUpRight`/`ArrowDownRight`, emerald if ≥0 else rose, plus muted trendLabel.
- Optional sparkline absolutely positioned at the bottom, `h-12 opacity-50 pointer-events-none`.
- Clickable cards: `cursor-pointer hover:-translate-y-0.5 hover:shadow-xl`.

KPI set for this dashboard: **<<list them, e.g. Total Revenue, Active Customers, New, Reactivated, Avg Revenue/Customer, Total Orders, Growth Rate, Top Driver (text value)>>**. Previous project used: Gross Revenue, Active / New / Reactivated / Dormant Customers, Total Shipments, Total Weight, Countries Served, Avg Rev per Customer, Avg Rev per Shipment, Growth Rate, Top Revenue Driver, Target vs Actual.

Formatting helpers: `fmt$` (currency, compact for large), `fmtNum` (`toLocaleString`), weights with unit suffix. Never sum values across different currencies/units.

## Charts (ECharts)

- One plain `option` object per chart built inline from query data; `<ReactECharts option={opt} style={{height:'100%'}} />` inside a fixed-height flex container.
- Defaults on every chart: `tooltip: { trigger: 'axis', confine: true }` (light: white bg, `#e2e8f0` border, `#0f172a` text — swap for dark), `grid: { left:'3%', right:'4%', bottom:'10%', top:'8%', containLabel:true }`.
- Types used: bar (vertical + horizontal top-N), stacked bar, line/area trend (smooth, gradient area), donut (`radius ['55%','80%']`, `avoidLabelOverlap:false`, labels hidden, custom legend beside it), dual-axis bar+line for value vs count.
- Chart card: Card with a small bold title + muted subtitle row, optional ExportButton, then the chart.

## Alerts & notifications

1. **Notification bell** in the header (Radix DropdownMenu):
   - `useQuery(['key-insights', category], api.getKeyInsights, { refetchInterval: 60_000 })` → `{ items, unread_count, categories }`.
   - Red count badge on the bell when `unread_count > 0`.
   - Panel: category filter chips at top; items grouped into time buckets **Today / This Week / This Month / Earlier**; each row = category icon (icon map per category; color reserved for severity/unread, not decoration), title, cleaned 2-line description, relative age ("3d ago"), unread dot.
   - Opening the bell does NOT mark items read. Click-through marks that one seen (`markInsightsSeen([id])`) and navigates to the entity (company page / pipeline / list) — fallback to the full Alerts page. "Mark all read" button. Per-item dismiss/snooze (`snoozeInsight(id, days|null)`) with `stopPropagation`.
   - After every mutation: `queryClient.invalidateQueries({ queryKey: ['key-insights'] })`.
   - Footer link "View all alerts" → `/app/alerts` page (full table with filters by severity/category).
2. **Browser desktop notifications**: on first bell open, `Notification.requestPermission()` if `'default'`. A `useEffect` on the insights data fires `new Notification(title, { body })` for each unseen item not already in a `useRef<Set<string>>` of notified ids. Tab-open only (no service worker).
3. **`AlertBanner`** inline status pill: `type: 'critical'|'warning'|'info'|'success'`, icons `XCircle/AlertTriangle/Info/CheckCircle2`, styled `bg-<token>/10 text-<token> border-<token>/20 rounded-full px-3 py-1.5 text-xs font-semibold`, optional count. Used in page headers for things like "12 accounts at risk".
4. Inline error/success messages in forms instead of a toast library (no toasts in this stack).

## Export

- `src/lib/exportXlsx.ts`: `exportXlsx(fileName, sheets: { name, rows, formats? }[])` using `xlsx`; real Excel number formats (`currency '$#,##0.00'`, `percent '0.0%'`, `signedPercent`, `integer '#,##0'`, `decimal`) so files stay sortable/summable; sheet names sanitized to ≤31 chars, no `:\/?*[]`, deduped.
- `ExportButton({ onExport, disabled, label='Export Excel', variant })`: h-9 rounded-lg text-xs button with busy state. Every page/table gets one.

## Auth flow

- Cookie session, axios `withCredentials: true`. `AuthProvider` calls `/auth/me` on mount; `useAuth()` → `{ user, login, logout, loading }`.
- `RequireAuth` redirects to `/login`; `RequireAdmin` for admin routes (**also enforce on the backend** — the old project only hid UI).
- Login page, Sign-up-with-admin-approval, Forgot password, Change password dialog in the user menu.

## Animation rules

- Page root: `motion.div` fade + 10px rise, `duration: 0.3`. Conditionally mounted panels reuse the same values.
- Everything else is Tailwind `transition-colors`/`transition-all` + hover states (`hover:-translate-y-0.5`, icon `group-hover:scale-110`, chevron `rotate-180`). No springs, no stagger, no animation libraries beyond `motion`.

## Do NOT

- Build a custom SVG chart library, a chart theming layer, a toast system, or a separate mobile nav.
- Call axios outside `api.ts`, hardcode hex colors in components, or use `toISOString()` for calendar dates.
- Aggregate mixed currencies or units into one number.

Start by scaffolding: Vite app, `index.css` theme, `theme.tsx`, `auth.tsx`, `api.ts` (typed, with mock data if the backend isn't ready), `app-shell.tsx`, `AnalyticsFilterBar.tsx`, `KpiCard.tsx`, `AlertBanner.tsx`, `ExportButton.tsx` + `exportXlsx.ts`, then the Overview page. Run `npx tsc -b --noEmit` and open it in the browser to verify before moving on.
