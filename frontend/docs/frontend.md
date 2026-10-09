# Frontend dashboard notes — reusable for the next project

Extracted from this repo's dashboard (`frontend/src/pages/*Analytics*.tsx`, `ExecutiveOverview.tsx`,
`TerritoryPerformance.tsx`). Charting lives entirely in page files via `echarts-for-react` — there's
also a large unused custom visx chart library under `components/charts/` (`Area`, `LineChart`,
`BarChart`, `PieChart`…), but no page imports it. Don't copy that part; it's dead weight here.

## Stack that actually gets used

- **React 19 + TypeScript + Vite**
- **TanStack Query** for all data fetching — `useQuery({ queryKey, queryFn, refetchInterval, staleTime })`.
  Keys include every filter (timeframe, date range, compare mode) so changing a filter is just a
  cache-key change, no manual refetch wiring.
- **`echarts-for-react`** (`ReactECharts`) for every chart. One `option` object per chart, built inline
  in the page component from the query data. No chart abstraction layer needed — ECharts' option
  object already *is* the abstraction.
- **Tailwind CSS 4** + `shadcn/ui`-style primitives (`Card`, `Button`) for layout/chrome.
- **`lucide-react`** for icons, **`motion/react`** for the odd transition.

## KPI card pattern

One reusable `KpiCard` component ([frontend/src/components/KpiCard.tsx](../src/components/KpiCard.tsx))
used on every dashboard page. Worth copying wholesale:

```tsx
<KpiCard
  title="Total Billing"
  value={formatCurrency(rev.value)}
  icon={DollarSign}
  trend={rev.pop_pct}          // +/- percent, renders green/red arrow badge
  trendLabel="vs last period"
  target={{ actual, target, label: 'CRM' }}   // optional target-attainment pill
  sparkline={<ReactECharts option={sparklineOption} />}  // optional, absolute-positioned behind content
  onClick={() => setSelectedKpi(...)}          // optional drill-down
/>
```

Design choices worth keeping:
- Trend and target-attainment render as **pill badges**, not progress bars — scans faster in a dense grid.
- `isTextValue` regex distinguishes a numeric/currency value from a free-text one (e.g. "Acme Corp" for
  a "Top Customer" card) and switches font size/weight accordingly — avoids truncation surprises.
- Sparkline is optional and absolutely positioned at low opacity behind the card content, not a separate
  layout slot.

## Chart option conventions (ECharts)

Every chart page follows the same shape — no custom wrapper, just a plain options object:

```tsx
const revenueBarOption = {
  tooltip: { trigger: 'axis', confine: true, backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a' } },
  grid: { left: '3%', right: '4%', bottom: '10%', top: '8%', containLabel: true },
  xAxis: { ... },
  yAxis: { ... },
  series: [{ type: 'bar', data: ... }],
};

<ReactECharts option={revenueBarOption} style={{ height: '100%' }} />
```

- `confine: true` on tooltips keeps them inside the chart container on small/dense dashboards.
- `containLabel: true` in `grid` so long axis labels don't get clipped — cheaper than hand-tuning margins.
- Build the option object inline from query data each render; ECharts diffs it, no need to memoize unless
  profiling says otherwise.

## Loading / error pattern

Every data-driven page follows the same three-state shape:

```tsx
if (isLoading) return <Loader2 className="animate-spin" />;
if (error || !data) return <div className="text-danger">Failed to load — backend might be unreachable.</div>;
// render
```

Nothing fancier (no skeleton charts, no suspense boundaries) — plenty for an internal dashboard.

## Filter bar

Shared `DateRangeControl` / `CompareModeSelect` components
([frontend/src/components/AnalyticsFilterBar.tsx](../src/components/AnalyticsFilterBar.tsx)) drive
`timeframe` / `startDate` / `endDate` / `compareMode` state that feeds straight into the query key.
Reuse this shape for any new dashboard: filter state → query key → refetch is automatic, no derived
"did filters change" logic needed.

## Theme tokens (Tailwind 4 `@theme`)

All color via CSS variables in [frontend/src/index.css](../src/index.css), redefined under `.dark` —
no `dark:` utility variants scattered through components, just one override block:

