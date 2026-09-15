# Customer 360

Customer 360 is an internal cargo customer directory linking ICRIS numbers to customer companies, air waybills, packages, documents, imports, matching review, and operational analytics. It is not a generic CRM and intentionally has no authentication in this phase.

## Start

### Remote server development (recommended)

Docker is intended to run on `shangrila002@100.94.204.57`, not on the development laptop. The helper synchronizes the source over SSH and runs every Docker Compose command on that server. The remote `.env`, database, documents, CRM session, and Docker volumes are never synchronized back to the laptop.

One-time setup:

```bash
./scripts/remote-compose.sh init
ssh shangrila002@100.94.204.57 'cd customer360-dev && nano .env'
./scripts/remote-compose.sh up
```

For development, use two terminals. The first keeps source changes synchronized so the existing Vite and Uvicorn reloaders see them; the second creates an SSH tunnel:

```bash
./scripts/remote-compose.sh dev
./scripts/remote-compose.sh tunnel
```

Then open the same local URLs listed below. Remote Compose binds all published ports to the server's `127.0.0.1`, so the unauthenticated Customer 360 application is not directly exposed on the server network.

Common remote commands:

```bash
./scripts/remote-compose.sh ps
./scripts/remote-compose.sh logs backend
./scripts/remote-compose.sh exec backend pytest
./scripts/remote-compose.sh exec frontend npx tsc -b --noEmit
./scripts/remote-compose.sh down
```

Override the SSH destination or remote directory when needed:

```bash
CUSTOMER360_REMOTE_HOST=user@server CUSTOMER360_REMOTE_DIR=apps/customer360 \
  ./scripts/remote-compose.sh up
```

Do not add `-v` to `down` unless permanent deletion of the server-side data is explicitly intended.

### Local Docker (optional)

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: http://localhost:5173
- FastAPI docs: http://localhost:8000/docs
- pgAdmin: http://localhost:5050

Connect pgAdmin to host `db`, port `5432`, database and username `customer360`, using the password in `.env`.

Useful commands:

```bash
docker compose config
docker compose ps
docker compose logs -f backend
docker compose logs -f frontend
docker compose exec backend alembic current
docker compose exec backend pytest
docker compose exec frontend npx tsc -b --noEmit
docker compose exec frontend npm run build   # builds dist/ served by :3600 nginx — rebuild after frontend changes, it does not auto-rebuild
docker compose down
docker compose down -v
```

`docker compose down -v` permanently deletes the declared PostgreSQL, pgAdmin, frontend `node_modules`, and company-document volumes. Back up both PostgreSQL and the document volume together.

## Import rules

Excel operation-manifest upload is disabled in both the web application and API. CRM Export sync is the active air-waybill ingestion workflow. Existing supplemental Excel records and schema are retained so historical package and shipment data is not destroyed.

Company-master import accepts `.xls`, `.xlsx`, and `.csv`, previews headers, supports explicit mapping, and requires ICRIS Number plus Company Name. `create_only` skips existing ICRIS values; `upsert_by_icris` updates only by ICRIS and blank cells never erase existing values.

Matching runs against `Shipper_Name`: exact normalized official names and aliases may link automatically; fuzzy results are suggestions only. Staff resolve suggestions in Matching Review and can save a shipper spelling as an alias. Manual matches are protected from later imports.

## Documents and analytics

Document metadata is in PostgreSQL; binaries are stored at `/data/company-documents/{company_uuid}/{document_uuid}-{safe_filename}`. PDF/images can be previewed, other types downloaded, replacement creates a new version, and archive does not destroy the file.

Analytics use operational database values and PostgreSQL views. Currency values are grouped by currency and weights by unit. Unknown shipment dates remain unknown; imported timestamps are only used for explicitly import-based reporting.

## Read-only legacy CRM connector

The CRM final manifest is the primary air-waybill feed. Synchronization has two stages: a run discovers list rows into independent `crm_sync_items`, then the worker leases and processes each manifest separately with `FOR UPDATE SKIP LOCKED`. Each validated manifest is committed in its own transaction. Temporary failures use bounded backoff, permanent structure failures are quarantined, expired leases recover automatically, and successful items remain complete when another item fails.

The lightweight connector uses `httpx` connection pooling, an in-memory cookie session, strict host allowlisting, one authentication renewal attempt, bounded network retries, request throttling, and ASP.NET Web Forms hidden-field/postback helpers. Chromium and Playwright are not installed. No public scraper port is exposed. Credentials are environment-only and are never persisted to PostgreSQL or returned by an API.

Configure the `CRM_*` values documented in `.env.example`. At minimum the enabled connector requires verified base, login, manifest-list URLs, an allowed-host list, and service credentials. Never commit `.env`, credentials, cookies, storage-state files, or raw authenticated pages.

Queue a verified CRM Export detail record from the CRM Sync page at `/crm-sync` or manually. Dry run fetches, parses, validates, matches, and reconciles without writing business tables:

```bash
curl -X POST 'http://localhost:8000/api/v1/crm-sync/export/12345?dry_run=true'
curl -X POST http://localhost:8000/api/v1/crm-sync/manifests \
  -H 'Content-Type: application/json' \
  -d '{"direction":"export","date_from":"2026-07-16","date_to":"2026-07-16","dry_run":true,"maximum_manifests":25}'
curl http://localhost:8000/api/v1/crm-sync/runs
```

Only the verified numeric Export detail-record workflow is enabled. Date-range and MAWB discovery remain unavailable until their CRM postback behavior is verified.

The supplied application includes strict parsers and sanitized Web Forms fixtures. Export detail navigation is a normal authenticated `S_MenifestPreview.aspx?ID=…` GET. Import detail navigation is a normal authenticated `S_MenifestPreviewImport.aspx?ID=…` GET. Date-range postback controls must still be handled through current hidden fields rather than guessed URLs.

If login expires, inspect scraper logs, remove only the `crm_session` volume when an authorized fresh login is intended, and retry the failed run. If CRM HTML changes, the parser raises a structure-change failure and Data Quality records should be reviewed; it never silently treats a changed table as an empty result.

## MAWB and source precedence

A MAWB groups many air waybills operationally and is never the customer identity. `/mawbs` shows header data, separated PP/FC/FD totals, linked shipments, customer counts, missing ICRIS, and reconciliation values.

CRM owns ICRIS, MAWB/flight, actual/dimensional weights, CRM bill fields, and final-manifest shipment snapshots. Excel owns package IDs/grouping and its address, description, declared-value/currency, and TND fields. Both merge into one shipment only when trimmed tracking numbers match exactly. Blank incoming fields do not clear data from the other source, manual links are protected, and conflicts remain visible in raw records/data-quality issues.

CRM bill amounts have no assumed currency and are excluded from declared-value currency totals. Weight and currency aggregations remain separated by their source units/currencies.

## Data quality and backups

`/data-quality` contains missing ICRIS, name mismatch, reconciliation, missing-source-record, package-count, invalid-value, and structure-change queues. Issues can be reviewed, resolved, or ignored with a reason; exact-ICRIS rematching is idempotent.

Back up PostgreSQL together with `company_documents`, `crm_session`, and (if retained) `crm_snapshots`. Never use `docker compose down -v` unless permanent removal of all declared volumes is explicitly intended.

## Architecture

FastAPI, SQLAlchemy 2, Pydantic 2, Alembic, PostgreSQL 16, Playwright, Beautiful Soup, React/TypeScript/Vite, TanStack Query, Axios, Docker Compose, and pgAdmin. The frontend calls live APIs and no demonstration records are seeded. Customer 360 itself intentionally has no authentication in this phase.
