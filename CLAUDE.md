# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

**`docs/` is the full documentation.** This file is the short index; `docs/` has the detail and was written against verified behaviour on 2026-08-06.

| Read | When |
|---|---|
| [docs/README.md](docs/README.md) | Orientation, ground-truth data counts |
| [docs/03-data-rules.md](docs/03-data-rules.md) | **Before changing matching, imports, or sync** |
| [docs/10-known-issues.md](docs/10-known-issues.md) | **Before trusting any other doc** — records what is broken now |
| [docs/06-api-reference.md](docs/06-api-reference.md) | Adding or calling an endpoint |
| [docs/09-development.md](docs/09-development.md) | Commands, env vars, ports |

`README.md` and `AGENTS.md` at the repo root contain several claims that are **factually wrong** (documented in `docs/10-known-issues.md` M-8). Prefer `docs/`.

## What this project is

Customer 360 is an internal cargo customer directory for Shangrila Courier. It links ICRIS numbers to companies, air waybills, packages, documents, and analytics. **ICRIS is the authoritative, unique, case-insensitive, trimmed customer identity.** UUIDs are internal keys only. This is not a generic CRM.

## Commands

The stack currently runs in **local Docker**. Backend is on port **8360**, not 8000.

```bash
docker compose up --build
docker compose logs -f backend
docker compose down                    # safe — volumes preserved
```

> **Never run `docker compose down -v`** — it permanently destroys the database, all uploaded documents, the CRM session, and snapshots.

### Tests

```bash
docker exec customer360-backend-1 python -m pytest -q                        # 89 tests
docker exec customer360-backend-1 python -m pytest tests/test_crm_parser.py  # single file
docker exec customer360-backend-1 alembic current                            # vs `alembic heads`
```

### Frontend

```bash
cd frontend
npm run dev              # :5173 — proxies /api to localhost:8360
npm run lint             # oxlint — passes
npx tsc -b --noEmit      # type check
npm run build             # builds dist/ — fixed 2026-09-09, see docs/10-known-issues.md B-3
```

> **`npm run typecheck` does not exist.** It is cited in `README.md` and `AGENTS.md`; those are wrong. Use `npx tsc -b --noEmit`.

### Data-rule probe — run before and after touching sync/import/matching

```bash
docker exec -i customer360-backend-1 python - < qa/test_data_rules.py
```

Read-only, always rolled back. Baseline **17/17 passing** — any failure means an invariant is broken.

### KPI probe — run before and after touching analytics/dashboard SQL

```bash
docker exec -i customer360-backend-1 python - < qa/test_kpi_correctness.py
```

Read-side counterpart to the data-rule probe: pins dashboard KPI endpoints (revenue, ARPU, active customers, view reconciliation) against independent ground-truth SQL, plus tripwires that fail loudly if `declared_value`/`value_currency`/`weight_unit` ever go non-null (the currency/unit-mixing bugs in `docs/03-data-rules.md` rule 6 are latent only while those columns are NULL). Baseline **13/13 passing**.

### Remote server (secondary — not currently running the stack)

`./scripts/remote-compose.sh {init|dev|tunnel|ps|logs|exec|down}`. Note that `sync`/`dev`/`up` run `rsync --delete` against the remote — they deploy, so don't run them casually.

### URLs

Frontend (Vite) `:5173` · Frontend (nginx, built) `:3600` · API + docs `:8360/docs` · pgAdmin `:5050`
Login: `admin@gmail.com` / `admin123`, or `user@gmail.com` / `user123`.

## Architecture

### Backend (`backend/app/`)

FastAPI + SQLAlchemy 2 + Pydantic 2 + Alembic + PostgreSQL 16 (`psycopg` v3).

- **`main.py`** (~2,540 lines) — **all** HTTP routes. Inline Pydantic schemas at top, ~100 endpoints below. No router modules, no service layer. Many analytics endpoints use raw `text()` SQL.
- **`models.py`** — all ORM models. `Company`, `Shipment`, `Package`, `MasterAirWaybill`, `CompanyAlias`, `CompanyDocument`, `DataQualityIssue`, `CrmSyncRun`, `CrmSyncItem`, `User`. Mixins `UUIDPK` + `Timestamps`.
- **`core.py`** — Pydantic `Settings` from `.env`; all `CRM_*` values.
- **`auth.py`** — cookie sessions (`c360_session`), PBKDF2-SHA256 210k iterations, `get_current_user`, `require_role`.
- **`crm_connector.py`** — `httpx` + ASP.NET Web Forms postback helpers. **No Playwright or Chromium.**
- **`crm_parser.py`** — strict 17-column manifest parser. Column spellings `Icrisno` and `Tarriff Rate` are the source's — **do not correct them.**
- **`crm_sync.py`** — reconciliation, ICRIS linking, provisional creation, aliases.
- **`crm_worker.py`** — `FOR UPDATE SKIP LOCKED` claim loop; runs as the `crm-scraper` container.
- **`crm_backfills.py`** — chunked date-range backfills.
- **`company_imports.py`** — company-master **`.xlsx`-only** import (preview + commit).
- **`imports.py`** — 26-column Excel manifest import. **Currently unreachable — no route calls it.**
- **`utils.py`** — `normalize_name`, `normalize_icris`, `clean`, `jsonable`.