```css
@import "tailwindcss";
@custom-variant dark (&:is(.dark *));

@theme {
  --color-background: #ffffff;  --color-foreground: #09090b;  /* zinc-950 */
  --color-primary: #3b82f6;     /* blue-500 */
  --color-card: #ffffff;        --color-border: #e4e4e7;
  --color-success: #059669;  --color-warning: #d97706;  --color-danger: #dc2626;
  --radius-lg: 0.5rem;  --radius-md: 0.375rem;  --radius-sm: 0.25rem;
  --font-sans: 'Inter', sans-serif;
}
.dark {
  --color-background: #09090b;  --color-foreground: #fafafa;
  --color-primary: #60a5fa;     /* blue-400 — lighter accent so it still pops on dark */
  --color-card: #18181b;        /* zinc-900 */
  --color-success: #34d399;  --color-warning: #fbbf24;  --color-danger: #f87171;
}
```

- **Semantic names, not raw colors** (`bg-background`, `text-foreground`, `bg-card`) — components never
  hardcode a hex or a zinc-N shade, so the whole app re-themes from these two blocks.
- **Dark mode is a class, not a media query**: `document.documentElement.classList.toggle('dark', …)`.
  Applied in an inline `<script>` in `index.html` *before* React mounts (reads `localStorage.theme`,
  falls back to `prefers-color-scheme`) — avoids a flash of the wrong theme on load.
- `theme.tsx` — a tiny `ThemeProvider`/`useTheme()` context wrapping that same localStorage logic, for
  the toggle button in the header.
- **Gotcha worth noting**: `--font-sans: 'Inter', sans-serif` is declared but Inter is never actually
  loaded (no `<link>`, no `@font-face`, no npm font package) — it silently falls back to system
  sans-serif unless the user happens to have Inter installed. If you want Inter in the next project,
  actually load it (Google Fonts link or `@fontsource/inter`).
- A legacy-migration utility block in `index.css` force-overrides stray `bg-white` / `text-slate-*`
  utilities under `.dark` — a patch for old markup, not a pattern to copy; use the semantic tokens from
  the start instead and you won't need it.

## Navigation shell

[frontend/src/components/app-shell.tsx](../src/components/app-shell.tsx) is the real shell every
authenticated route renders inside (`App.tsx` wraps the `/app/*` routes in one `<AppShell>`). There's
also an older `Sidebar.tsx` with the same idea but no `Collapsible`/grouping — it's unused, not wired
into `App.tsx`; skip it.

Shape worth reusing:
- Flat `NAV_ITEMS` array of `{ label, path, icon, group, subItems?, roles? }`, grouped by `group` and
  rendered as collapsible sections (Radix `Collapsible.Root/Trigger/Content`) — adding a nav item is a
  one-line array entry, not new JSX.
- `roles` per item + `useAuth()` filters the array before render — same data drives both the sidebar and
  any route guarding, so the two can't drift.
- Sidebar collapse is a single `sidebarOpen` boolean collapsing icon-only vs. icon+label, not a separate
  mobile/desktop component.
- Header uses Radix `DropdownMenu` (user menu) and `Tooltip` (icon-only buttons when collapsed) — both
  from `@radix-ui/react-*` directly, no extra wrapper library beyond the local `ui/` primitives.
- Debounced search box (`useDebounce`) in the header hits the same `api` client and query-key pattern as
  the dashboard pages.

## Animation conventions (`motion/react`, formerly Framer Motion)

Used sparingly and the same way everywhere — page-level entrance, not micro-animations on every element:

```tsx
<motion.div
  initial={{ opacity: 0, y: 10 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
  className="flex-1 overflow-y-auto p-4 ..."
>
  {/* whole page content */}
</motion.div>
```

- One `motion.div` wrapping the page's root content — fade + slight rise on mount. That's the fade-in
  pattern for every analytics page.
- Occasional nested `motion.div` for a section that mounts conditionally (e.g. a drill-down panel),
  same `initial`/`animate`/`transition` shape.
- No spring physics, no stagger/orchestration, no `AnimatePresence` gymnastics — `duration: 0.3` tween
  is the one timing value used throughout. Don't reach for more unless a specific interaction needs it.
- Everything else (hover states, active nav highlight, button presses) is plain Tailwind `transition-*`
  / `hover:` classes, not JS-driven animation — cheaper and it's what Radix components expect anyway.

## What to skip in the next project

- Don't build a custom SVG chart primitive library (visx or otherwise) unless ECharts genuinely can't do
  something you need — it wasn't used here despite existing.
- Don't add a chart-theming abstraction layer; a couple of shared constants (colors, tooltip style) for
  the option objects is enough at this scale.
- Don't build a separate mobile nav component — one `sidebarOpen` boolean covers collapse.
- Don't reach for spring physics or animation orchestration libraries; a single fade+rise tween on page
  mount covered every case here.
