# Development

> Every command here was run on 2026-08-06 and **works**, unless explicitly marked as broken. Older docs contain commands that do not exist — see the "Commands that do not work" section.

---

## Where the stack runs

**Currently: local Docker.** All six containers run on the development machine.

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

| Container | Port |
|---|---|
| `customer360-db-1` | 5432 |
| `customer360-backend-1` | **8360** → 8000 |
| `customer360-web-1` (nginx + built dist) | 3600 |
| `customer360-crm-scraper-1` | — |
| `customer360-pgadmin-1` | 5050 |
| `customer360-frontend-1` (Vite) | 5173 — often not running |

### URLs

| What | URL |
|---|---|
| Backend API | `http://localhost:8360/api/v1` |
| FastAPI docs | `http://localhost:8360/docs` |
| Frontend (built, nginx) | `http://localhost:3600` |
| Frontend (dev, Vite) | `http://localhost:5173` |
| pgAdmin | `http://localhost:5050` |

**Login:** `admin@gmail.com` / `admin123` (admin) · `user@gmail.com` / `user123` (standard).

> `docker-compose.yml` maps the backend to **8360**, not 8000. Older docs say `localhost:8000` — wrong for this setup.

---

## Local Docker

```bash
cp .env.example .env          # first time only
docker compose up --build
docker compose ps
docker compose logs -f backend
docker compose logs -f crm-scraper
docker compose down           # safe — volumes preserved
```

> **Never `docker compose down -v`.** It permanently destroys the database, all uploaded documents, the CRM session, and snapshots.

---

## Remote server (secondary)

Docker was historically intended to run on `shangrila002@100.94.204.57`.

```bash
./scripts/remote-compose.sh init      # one-time
./scripts/remote-compose.sh dev       # rsync + compose up  (terminal 1)
./scripts/remote-compose.sh tunnel    # port forwarding     (terminal 2)
./scripts/remote-compose.sh ps
./scripts/remote-compose.sh logs backend
./scripts/remote-compose.sh exec backend pytest
./scripts/remote-compose.sh down
```

> ⚠️ **`sync`, `dev`, and `up` all run `rsync -az --delete`**, which overwrites the remote tree with your local one and deletes remote-only files. It excludes `.env`, `node_modules/`, `dist/`, `crm-session/`, `crm-snapshots/`, and `storage-state.json`. Do not run these unless you intend to deploy.

As of 2026-08-06 the customer360 stack is **not running on the remote** — only unrelated `shangrila-marketing-tracker` and `ratecalculator` containers. Work locally.

---

## Tests

```bash
docker exec customer360-backend-1 python -m pytest -q          # all 89
docker exec customer360-backend-1 python -m pytest tests/test_crm_parser.py
docker exec customer360-backend-1 python -m pytest -k icris -v
```

Baseline: **89 passed** in ~8s.

From `backend/` standalone (needs an accessible Postgres):
```bash
cd backend && pip install -r requirements.txt
alembic upgrade head
pytest
```

`pytest.ini` sets `pythonpath = .` and `testpaths = tests`, so run from `backend/`. `conftest.py` creates a session-scoped `TestClient`; when `TEST_DATABASE_URL` is set it creates the test database and runs migrations automatically.

### Coverage shape

79% of the 89 tests cover CRM (reliability 38, parser 7, backfills 7, api 6, connector 5, settings 4, sync 3). The rest: company-master import 8, generic API 6, manifest 2, executive analytics 2, dossier 1.

**Nothing covers** auth, endpoint authorization, `merge_companies`, documents, or search. There are **no frontend tests at all**.

### Data-rule probe

Not part of pytest, but the fastest way to confirm you haven't broken an invariant:

```bash
docker exec -i customer360-backend-1 python - < qa/test_data_rules.py
docker exec -i customer360-backend-1 python - < qa/test_parser.py
```

Both run read-only inside a transaction that is always rolled back. Baseline **16/17**, with C-17 (`shipment_date` override) the known failure.

---

## Frontend

```bash
cd frontend
npm install
npm run dev                                # :5173
npm run dev -- --port 5199 --strictPort    # alternate port
npm run lint                               # oxlint — passes
npx tsc -b --noEmit                        # type check (see below)
npm run build                              # ⚠️ currently FAILS, exit 2
```

The dev server proxies `/api` → `http://localhost:8360` (`vite.config.ts:42`), so it works against the backend container with no extra configuration.

### Commands that do NOT work

| Command | Reality |
|---|---|
| `npm run typecheck` | **Script does not exist.** Use `npx tsc -b --noEmit` |
| `npm run build` | **Fails, exit 2, 165 TS errors.** No bundle produced |
| `docker compose exec frontend …` | Only if the frontend container is running — it usually isn't |

`npm run typecheck` is cited as a required verification step in `CLAUDE.md`, `AGENTS.md`, and `README.md`. All three are wrong.

---

## Verification order

```
alembic upgrade head  →  pytest  →  npx tsc -b --noEmit  →  npm run build
```

Steps 3 and 4 currently fail for pre-existing reasons. Compare error counts before and after your change rather than expecting zero:

