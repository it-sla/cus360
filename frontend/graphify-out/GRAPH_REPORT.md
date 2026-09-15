# Graph Report - frontend  (2026-09-13)

## Corpus Check
- 153 files · ~117,823 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1149 nodes · 1875 edges · 128 communities (76 shown, 52 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- x-axis.tsx
- chart-tooltip.tsx
- pie-context.tsx
- api.ts
- projection-utils.ts
- AEPerformance.tsx
- devDependencies
- compilerOptions
- Customer360.tsx
- DataQuality.tsx
- components.json
- react
- area.tsx
- time-series-chart-shell.tsx
- MasterAirWaybills.tsx
- compilerOptions
- area-chart.tsx
- sidebar-component.tsx
- App.tsx
- series-markers.tsx
- y-domain-utils.ts
- useChartStable
- Rankings.tsx
- AnalyticsFilterBar.tsx
- chart-context.tsx
- dependencies
- Users.tsx
- app-shell.tsx
- series-dash-tail-overlay.tsx
- animation.ts
- useChartHover
- y-axis-scales.ts
- Alerts.tsx
- auth.tsx
- use-chart-interaction.ts
- dropdown-menu.tsx
- plugins
- reference-area-config.ts
- input-group.tsx
- sheet.tsx
- table.tsx
- api
- Leaderboard.tsx
- area-chart-loading.tsx
- chart-defs.ts
- leaderboard-rankings.tsx
- navigation-menu.tsx
- select.tsx
- Profitability.tsx
- AeAssignment.tsx
- UniversalSearch.tsx
- card.tsx
- dialog.tsx
- CustomerDirectory.tsx
- AeTargets.tsx
- CustomerAnalytics.tsx
- CustomerManagement.tsx
- Pipeline.tsx
- AuditLogs.tsx
- AlertBanner.tsx
- DocumentTypeAnalytics.tsx
- OperationalAnalytics.tsx
- React + TypeScript + Vite
- KpiCard.tsx
- avatar.tsx
- badge.tsx
- button.tsx
- tabs.tsx
- GeographyAnalytics.tsx
- ExecutiveLayout.tsx
- neural-access-login.tsx
- tsconfig.json
- axios
- @base-ui/react
- @carbon/icons-react
- class-variance-authority
- clsx
- cmdk
- d3-array
- d3-shape
- date-fns
- echarts
- framer-motion
- geist
- html2canvas
- jspdf
- lucide-react
- maplibre-gl
- @number-flow/react
- @radix-ui/react-avatar
- @radix-ui/react-checkbox
- @radix-ui/react-collapsible
- @radix-ui/react-dialog
- @radix-ui/react-dropdown-menu
- @radix-ui/react-hover-card
- @radix-ui/react-navigation-menu
- @radix-ui/react-popover
- @radix-ui/react-select
- @radix-ui/react-separator
- @radix-ui/react-slot
- @radix-ui/react-tabs
- @radix-ui/react-tooltip
- react-day-picker
- react-dom
- react-hook-form
- react-map-gl
- react-router-dom
- recharts
- tailwind-merge
- @tanstack/react-query
- @tanstack/react-table
- @visx/curve
- @visx/gradient
- @visx/grid
- @visx/group
- @visx/responsive
- @visx/scale
- @visx/shape
- zod

## God Nodes (most connected - your core abstractions)
1. `react` - 109 edges
2. `useChartStable()` - 23 edges
3. `compilerOptions` - 21 edges
4. `api` - 15 edges
5. `compilerOptions` - 15 edges
6. `ChartPhase` - 14 edges
7. `useChartConfig()` - 12 edges
8. `normalizeYAxisId()` - 11 edges
9. `Margin` - 10 edges
10. `LineConfig` - 10 edges

## Surprising Connections (you probably didn't know these)
- `CalendarDayButton()` --references--> `react`  [EXTRACTED]
  src/components/ui/calendar.tsx → package.json
- `ContainerScroll()` --references--> `react`  [EXTRACTED]
  src/components/ui/container-scroll-animation.tsx → package.json
- `ExecutiveOverview()` --references--> `react`  [EXTRACTED]
  src/pages/ExecutiveOverview.tsx → package.json
- `CustomerAnalytics()` --references--> `xlsx`  [EXTRACTED]
  src/pages/CustomerAnalytics.tsx → package.json
- `DateRangeControl()` --references--> `react`  [EXTRACTED]
  src/pages/AEPerformance.tsx → package.json

## Import Cycles
- None detected.

## Communities (128 total, 52 thin omitted)

### Community 0 - "x-axis.tsx"
Cohesion: 0.05
Nodes (50): ChartLoadingLabel(), ChartLoadingLabelProps, Grid(), GridProps, hideEdgeTicks(), resolveRowTickValues(), LINE_LOADING_PULSE_EASE, BarLoadingSkeleton() (+42 more)

### Community 1 - "chart-tooltip.tsx"
Cohesion: 0.08
Nodes (41): ChartConfigContext, ChartConfigProviderProps, ChartConfigValue, DEFAULT_CHART_CONFIG, resolveTooltipBoxMotion(), SpringConfig, useChartConfig(), chartCssVars (+33 more)

### Community 2 - "pie-context.tsx"
Cohesion: 0.07
Nodes (36): ChartStatFlow(), ChartStatFlowFormat, ChartStatFlowProps, defaultChartStatFlowFormat, formatStatValue(), useNumberFlowElementReady(), PieCenter(), PieCenterProps (+28 more)

### Community 3 - "api.ts"
Cohesion: 0.05
Nodes (42): AccountExecutive, AdminUserPatch, AeImportBatch, AeImportRow, AEPerformanceResponse, AeReassignmentLogEntry, AeTargetInput, AnalyticsFilterParams (+34 more)

### Community 4 - "projection-utils.ts"
Cohesion: 0.08
Nodes (35): CHART_CLIP_PASSTHROUGH, CLIP_EXCLUDED_COMPONENT_NAMES, isChartClipPassthrough(), isClipExcludedComponent(), isPostOverlayComponent(), isUnderlayComponent(), resolveChartChildElement(), UNDERLAY_COMPONENT_NAMES (+27 more)

### Community 5 - "AEPerformance.tsx"
Cohesion: 0.07
Nodes (23): react, react, AECustomer, AEPerformanceItem, AeTarget, CalendarDayButton(), ContainerScroll(), AEPerformance() (+15 more)

### Community 6 - "devDependencies"
Cohesion: 0.06
Nodes (33): autoprefixer, oxlint, devDependencies, autoprefixer, oxlint, postcss, tailwindcss, @tailwindcss/postcss (+25 more)

### Community 7 - "compilerOptions"
Cohesion: 0.07
Nodes (26): DOM, src, vite/client, compilerOptions, allowArbitraryExtensions, allowImportingTsExtensions, baseUrl, erasableSyntaxOnly (+18 more)

### Community 8 - "Customer360.tsx"
Cohesion: 0.11
Nodes (19): ActivityLog, CallLog, CompanyDetail, CompanyShipment, ActivityTab(), AnalyticsTab(), CallLogsTab(), Customer360() (+11 more)

### Community 9 - "DataQuality.tsx"
Cohesion: 0.14
Nodes (21): CompanyConflict, DataQualityIssue, CONFIDENCE_STYLES, conflictKey(), DataQuality(), DEFAULT_ISSUE_TYPES, FixDialog(), fmtDateTime() (+13 more)

### Community 10 - "components.json"
Cohesion: 0.09
Nodes (22): aliases, components, hooks, lib, ui, utils, iconLibrary, menuAccent (+14 more)

### Community 11 - "react"
Cohesion: 0.09
Nodes (10): react, HoverCardContent, Input, InteractiveHoverButton, InteractiveHoverButtonProps, PopoverContent, ScrollArea, ScrollBar (+2 more)

### Community 12 - "area.tsx"
Cohesion: 0.22
Nodes (18): Area(), AreaProps, CurveFactory, AreaGradientDefs(), AreaGradientDefsProps, useAreaLoadingPulseState(), FadeEdges, FadeGradientStop (+10 more)

### Community 13 - "time-series-chart-shell.tsx"
Cohesion: 0.13
Nodes (13): decimateTimeSeries(), maxRenderPointsForWidth(), filterDataByXDomain(), resolveBrushTrackXExtent(), resolveDataXExtent(), ReferenceAreaRegistrationContext, computeSeriesBarRevealClipPadding(), computeSeriesBarWidth() (+5 more)

### Community 14 - "MasterAirWaybills.tsx"
Cohesion: 0.16
Nodes (17): AirWaybills(), fmt$(), fmtDate(), fmtWeight(), ShipmentDetailDrawer(), shipmentWeight(), useDebounce(), AIRLINES (+9 more)

### Community 15 - "compilerOptions"
Cohesion: 0.10
Nodes (19): node, vite.config.ts, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleDetection (+11 more)

### Community 16 - "area-chart.tsx"
Cohesion: 0.19
Nodes (16): AreaChart(), AreaChartProps, ChartInner(), ChartInnerProps, DEFAULT_MARGIN, extractAreaConfigs(), LineConfig, Margin (+8 more)

### Community 17 - "sidebar-component.tsx"
Cohesion: 0.11
Nodes (6): DetailSidebar(), getSidebarContent(), MenuItemT, MenuSectionT, SidebarContent, svgPaths

### Community 18 - "App.tsx"
Cohesion: 0.13
Nodes (4): Settings(), ExecutiveOverview(), LandingPage(), LoginPage()

### Community 19 - "series-markers.tsx"
Cohesion: 0.16
Nodes (15): defaultScatterColors, useYScale(), MarkerStyle, PointAt, SeriesMarkers(), SeriesMarkersActiveHighlightProps, SeriesMarkersDimWrapperProps, SeriesMarkersProps (+7 more)

### Community 20 - "y-domain-utils.ts"
Cohesion: 0.30
Nodes (12): ChartContextValue, ChartPhase, lerpDomain(), snapDomains(), tweenDomains(), useAnimatedYDomains(), UseAnimatedYDomainsOptions, domainsEqual() (+4 more)

### Community 21 - "useChartStable"
Cohesion: 0.22
Nodes (11): useChartStable(), computeSegmentBounds(), INACTIVE_SEGMENT, SegmentBounds, HighlightSegment(), HighlightSegmentProps, LineLoadingSweep(), SeriesHighlightLayer() (+3 more)

### Community 22 - "Rankings.tsx"
Cohesion: 0.16
Nodes (10): xlsx, CustomerMetric, DEFAULT_RANK_STYLE, fmt$(), fmtNum(), METRIC_OPTIONS, RANK_STYLE, Rankings() (+2 more)

### Community 23 - "AnalyticsFilterBar.tsx"
Cohesion: 0.18
Nodes (10): COMPARE_MODE_OPTIONS, DateRangeControl(), fmtShortDate(), isoDaysAgo(), localIso(), SEGMENTS, SelectOption, TIMEFRAME_GROUPS (+2 more)

### Community 24 - "chart-context.tsx"
Cohesion: 0.15
Nodes (12): ChartHoverContext, ChartHoverContextValue, ChartProvider(), ChartStableContext, ChartStableContextValue, ScaleBand, ScaleLinear, ScaleTime (+4 more)

### Community 25 - "dependencies"
Cohesion: 0.15
Nodes (13): echarts-for-react, @hookform/resolvers, motion, dependencies, echarts-for-react, @hookform/resolvers, motion, @radix-ui/react-scroll-area (+5 more)

### Community 26 - "Users.tsx"
Cohesion: 0.17
Nodes (9): AdminUser, AuthRole, BulkCreateUserResult, NewUserRow, emptyRow(), ROLE_LABELS, ROLE_STYLES, Users() (+1 more)

### Community 27 - "app-shell.tsx"
Cohesion: 0.26
Nodes (12): activeGroupFor(), AppShell(), bucketLabel(), cleanInsightDescription(), daysAgo(), GROUP_ORDER, INSIGHT_CATEGORY_ICON, insightIcon() (+4 more)

### Community 28 - "series-dash-tail-overlay.tsx"
Cohesion: 0.22
Nodes (9): DashTailStroke(), DashTailStrokeProps, EMPTY_METRICS, PathStrokeMetrics, resolveDashStartX(), resolveDashTailBounds(), SeriesDashTailOverlay, SeriesDashTailOverlayImpl() (+1 more)

### Community 29 - "animation.ts"
Cohesion: 0.23
Nodes (6): clipRevealTransition(), DEFAULT_CHART_ENTER_TRANSITION, ChartRevealClip(), ChartRevealClipMode, ChartRevealClipProps, SpringOptions

### Community 30 - "useChartHover"
Cohesion: 0.23
Nodes (9): useChart(), useChartHover(), ChartLegendHoverContext, ChartLegendHoverContextValue, useChartLegendHover(), SeriesHoverDim(), SeriesHoverDimProps, SeriesMarkersActiveHighlight() (+1 more)

### Community 31 - "y-axis-scales.ts"
Cohesion: 0.23
Nodes (10): buildYScalesForLines(), buildYScalesFromDomains(), getPrimaryYScale(), groupLinesByYAxisId(), normalizeYAxisId(), YAxisOrientation, YScale, computeYDomainsByAxis() (+2 more)

### Community 32 - "Alerts.tsx"
Cohesion: 0.20
Nodes (11): Alert, Alerts(), CATEGORIES, getIcon(), metricLabel(), SEVERITY_BAR, SEVERITY_DOT, SEVERITY_LABEL (+3 more)

### Community 33 - "auth.tsx"
Cohesion: 0.22
Nodes (6): App(), AuthContext, AuthContextValue, AuthProvider(), AuthStatus, queryClient

### Community 34 - "use-chart-interaction.ts"
Cohesion: 0.29
Nodes (8): TooltipData, ChartInteractionResult, ScaleLinear, ScaleTime, useChartInteraction(), defaultDedupeKey(), ScheduledTooltipControls, useScheduledTooltip()

### Community 36 - "dropdown-menu.tsx"
Cohesion: 0.20
Nodes (8): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSubContent, DropdownMenuSubTrigger

### Community 37 - "plugins"
Cohesion: 0.22
Nodes (8): plugins, rules, react/only-export-components, react/rules-of-hooks, $schema, oxc, typescript, warn

### Community 38 - "reference-area-config.ts"
Cohesion: 0.33
Nodes (6): extractReferenceAreaConfigs(), getChildComponentName(), isReferenceAreaElement(), ReferenceAreaConfig, ReferenceAreaConfigProps, ReferenceAreaRegistrationContextValue

### Community 39 - "input-group.tsx"
Cohesion: 0.28
Nodes (4): InputGroupAddon(), inputGroupAddonVariants, InputGroupButton(), inputGroupButtonVariants

### Community 40 - "sheet.tsx"
Cohesion: 0.22
Nodes (6): SheetContent, SheetContentProps, SheetDescription, SheetOverlay, SheetTitle, sheetVariants

### Community 41 - "table.tsx"
Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 42 - "api"
Cohesion: 0.29
Nodes (4): api, Shipment, CrmSync(), fmtDate()

### Community 43 - "Leaderboard.tsx"
Cohesion: 0.32
Nodes (6): LeaderboardEntry, bylineFor(), Leaderboard(), Metric, METRIC_META, rankLabel()

### Community 44 - "area-chart-loading.tsx"
Cohesion: 0.36
Nodes (6): AreaChartLoading(), AreaChartLoadingProps, LoadingStyle, generateChartSkeletonData(), GenerateChartSkeletonDataOptions, generateChartSkeletonFromTarget()

### Community 45 - "chart-defs.ts"
Cohesion: 0.50
Nodes (7): collectChartDefsChildren(), getChartChildComponentName(), isChartDefsComponent(), isGradientDefComponent(), isPatternDefComponent(), partitionChartDefNodes(), VISX_PATTERN_COMPONENT_NAMES

### Community 46 - "leaderboard-rankings.tsx"
Cohesion: 0.25
Nodes (6): crownColorMap, LeaderboardRankingItem, LeaderboardRankings, LeaderboardRankingsProps, LeaderboardRow, pageSizeOptions

### Community 47 - "navigation-menu.tsx"
Cohesion: 0.25
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 48 - "select.tsx"
Cohesion: 0.25
Nodes (7): SelectContent, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton, SelectSeparator, SelectTrigger

### Community 49 - "Profitability.tsx"
Cohesion: 0.46
Nodes (7): addDays(), daysBetween(), fmt$(), fmt$Compact(), fmtDate(), pctChange(), Profitability()

### Community 50 - "AeAssignment.tsx"
Cohesion: 0.48
Nodes (6): AeImportPreview, fmtDateTime(), fmtNum(), ImportTab(), RosterTab(), StatCard()

### Community 51 - "UniversalSearch.tsx"
Cohesion: 0.38
Nodes (6): SearchResultItem, FILTER_CHIPS, fmt$(), PRESET_RECENTS, UniversalSearch(), useDebounce()

### Community 52 - "card.tsx"
Cohesion: 0.29
Nodes (6): Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle

### Community 53 - "dialog.tsx"
Cohesion: 0.29
Nodes (4): DialogContent, DialogDescription, DialogOverlay, DialogTitle

### Community 54 - "CustomerDirectory.tsx"
Cohesion: 0.43
Nodes (5): CustomerDirectory(), fmt$(), fmtWeight(), STATUS_BADGES, useDebounce()

### Community 55 - "AeTargets.tsx"
Cohesion: 0.47
Nodes (4): AeTargets(), EditState, fmt$(), MONTHS

### Community 56 - "CustomerAnalytics.tsx"
Cohesion: 0.53
Nodes (4): CustomerAnalytics(), fmt$(), fmtAxisDate(), fmtNum()

### Community 57 - "CustomerManagement.tsx"
Cohesion: 0.33
Nodes (4): CUSTOMER_TYPE_OPTIONS, EMPTY_FORM, FormState, STATUS_OPTIONS

### Community 58 - "Pipeline.tsx"
Cohesion: 0.67
Nodes (5): formatDate(), formatMoney(), hoursAgo(), Pipeline(), relativeSyncTime()

### Community 60 - "AlertBanner.tsx"
Cohesion: 0.40
Nodes (3): AlertBannerProps, AlertType, typeConfig

### Community 61 - "DocumentTypeAnalytics.tsx"
Cohesion: 0.60
Nodes (3): DocumentTypeAnalytics(), fmt$(), fmtNum()

### Community 62 - "OperationalAnalytics.tsx"
Cohesion: 0.70
Nodes (4): fmt$(), fmtDate(), fmtNum(), OperationalAnalytics()

### Community 63 - "React + TypeScript + Vite"
Cohesion: 0.50
Nodes (3): Expanding the Oxlint configuration, React Compiler, React + TypeScript + Vite

### Community 66 - "avatar.tsx"
Cohesion: 0.50
Nodes (3): Avatar, AvatarFallback, AvatarImage

### Community 67 - "badge.tsx"
Cohesion: 0.67
Nodes (3): Badge(), BadgeProps, badgeVariants

### Community 68 - "button.tsx"
Cohesion: 0.50
Nodes (3): Button, ButtonProps, buttonVariants

### Community 69 - "tabs.tsx"
Cohesion: 0.50
Nodes (3): TabsContent, TabsList, TabsTrigger

### Community 70 - "GeographyAnalytics.tsx"
Cohesion: 0.83
Nodes (3): fmt$(), fmtNum(), GeographyAnalytics()

## Knowledge Gaps
- **405 isolated node(s):** `$schema`, `typescript`, `oxc`, `react/rules-of-hooks`, `warn` (+400 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **52 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `react` to `x-axis.tsx`, `chart-tooltip.tsx`, `pie-context.tsx`, `projection-utils.ts`, `AEPerformance.tsx`, `Customer360.tsx`, `DataQuality.tsx`, `area.tsx`, `time-series-chart-shell.tsx`, `MasterAirWaybills.tsx`, `area-chart.tsx`, `sidebar-component.tsx`, `App.tsx`, `series-markers.tsx`, `y-domain-utils.ts`, `useChartStable`, `Rankings.tsx`, `AnalyticsFilterBar.tsx`, `chart-context.tsx`, `Users.tsx`, `app-shell.tsx`, `series-dash-tail-overlay.tsx`, `animation.ts`, `useChartHover`, `Alerts.tsx`, `auth.tsx`, `use-chart-interaction.ts`, `command.tsx`, `dropdown-menu.tsx`, `plugins`, `reference-area-config.ts`, `input-group.tsx`, `sheet.tsx`, `table.tsx`, `api`, `Leaderboard.tsx`, `area-chart-loading.tsx`, `chart-defs.ts`, `leaderboard-rankings.tsx`, `navigation-menu.tsx`, `select.tsx`, `Profitability.tsx`, `AeAssignment.tsx`, `UniversalSearch.tsx`, `card.tsx`, `dialog.tsx`, `CustomerDirectory.tsx`, `AeTargets.tsx`, `CustomerAnalytics.tsx`, `CustomerManagement.tsx`, `Pipeline.tsx`, `AuditLogs.tsx`, `DocumentTypeAnalytics.tsx`, `OperationalAnalytics.tsx`, `KpiCard.tsx`, `Sidebar.tsx`, `avatar.tsx`, `badge.tsx`, `button.tsx`, `tabs.tsx`, `GeographyAnalytics.tsx`, `ExecutiveLayout.tsx`, `neural-access-login.tsx`?**
  _High betweenness centrality (0.640) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `AEPerformance.tsx`, `devDependencies`, `Rankings.tsx`, `axios`, `@base-ui/react`, `@carbon/icons-react`, `class-variance-authority`, `clsx`, `cmdk`, `d3-array`, `d3-shape`, `date-fns`, `echarts`, `framer-motion`, `geist`, `html2canvas`, `jspdf`, `lucide-react`, `maplibre-gl`, `@number-flow/react`, `@radix-ui/react-avatar`, `@radix-ui/react-checkbox`, `@radix-ui/react-collapsible`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-hover-card`, `@radix-ui/react-navigation-menu`, `@radix-ui/react-popover`, `@radix-ui/react-select`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-tabs`, `@radix-ui/react-tooltip`, `react-day-picker`, `react-dom`, `react-hook-form`, `react-map-gl`, `react-router-dom`, `recharts`, `tailwind-merge`, `@tanstack/react-query`, `@tanstack/react-table`, `@visx/curve`, `@visx/gradient`, `@visx/grid`, `@visx/group`, `@visx/responsive`, `@visx/scale`, `@visx/shape`, `zod`?**
  _High betweenness centrality (0.221) - this node is a cross-community bridge._
- **Why does `react` connect `AEPerformance.tsx` to `dependencies`, `App.tsx`?**
  _High betweenness centrality (0.140) - this node is a cross-community bridge._
- **What connects `$schema`, `typescript`, `oxc` to the rest of the system?**
  _405 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `x-axis.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.05273937532002048 - nodes in this community are weakly interconnected._
- **Should `chart-tooltip.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08490566037735849 - nodes in this community are weakly interconnected._
- **Should `pie-context.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.06787330316742081 - nodes in this community are weakly interconnected._