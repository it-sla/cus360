# UX System Flow — Customer 360

**Scope:** navigation architecture and usability only — not functional correctness (see `qa/BUGS.md` / `docs/10-known-issues.md` for that). Walked live against the Vite dev server (`:5173`) as `admin@gmail.com`, one page at a time, noting how a first-time user would experience getting around.

**Note on source of truth:** the sidebar and route list here were read directly from the running app on 2026-08-14 and differ from `docs/07-frontend.md`'s route table in several places (see "Docs drift" at the end) — the app has grown since that doc was last verified. Treat this file, not the older doc, as current for navigation.

---

## 1. Entry flow

```
Landing (/)  →  [Sign in]  →  /app (Executive Overview)
```

- Landing page is a single headline + one "Sign in" button — no marketing detail, no login form fields visible before the click.
- "Sign in" currently drops straight into the dashboard on an existing session with no visible credential form in this flow — fine for a returning user, but gives a first-time visitor no cue about how authentication actually works.
- Browser tab title is the Vite scaffold default `frontend_new` throughout every page — never changes per-route. In a multi-tab workflow there's no way to tell this tab apart from any other by its title.

---

## 2. Navigation shell (present on every `/app/*` page)

```
┌─────────────────────────────────────────────────────────┐
│ ☰  [Jump to page… Ctrl K]   [Search Customer 360......]  👤 Administrator │
├───────────────┬─────────────────────────────────────────┤
│ Executive      │                                         │
│ Business An.   │                                         │
│ Customers      │              <page content>             │
│ Operations     │                                         │
│ Intelligence   │                                         │
│ Data & Integ.  │                                         │
│ Administration │                                         │
│                │                                         │
│ ● All systems  │                                         │
│   operational  │                                         │
└───────────────┴─────────────────────────────────────────┘
```

Three parallel wayfinding tools exist at once:
1. **Sidebar** — 6 collapsible category groups, click-to-expand accordions.
2. **Ctrl+K / "Jump to page…"** — command-palette style fuzzy search over all page names.
3. **Top search box** ("Search Customer 360") — searches *data* (customers, AWBs, shipments), not pages; Enter lands on a full Universal Search results page.

These serve genuinely different jobs (navigate vs. find a record) and the split is reasonable, but nothing on first look tells a new user that the top box searches *data* while Ctrl+K searches *pages* — they look similar enough to be reached for interchangeably.

---

## 3. Full route map (as built today)

### Executive
| Page | Route | Notes |
|---|---|---|
| Executive Overview | `/app` | Landing dashboard after login. KPI cards, top customers, top destinations, tier distribution. |

### Business Analytics *(sub-group — 5 pages nested one level deeper than every other sidebar item)*
| Page | Route | Notes |
|---|---|---|
| Revenue Analytics | `/app/analytics#revenue` | Page heading reads **"Enterprise Analytics Workspace"** — doesn't match either the sidebar label ("Business Analytics" / "Revenue Analytics") or the URL fragment. |
| Customer Analytics | `/app/customer-analytics` | Heading: "Customer Performance". |
| AE Performance ⭐ | `/app/ae-performance` | Only sidebar item with a star — no visible legend for what the star means. |
| Geography | `/app/geography` | Country/origin/destination filters. |
| Operational KPIs | `/app/operations` | Heading: "Operational KPIs". |
| Universal Search | `/app/search` | Sits under Executive in the sidebar, not under Business Analytics — the one entity-search page grouped with dashboards rather than with Customers/Operations. |

### Customers
| Page | Route | Notes |
|---|---|---|
| Customer Directory | `/app/customers` | List → detail drill-down into Customer 360 works cleanly; filter bar (status/segment/pay-terms) is consistent with other list pages. |

### Operations
| Page | Route | Notes |
|---|---|---|
| Air Waybills | `/app/awb` | List + status/weight filters. |
| Master Air Waybills | `/app/mawb` | Consolidated view, PP/FC/FD kept separate per data rules. |