```bash
cd frontend && npx tsc -b --noEmit 2>&1 | grep -c 'error TS'   # baseline: 165
```

---

## Database access

```bash
docker exec -it customer360-db-1 psql -U customer360 -d customer360
docker exec customer360-db-1 psql -U customer360 -d customer360 -c "SELECT count(*) FROM companies;"
docker exec customer360-backend-1 alembic current
```

---

## Environment variables

All config lives in `.env` (**never committed**). `.env.example` documents every key.

### Core

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://customer360:…@db:5432/customer360` | |
| `TEST_DATABASE_URL` | `…/customer360_test` | Enables auto test-DB creation |
| `AUTH_SECRET` | `customer360-dev-auth-secret` | ⚠️ **Not set in `.env` — the insecure default is live.** Falls back to `DATABASE_URL` if the attribute is missing |
| `BACKEND_CORS_ORIGINS` | `http://localhost:5173` | Comma-separated |
| `MAX_COMPANY_IMPORT_MB` | 25 | |
| `MAX_DOCUMENT_UPLOAD_MB` | 25 | |
| `DOCUMENT_STORAGE_ROOT` | `/data/company-documents` | |
| `POSTGRES_DB` / `_USER` / `_PASSWORD` | `customer360` | |
| `PGADMIN_DEFAULT_EMAIL` / `_PASSWORD` | | |

### CRM connector

| Variable | Default / current | Notes |
|---|---|---|
| `CRM_SCRAPER_ENABLED` | `true` | Master switch |
| `CRM_BASE_URL` | `http://192.168.101.3:8040/` | |
| `CRM_LOGIN_URL` | same host | |
| `CRM_EXPORT_MANIFEST_LIST_URL` | `…/Sales_WebForms/MenifestPreview.aspx` | |
| `CRM_EXPORT_MANIFEST_DETAIL_URL_TEMPLATE` | `…/S_MenifestPreview.aspx?ID={id}` | `{id}` placeholder required |
| `CRM_IMPORT_MANIFEST_LIST_URL` | `…/MenifestPreviewImport.aspx` | |
| `CRM_IMPORT_MANIFEST_DETAIL_URL_TEMPLATE` | `…/S_MenifestEditFormImport.aspx?ID={id}` | |
| `CRM_USERNAME` / `CRM_PASSWORD` | `SecretStr` | Environment-only, never persisted |
| `CRM_ALLOWED_HOSTS` | `192.168.101.3` | **Host allowlist — comma-separated** |
| `CRM_REQUEST_DELAY_MS` | 750 | Throttle |
| `CRM_CONNECT_TIMEOUT_MS` / `_READ_TIMEOUT_MS` | 10000 / 30000 | |
| `CRM_NAVIGATION_TIMEOUT_MS` | 30000 | |
| `CRM_SESSION_STORAGE_PATH` | `/data/crm-session/storage-state.json` | On the `crm_session` volume |
| `CRM_SNAPSHOT_STORAGE_PATH` | `/data/crm-snapshots` | |
| `CRM_SYNC_POLL_SECONDS` | 10 | Worker idle poll |
| `CRM_SYNC_MAX_CONCURRENCY` | 1 | |
| `CRM_SYNC_MAX_ATTEMPTS` | 5 | Before quarantine |
| `CRM_SYNC_LEASE_SECONDS` | 300 | Claim lease |
| `CRM_PARSER_VERSION` | `2.0.0` | Bump to force re-parse |
| `CRM_RECONCILIATION_WEIGHT_TOLERANCE` | 0.01 | |
| `CRM_DEFAULT_LOOKBACK_DAYS` | 7 | |
| `CRM_SCHEDULE_ENABLED` | `true` | |
| `CRM_SCHEDULE_CRON` | `"15 8,14 * * *"` | 08:15 and 14:15 **UTC** = 2:00 PM and 8:00 PM Nepal time (NPT, UTC+5:45). The matcher uses the container's OS clock (UTC), not NPT — always write this value in UTC. Quotes are stripped by dotenv |
| `CRM_RAW_SNAPSHOT_RETENTION_DAYS` | 30 | |
| `CRM_HEADLESS` | `true` | Vestigial — no browser is used |

**Never commit** `.env`, credentials, cookies, `storage-state.json`, or raw authenticated CRM pages.

---

## Conventions when editing

**Backend**
- All routes go in `main.py`. No router modules, no service layer.
- Inline Pydantic schemas at the top of `main.py`; endpoints below.
- Use the `serialize()` / `one()` / `commit()` helpers (`main.py:44-52`).
- Match the surrounding style — this codebase uses dense single-line statements with `;` separators. Do not reformat neighbouring code.
- Timestamps must be timezone-aware.
- Schema changes go through Alembic. Never hand-edit an existing migration.

**Frontend**
- All API calls go through `api.ts`. No page calls `apiClient` directly — keep it that way.
- Add the response type to `api.ts` alongside the fetch function.
- Query keys must include every filter that affects results.
- Use the `@/` alias for `src/`.

**Before changing matching, imports, or sync** — run `qa/test_data_rules.py` first and again afterwards. See [03-data-rules.md](03-data-rules.md).