Analytics come from PostgreSQL views, not Python: `vw_company_operational_summary`, `vw_destination_summary`, `vw_manifest_import_quality`, `vw_company_document_summary`, plus three unreferenced ones (`vw_crm_sync_quality`, `vw_customer_name_quality`, `vw_mawb_reconciliation`).

### Frontend (`frontend/src/`)

React 19 + TypeScript 6 + Vite 8 + TanStack Query 5 + Axios + Tailwind CSS 4.

- **`App.tsx`** — all routes. Shell at `/app` (auth required). Public: `/`, `/login`.
- **`auth.tsx`** — `AuthProvider`, `useAuth()`. Calls `/auth/me` on mount to restore session.
- **`api.ts`** — Axios client (`/api/v1`, `withCredentials: true`) plus **all** types and fetch functions. No page bypasses it — keep it that way.
- **`pages/`** — one file per route. Seven are empty stubs (see `docs/07-frontend.md`).

**Vite proxies `/api` to `localhost:8360`** (`vite.config.ts:42`). Older docs claim proxies aren't used; that is false.

### Docker services

`db` (Postgres 16) · `backend` (Uvicorn `--reload`, 8360) · `frontend` (Vite, 5173) · `crm-scraper` (worker) · `web` (nginx + built dist, 3600) · `pgadmin` (5050).

Volumes: `postgres_data`, `company_documents`, `frontend_node_modules`, `pgadmin_data`, `crm_session`, `crm_snapshots`.

### Migrations

`backend/alembic/versions/`. Currently at head `20260804_0010`. Always `alembic upgrade head` after pulling. **Never hand-edit an existing migration.**

### Testing

11 test files in `backend/tests/`, 90 tests, all passing. CRM fixtures in `tests/fixtures/`. `conftest.py` builds a session-scoped `TestClient` and auto-creates the test DB when `TEST_DATABASE_URL` is set. **No frontend tests exist.**

## Key data rules

Full detail with enforcement points in [docs/03-data-rules.md](docs/03-data-rules.md).

- **ICRIS matching is exact**, case-insensitive, trimmed. Fuzzy name matching is suggestion-only and never auto-applied.
- **Manual company links are never overwritten** by CRM sync, Excel import, or rematching.
- **Manual field overrides** (`manual_override_fields`) must be respected by every automated writer, including `shipment_date` (`crm_sync.py:98`).
- **CRM and Excel merge only on exact trimmed tracking number.** Never fuzzy-match tracking numbers.
- **Blank cells never erase existing values.**
- **PP, FC, FD totals stay separate.** Never aggregate different currencies or weight units. CRM bill amounts have no assumed currency.
- **Provisional companies** are created by CRM sync for a valid new ICRIS; company-master import promotes them.
- **Deletion is archival** — `status='archived'`, files stay on disk. The one exception is `merge_companies`, which hard-deletes.
- **CRM integration is read-only.** Never invoke save/update/delete, expose credentials, or guess unverified URLs.
- **Source spellings are preserved exactly** — `Icrisno`, `Tarriff Rate`, `Importer Adresse 1/2/3`.

## ⚠️ Current state you must know

- **The API is effectively unauthenticated.** `require_role` is imported at `main.py:14` and applied to **zero** routes; only `GET /auth/me` is protected. `RequireAdmin` in the frontend hides UI but guards nothing.
- **Session tokens are forgeable** — `.env` sets no `AUTH_SECRET`, so the shipped default is live.
- **`npm run build` now works** (fixed 2026-09-09). It does not run automatically — rebuild and redeploy `frontend/dist` whenever frontend source changes should reach the `:3600` nginx service (`:5173` Vite dev always serves current source).
- Full list, ranked, with repro steps: [docs/10-known-issues.md](docs/10-known-issues.md) and [qa/BUGS.md](qa/BUGS.md).

## Environment

All configuration in `.env` (never committed); `.env.example` documents every key. `AUTH_SECRET` signs session tokens and **should be set** — it currently is not. Never commit `.env`, credentials, cookies, or `storage-state.json`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
