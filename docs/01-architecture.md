# Architecture

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI · SQLAlchemy 2 · Pydantic 2 · Alembic · Python 3.12 |
| Database | PostgreSQL 16, driver `psycopg` v3 |
| CRM connector | `httpx` + `BeautifulSoup4` — **no Playwright, no Chromium** |
| PDF generation | `reportlab` |
| Excel parsing | `openpyxl` (`.xlsx`), `xlrd` (`.xls`), `pandas` |
| Fuzzy matching | `rapidfuzz` (suggestion-only, see [03-data-rules.md](03-data-rules.md)) |
| Frontend | React 19 · TypeScript 6 · Vite 8 · TanStack Query 5 · Axios · Tailwind CSS 4 |
| Charts | ECharts, Recharts, visx, MapLibre |
| UI primitives | Radix UI, Base UI, lucide-react, framer-motion |

## Docker Compose services

| Service | Image / build | Port | Purpose |
|---|---|---|---|
| `db` | `postgres:16-alpine` | 5432 | Primary datastore |
| `backend` | `./backend/Dockerfile` | 8360 → 8000 | FastAPI via Uvicorn `--reload`; runs `alembic upgrade head` on start |
| `frontend` | `./frontend/Dockerfile` | 5173 | Vite dev server with HMR |
| `crm-scraper` | `./backend/Dockerfile.scraper` | — | `python -m app.crm_worker`, the claim loop |
| `web` | `nginx:alpine` | 3600 → 80 | Serves built `frontend/dist` + proxies `/api` |
| `pgadmin` | `dpage/pgadmin4` | 5050 | DB admin UI |

**Named volumes** — `postgres_data`, `company_documents`, `frontend_node_modules`, `pgadmin_data`, `crm_session`, `crm_snapshots`.

> `docker compose down -v` **permanently destroys all six**, including the database and all uploaded documents. Back up `postgres_data` and `company_documents` together — they reference each other and a split restore leaves orphaned metadata.

The `crm_session` volume holds the CRM login cookie at `/data/crm-session/storage-state.json`. Remove it only when an authorised fresh login is intended.

## Backend module map (`backend/app/`)

| Module | Lines | Responsibility |
|---|---|---|
| `main.py` | ~2,541 | **All HTTP routes.** Inline Pydantic schemas at top, ~100 endpoints below. No router files, no service layer |
| `models.py` | 197 | All SQLAlchemy ORM models. `UUIDPK` and `Timestamps` mixins composed in |
| `core.py` | 44 | Pydantic `Settings` from `.env`. Every `CRM_*` value |
| `db.py` | — | Engine, `SessionLocal`, `get_db` FastAPI dependency |
| `auth.py` | 119 | Cookie sessions, PBKDF2-SHA256 (210k iters), `get_current_user`, `require_role` |
| `crm_connector.py` | — | `httpx` session manager, ASP.NET Web Forms postback helpers, host allowlist |
| `crm_parser.py` | 271 | Strict 17-column manifest parser. Raises rather than returning partial data |
| `crm_sync.py` | 118 | Reconciliation, ICRIS linking, provisional creation, alias management, upsert |
| `crm_worker.py` | 235 | `FOR UPDATE SKIP LOCKED` claim loop, lease recovery, cron scheduler |
| `crm_backfills.py` | — | Chunked date-range backfill orchestration |
| `company_imports.py` | 94 | Company-master `.xlsx` import (preview + commit) |
| `imports.py` | 77 | 26-column Excel manifest import — **currently unreachable**, see [05-imports.md](05-imports.md) |
| `utils.py` | 28 | `normalize_name`, `normalize_icris`, `clean`, `integer`, `decimal`, `jsonable` |
| `alerts_endpoint.py` | — | Alerts route module |
| `fast_crm_sync.py` | — | Auxiliary sync helper |

### Why `main.py` is one file

It is deliberate, not accidental — there are no router modules and no service layer. Endpoints call SQLAlchemy or raw `text()` SQL directly and return dicts built by the `serialize()` helper (`main.py:44`). When adding an endpoint, follow the surrounding style rather than introducing a router.

A consequence worth knowing: **many analytics endpoints use raw SQL strings**, not the ORM. Grep for `rows(db, """` to find them.

## Request paths

There are two different ways the frontend reaches the API, and they behave differently:

```
Dev (Vite :5173 or :5199)
  browser → vite dev server → proxy /api → http://localhost:8360 → FastAPI
                              (vite.config.ts:42-48)

Production-ish (nginx :3600)
  browser → nginx → serves frontend/dist  +  proxies /api → backend:8000
                    (nginx.conf)
```

**Vite *does* proxy `/api`** [verified] — `vite.config.ts:42-48` targets `process.env.BACKEND_URL || "http://localhost:8360"`. Older docs claim proxies are not used; that is false.

`api.ts` creates a single Axios client with `baseURL: '/api/v1'` and `withCredentials: true`, so the session cookie rides along on every request. Because both paths are same-origin, CORS is not normally exercised even though `main.py:24` configures it from `BACKEND_CORS_ORIGINS`.

## How a typical request flows

`GET /api/v1/companies?q=R11241` —

1. `main.py:113` `companies()` receives query params.
2. Builds a raw SQL string against the view `vw_company_operational_summary`, joined to `companies`.
3. Appends filters conditionally (`q` → `ILIKE`, `status` → provisional/official, etc.).
4. Executes, maps each row through `compute_inactivity()` (`main.py:82`) which derives `days_since_last_shipment` and an `inactivity_status` bucket in **Python, not SQL**.
5. Slices for pagination **after** materialising all rows (`main.py:154-160`).
6. Returns `{items, total, limit, offset}`.

Two things to note for anyone extending this: analytics live in **PostgreSQL views**, not Python (see [08-database.md](08-database.md)); but derived per-row status like inactivity is computed in Python afterwards, so it cannot be filtered in SQL — which is why `inactivity_status` filtering happens as a list comprehension at `main.py:156`.

## The CRM ingestion pipeline

```
CRM (ASP.NET Web Forms, http://192.168.101.3:8040)
   │  authenticated GET / postback   [read-only, never save/update/delete]
   ▼
crm_connector.CrmSessionManager     host allowlist · throttle · 1 auth retry · bounded retries
   ▼
crm_parser.parse_manifest_list  →  discovery: list rows → CrmSyncItem per manifest
crm_parser.parse_manifest_detail → strict 17-column parse, raises on drift
   ▼
crm_worker  claim loop            FOR UPDATE SKIP LOCKED · lease · backoff · quarantine
   ▼
crm_sync.upsert_detail            MasterAirWaybill + Shipment upsert, provenance, raw row archive
   ▼
crm_sync.link_icris               exact ICRIS → Company, else provisional, else icris_missing
   ▼
PostgreSQL  +  DataQualityIssue rows for every anomaly
```

Full detail in [04-crm-sync.md](04-crm-sync.md).

## Authentication flow

```
POST /api/v1/auth/login  →  verify PBKDF2 hash  →  Set-Cookie c360_session=<uuid>.<hmac>
GET  /api/v1/auth/me     →  get_current_user reads cookie, verifies HMAC, loads User
POST /api/v1/auth/logout →  deletes the client cookie only (no server-side revocation)
```

Frontend `AuthProvider` (`auth.tsx:26`) calls `/auth/me` on mount to restore the session after a refresh. This works [verified].

> **Critical:** `require_role` exists but is applied to **zero** routes, and the session secret defaults to a shipped literal. The API is effectively unauthenticated. See [10-known-issues.md](10-known-issues.md) before assuming any endpoint is protected.
