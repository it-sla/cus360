# Customer 360 System Memory Bank & Architecture Specification

**Last Updated**: 2026-07-27  
**Production URL**: `http://192.168.101.244:8090`  
**Remote Dev Host**: `shangrila002@100.94.204.57` (`~/customer360-dev/`)

---

## 🚀 2026 Enterprise Technology Stack & Architectural Standards

| Layer / Technology | Reference / Specification | Role & Standards in Customer 360 |
| :--- | :--- | :--- |
| **UI Components** | `shadcn/ui` (`github.com/shadcn-ui/ui`) | Zinc/Slate design tokens, crisp 1px borders (`border-slate-200`), `rounded-xl` (12px), ambient drop shadows (`shadow-sm`). |
| **Styling Engine** | `Tailwind CSS` | Utility class layout system (`flex`, `grid`, `gap-4`, `bg-white`, `text-slate-900`). |
| **Data Tables** | `TanStack Table` | Modern tabular sorting, status pills, pagination, and sticky headers. |
| **Charts & Visuals** | `Tremor + Recharts` (`github.com/tremorlabs/tremor`) | Gradient area growth trend charts, revenue tier donut cards, Pareto 80/20 risk distribution bars. |
| **CRM Patterns** | `Twenty` (`github.com/twentyhq/twenty`) | 6-KPI Spotlight Cards Band (*Total Revenue, Active Clients, New Accounts, Shipments, Avg Spend, Retention Score*), customer match indicators, AE portfolio slide-over drawers. |
| **Admin Patterns** | `Refine` (`refine.dev`) | Resource routing, CRM sync queue console, data quality governance issue logs. |
| **Icons** | `Lucide` (`lucide-react`) | Crisp SVG icons (`DollarSign`, `Users`, `UserPlus`, `Package`, `ShieldCheck`, `TrendingUp`). |
| **Animations** | `Motion` (`framer-motion`) | Fluid page transitions, tab switches, and slide-over drawer animations (`AnimatedGroup`, `InView`). |
| **Advanced Components** | `Origin UI` (`originui.com`) | Micro-animations, `<SpotlightCard>`, `<ShimmerButton>`, `<NumberTicker>`. |
| **Analytics Inspiration** | `Metabase + Grafana` | Executive intelligence narrative summaries, KPI spotlight cards, Pareto concentration risk metrics. |
| **Workflow Visualization** | `React Flow` (`@xyflow/react`) | Pipeline node visualizations for cargo shipment tracking and CRM sync loops. |

---

## 📦 Domain Rules & Verification Order

1. **ICRIS Authority**: Authoritative, unique, case-insensitive customer identity.
2. **26-Header Manifest Contract**: Strict Excel import contract defined in `backend/app/imports.py`.
3. **Read-Only Scraper Loop**: `crm-scraper` container executes read-only ASP.NET Web Forms postbacks.
4. **Verification Protocol Order**:
   `alembic upgrade head` → `pytest` → `npm run typecheck` → `npm run build`

---

## 📊 Latest Test & Quality Metrics

- **Pytest Unit Test Suite**: **89 / 89 Passed** (100%).
- **TypeScript Typecheck**: **0 Errors**.
- **Vite Production Build**: **2776 modules compiled** (2.23s).
- **Chrome Playwright Verification**: **100% Passed** (0 console errors, 0 network errors).
- **Screenshot Repository**: 75 visual audit screenshots in `c:\Projects\customer360\ss\`.