### Intelligence
| Page | Route | Notes |
|---|---|---|
| Profitability | `/app/profitability` | Bill vs. UPS-cost margin, per MAWB. (Docs still list this as a stub — it's fully built now.) |
| Rankings | `/app/rankings` | Top Customers / AEs / Routes, three tabs, ranked-by toggle (Revenue/Shipments/Weight). |
| Alerts | `/app/alerts` (sidebar badge: **520**) | Page shows **606 active alerts, 520 of them "Critical (High)."** The sidebar badge is the critical-only count, not the total — a user glancing at the badge would reasonably read it as "520 alerts" full stop. |
| Active Pipeline | `/app/pipeline` | CRM pipeline synced periodically; explains its own color-coding (amber/red) inline — good self-documenting copy. |

### Data & Integration
| Page | Route | Notes |
|---|---|---|
| CRM Sync | `/app/sync` | Ops-console styling: all-caps labels ("TRIGGER SYNC," "PAUSE WORKER"), a literal `tail -f /var/log/crm_worker.log` live log feed. Tonally this is a different product from the rest of the app — appropriate for an engineer, opaque for a general admin user. |
| Matching Review | `/app/matching` | Empty state reads "Inbox Zero — All shipments have been successfully matched." Good, human copy — best empty-state on the site. |
| Data Quality | `/app/quality` | Leads with a large unexplained number ("82,999" sync/import issues) before any context on severity or what's actionable; a second line does clarify most are self-resolving, but the big number lands first. |

### Administration
| Page | Route | Notes |
|---|---|---|
| Customer Management | `/app/customer-management` | Explicitly disambiguates itself from Customer Directory in its subtitle: *"Create, edit, and archive master customer records. For analytics and activity, use Customer Directory."* Good instinct — but the fact that two separately-named, separately-grouped pages both manage "customers" and need a disclaimer to tell apart is itself the underlying friction. |
| AE Assignment | `/app/ae-assignment` | Excel import for territory assignment; explains its column contract and confirms-before-write in the UI copy. |
| AE Targets | `/app/ae-targets` | Spreadsheet-style monthly target grid, click-to-edit cells. |
| Users | `/app/users` | Fully functional (docs describe it as a stub with no backend — that's now stale). |
| Audit Logs | `/app/audit-logs` | Fully functional (also documented as a stub — also stale). Minor: action names render in raw enum-ish form, e.g. `Ae_reassigned` instead of "AE Reassigned." |

**AE Assignment / AE Targets / AE Performance** is a three-way name collision across three different sidebar groups (Administration, Administration, Business Analytics respectively) — all plausible things to look for under a generic "AE" mental search, none co-located.

---

## 4. Drill-down pattern (Customer Directory → Customer 360)

```
Customer Directory (list, filterable)
        │  click a row
        ▼
Customer 360 (detail)
   [←]  Company Name              [PDF]
   Overview | Analytics | Shipments | Documents | Activity | Settings
        │  click [←]
        ▼
Customer Directory (same filtered list, preserved)
```

- The tab strip (Overview/Analytics/Shipments/Documents/Activity/Settings) is the strongest navigation pattern in the app — predictable, labeled, no ambiguity.
- The **back control is icon-only, no text label, no tooltip observed** — the single weakest link in an otherwise clean flow, because it's also the *only* wayfinding element on the detail page (no breadcrumb, no "Customers /" trail).
- Returning to the list preserves the previous filter state, which is the correct behavior and easy to take for granted — it's worth calling out because getting this wrong is a common source of "where did my search go" frustration.

---

## 5. Command palette (Ctrl+K) behavior

Typing a partial term matches loosely across category headers and page names simultaneously, with no visible relevance ordering:

```
type: "alert"
  → Executive
    Universal Search
  → Operations
    Air Waybills
    Master Air Waybills
  → Intelligence
    Alerts                    ← the actual target, buried mid-list
  → Data & Integration
    Data Quality
```

For a beginner relying on this as "type the page name, hit enter," the lack of ranking means the intended result isn't reliably first or even near the top.

---

## 6. Consistency scorecard

| Pattern | Consistent across pages? |
|---|---|
| List page filter bar (search + dropdowns + "More Filters") | Yes — Customer Directory, AWBs, MAWBs, Users all follow the same left-to-right layout |
| Time-period + comparison selector on analytics pages | Yes — identical control appears on all 5 Business Analytics pages |
| Page heading matches sidebar label | **No** — Revenue Analytics → "Enterprise Analytics Workspace"; Business Analytics group → different label at every level |
| Empty states | Inconsistent quality — Matching Review's "Inbox Zero" is excellent; Data Quality's leads with a raw large number instead |
| Detail-page navigation (back / breadcrumb) | Icon-only, unlabeled, no breadcrumb — same weak pattern wherever a detail view exists |
| Visual tone (customer-facing vs. ops-facing) | **No** — CRM Sync page (raw log tail, all-caps buttons) reads like a different application from Executive Overview or Customer 360 |

---

## 7. Docs drift (for context, not a UX finding)

`docs/07-frontend.md`'s route table (written 2026-08-06) is missing `/app/pipeline`, `/app/customer-management`, `/app/ae-assignment`, `/app/ae-targets`, and lists Profitability, Rankings, Users, and Audit Logs as stubs — all four are fully built now. Worth a doc refresh separately; not something this file fixes.

---

## 8. Summary — top 5 things to fix for smoother navigation

1. Label (or add a tooltip/text to) the detail-page back button, and consider a breadcrumb trail — the single biggest orientation gap.
2. Make the sidebar Alerts badge show the same number as the page's headline count (or clarify it's "critical only").
3. Resolve the AE Assignment / AE Targets / AE Performance naming collision — co-locate or rename.
4. Align page headings with their sidebar labels (Revenue Analytics is the clearest offender).
5. Bring CRM Sync's visual tone in line with the rest of the app, or clearly mark it as an advanced/ops-only surface.
