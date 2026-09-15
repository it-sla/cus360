# Customer 360 domain rules

- Customer 360 is a cargo customer directory, not a generic CRM. The primary relationship is ICRIS → company → air waybills/shipments → packages.
- ICRIS is the authoritative, unique, case-insensitive customer identity. UUIDs remain internal database keys.
- The CRM final manifest is the primary air-waybill source. Its `Tracking No.` equals `shipments.shipment_number`; its `Icrisno` equals `shipments.source_icris_number`.
- The operation Excel manifest remains supplemental and supplies Package Id records, grouping, addresses, descriptions, declared values, currency, and TND. Package Id is not Tracking No.
- MAWB is a parent operational grouping of many air waybills, not customer identity. A company has many air waybills through `shipments.company_id`; a MAWB has many through `shipments.mawb_id`.
- Merge CRM and Excel only by exact trimmed tracking identity. Never fuzzy-match tracking numbers or duplicate a shipment/packages during enrichment.
- Valid new CRM ICRIS values may create provisional companies. Repeated ICRIS values reuse the same company. Blank ICRIS shipments remain valid but unlinked with `icris_missing` status.
- ICRIS wins over source-name differences. Preserve source names, raise a quality issue, and never overwrite a non-provisional official name from a manifest row.
- Fuzzy name matching is suggestion-only. Manual links are never overwritten by CRM sync, Excel import, or rematching.
- One Shipment Number is one air waybill even when repeated across Excel package rows. Package Id is unique.
- Shipment Weight is shipment-level and must never be copied to package weight. Never invent dates, dimensions, IDs, currency, or other source data.
- Preserve all raw CRM rows with the exact 17 verified source headers, including spellings `Icrisno` and `Tarriff Rate`. Preserve all Excel import rows and its exact 26 headers. `TND` maps to `tnd_value` without inferred meaning.
- Keep PP, FC, and FD totals separate. Never aggregate different currencies or weight units together. CRM bill amounts without a currency stay labeled source bill amounts. Import timestamps are not shipment dates.
- CRM integration is read-only. Never invoke CRM save/update/delete actions, expose credentials/cookies, or guess unverified URLs/selectors. Runtime session state belongs in `/data/crm-session`, not the repository.
- Documents live beneath `/data/company-documents/{company_uuid}/` with UUID filenames; normal deletion archives metadata. Do not delete documents or unrelated data.
- Use transactions for imports/sync units, Alembic for schema changes, and timezone-aware timestamps.
- There is deliberately no Customer 360 authentication, login, JWT, session, user, role, permission, or SSO code in this phase.

## Stack and layout

- **Backend**: `backend/app/` — FastAPI, SQLAlchemy 2, Pydantic 2, Alembic, PostgreSQL 16 (`psycopg` v3). All routes live in `main.py` (~480 lines). Models in `models.py`. CRM logic spread across `crm_connector.py`, `crm_parser.py`, `crm_sync.py`, `crm_worker.py`, `crm_backfills.py`.
- **Frontend**: `frontend/src/` — React 19, TypeScript 5.8, Vite 6, TanStack Query 5, Axios, Recharts. The entire SPA (all pages and routes) is a single file `App.tsx`. Types and API client in `api.ts`. Five CSS files provide the design system.
- **Database**: PostgreSQL 16 via Docker. Six named volumes: `postgres_data`, `company_documents`, `frontend_node_modules`, `pgadmin_data`, `crm_session`, `crm_snapshots`.
- **CRM worker**: Separate container (`crm-scraper`) built from `Dockerfile.scraper`. Runs `python -m app.crm_worker` with `FOR UPDATE SKIP LOCKED` claim loop.
- **Remote dev** is the primary workflow. Docker runs on `shangrila002@100.94.204.57`, not the laptop. Use `./scripts/remote-compose.sh`.

## Developer commands

### Remote (primary)
```bash
./scripts/remote-compose.sh init          # one-time setup
./scripts/remote-compose.sh dev           # continuous rsync + compose up
./scripts/remote-compose.sh tunnel        # forward ports to laptop
./scripts/remote-compose.sh exec backend pytest
./scripts/remote-compose.sh exec frontend npx tsc -b --noEmit
./scripts/remote-compose.sh exec frontend npm run build   # rebuild + redeploy dist/ manually if :3600 nginx must reflect frontend changes
./scripts/remote-compose.sh exec backend alembic upgrade head
./scripts/remote-compose.sh down          # preserves volumes
```

### Local Docker
```bash
cp .env.example .env && docker compose up --build
docker compose exec backend pytest
docker compose exec frontend npx tsc -b --noEmit
docker compose exec backend alembic upgrade head
docker compose down -v   # ⚠️ destroys all volumes permanently
```

### Backend standalone (if DATABASE_URL points at accessible Postgres)
```bash
cd backend && pip install -r requirements.txt
alembic upgrade head
pytest
```

## Verification order

```
alembic upgrade head → pytest → npx tsc -b --noEmit → npm run build
```

## Testing

- 11 test files in `backend/tests/`. Fixtures in `tests/fixtures/` (8 HTML files for CRM parser tests).
- `conftest.py` creates a session-scoped `TestClient`. If `TEST_DATABASE_URL` is set, it creates the test DB and runs Alembic migrations automatically.
- `pytest.ini`: `pythonpath = .`, `testpaths = tests`. Run from `backend/`.
- No lint, formatter, or type-checking tools are configured for Python or TypeScript beyond `tsc -b --noEmit`. `npm run typecheck` does not exist as a script — use `npx tsc -b --noEmit` (see `docs/10-known-issues.md` B-4).
- No CI workflows, pre-commit hooks, or task runners exist.

## Key conventions

- **No Playwright/Chromium in the CRM connector.** The connector uses `httpx` with ASP.NET Web Forms postback helpers, not a browser.
- **`down -v` is destructive.** Never use `-v` unless permanent volume deletion is intended. Back up PostgreSQL and the document volume together.
- **The `rm_session` volume** stores CRM login state. Remove only when a fresh authorized login is needed.
- **Excel workbook headers are fixed.** The 26-column contract is in `backend/app/imports.py`. Do not invent or rename headers. The sample workbook at `samples/NP Manifest_ (004).xls` has no ICRIS column — its Shipper ID mapping is blocked until a corrected workbook is supplied.
- **CRM raw headers are fixed.** 17 columns including `Icrisno` and `Tarriff Rate` spellings. See `backend/app/crm_parser.py`.
- **All `CRM_*` env vars** are documented in `.env.example`. Never commit `.env`, credentials, cookies, or storage-state files.
- **Company master import** requires ICRIS Number + Company Name. `create_only` skips existing; `upsert_by_icris` updates only by ICRIS; blank cells never erase.
- **Rematch** is idempotent and preserves manual links. Exact ICRIS matching only; fuzzy is suggestion-only.
