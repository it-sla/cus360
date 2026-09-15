# Customer 360 - AI Architecture & Domain Context

## 1. Executive Summary & Purpose

**Customer 360** is an internal customer directory and operational intelligence system designed to map and reconcile cargo operations with authoritative customer identities. It is **not** a generic CRM.

### Core Business Relationship
```
ICRIS Number (Authoritative Customer Identity)
    └── Company / Customer Record
          ├── Air Waybills / Shipments (Shipment Number / Tracking No.)
          │     └── Packages (Package Id - Unique Physical Items)
          └── Documents & Master Air Waybills (MAWB Operational Groupings)
```

- **ICRIS Number**: The unique, case-insensitive, authoritative customer identity string.
- **Company**: The customer entity. UUIDs are internal database keys; ICRIS is the primary business identifier.
- **Shipment / Air Waybill**: A single tracking record (`shipment_number`). Identified primary source is the CRM final manifest (`Tracking No.` + `Icrisno`).
- **Package**: Individual package item (`package_id`). Detailed in operational Excel manifests.
- **MAWB**: Parent operational grouping of multiple shipments. Does **not** represent customer identity.
- **Authentication**: There is deliberately **no** authentication, login, JWT, session, user, role, or SSO functionality in Customer 360 in this phase.

---

## 2. Technology Stack & Infrastructure

- **Backend**: Python 3.12+, FastAPI, SQLAlchemy 2 (async-compatible declarative ORM), Pydantic 2, Alembic (database migrations), PostgreSQL 16 with `psycopg` v3 driver.
  - Core entry point: `backend/app/main.py`
  - Models: `backend/app/models.py`
  - Sync & Connector: `backend/app/crm_connector.py`, `backend/app/crm_parser.py`, `backend/app/crm_sync.py`, `backend/app/crm_worker.py`, `backend/app/crm_backfills.py`
  - Imports: `backend/app/company_imports.py`, `backend/app/imports.py`
- **Frontend**: React 19, TypeScript 5.8, Vite 6, TanStack Query 5, Axios.
  - **CSS Framework**: Tailwind CSS v4.
  - **UI Library**: `shadcn/ui` (built on standard Radix UI primitives: `@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, etc.). Experimental `base-ui` has been phased out due to module resolution issues.
  - **Charts**: Apache ECharts (`echarts-for-react`). Note: Recharts has been completely removed to avoid dependency conflicts.
  - **Icons**: `lucide-react` (with custom mappings).
  - **Typography**: Geist Sans.
  - **Aesthetic Guidelines (Enterprise Standard)**: Datadog/Stripe inspired. Dense data grids, 1px borders, small border radius, subtle shadows, minimal spacing, and limited animations.
- **Containerization & Deployment**: Docker Compose with 6 named volumes (`postgres_data`, `company_documents`, `frontend_node_modules`, `pgadmin_data`, `crm_session`, `crm_snapshots`).
- **Development Workflow**: The backend and database run in Docker containers. The frontend is run locally on the host via `npm run dev` to bypass container volume caching issues with Vite and HMR.

---

## 3. Data Models & Database Schema

Defined in `backend/app/models.py`:

| Model Name | Table Name | Purpose & Key Fields |
| :--- | :--- | :--- |
| `Company` | `companies` | Authoritative customer record. Key fields: `icris_number` (unique, indexed), `company_name`, `normalized_name`, `legal_name`, `is_provisional`, `crm_customer_id`, `crm_last_synced_at`, `manual_override_fields`. |
| `CompanyAlias` | `company_aliases` | Alternate names linked to a company for matching. Unique constraint: `(company_id, normalized_alias_name)`. |
| `CompanyImportBatch` | `company_import_batches` | Metadata for bulk Company Master CSV/XLS imports. Tracks counts (valid, created, updated, skipped, failed, promoted, alias_added). |
| `CompanyImportRawRow` | `company_import_raw_rows` | Audit log of individual raw rows from company master imports. |
| `ManifestImportBatch` | `manifest_import_batches` | Metadata for bulk Excel Manifest imports. Tracks SHA-256 file hash, total rows, created/updated shipments, matched/unmatched counts. |
| `ManifestRawRow` | `manifest_raw_rows` | Audit trail of raw Excel manifest rows. |
| `Shipment` | `shipments` | Air waybill / Tracking record. Key fields: `shipment_number` (unique), `source_icris_number` (Shipper ID/ICRIS), `shipper_name`, `importer_name`, `pieces`, `shipment_weight`, `weight_unit`, `declared_value`, `value_currency`, `tnd_value`, `match_status` (`matched`, `suggested`, `unmatched`, `icris_missing`), `matched_by_method` (`exact_icris`, `exact_company`, `exact_alias`, `suggested`, `manual`, `none`), `company_id`, `mawb_id`, CRM financial/tariff fields (`bill_number`, `bill_amount`, `gross_amount`, `tariff_rate`, `pay_term`, `actual_weight`, `dimensional_weight`). |
| `MasterAirWaybill` | `master_air_waybills` | Operational parent flight manifest grouping. Unique constraint: `(mawb_number, manifest_date)`. Maintains separate financial/weight totals for PP, FC, and FD terms. |
| `Package` | `packages` | Physical package detail. Key fields: `package_id` (unique, indexed), `shipment_id` (FK), `package_weight`, `weight_unit`, `length_cm`, `width_cm`, `height_cm`, `dimensional_weight`, `chargeable_weight`. |
| `CompanyDocument` | `company_documents` | Document files stored under `/data/company-documents/{company_uuid}/` with UUID filenames. Preserves file on disk during soft/metadata deletion. |
| `CrmSyncRun` | `crm_sync_runs` | CRM sync execution run (type: range, single, update, backfill). Tracks status (`queued`, `running`, `completed`, `failed`), discovered manifests, created/updated records. |
| `CrmSyncItem` | `crm_sync_items` | Individual manifest item queued for scraper worker. Managed via status (`pending`, `claimed`, `succeeded`, `quarantined`, `retry_scheduled`) with lease timeouts and heartbeats. |
| `CrmSyncState` | `crm_sync_state` | High-watermark cursors tracking last successful date and sync run per entity type. |
| `CrmBackfillRun` | `crm_backfill_runs` | Multi-chunk historical CRM sync backfill run manager. |
| `CrmBackfillChunk` | `crm_backfill_chunks` | 7-day date range sub-task chunk of a backfill run. |
| `CrmRawManifestHeader` | `crm_raw_manifest_headers` | Raw audit copy of parsed CRM manifest headers. |
| `CrmRawManifestRow` | `crm_raw_manifest_rows` | Raw audit copy of 17 legacy CRM manifest headers and row values. |
| `DataQualityIssue` | `data_quality_issues` | Discrepancy tracker (e.g. ICRIS vs source name mismatch, missing ICRIS numbers, unlinked shipments). |
| `ActivityLog` | `activity_logs` | System change audit trail. |

---

## 4. Non-Negotiable Domain Rules & Business Invariants

1. **Authoritative Identity**: ICRIS is the authoritative, unique, case-insensitive customer identity key. Standard database UUIDs are internal system keys.
2. **CRM Manifest Primary**: The CRM final manifest is the primary air-waybill source. `Tracking No.` maps to `shipments.shipment_number`, and `Icrisno` maps to `shipments.source_icris_number`.
3. **Excel Manifest Supplemental**: Excel imports supply Package Id records, grouping, address details, descriptions, declared values, currency, and `TND` (mapped directly to `tnd_value`). `Package Id` is NOT `Tracking No.`.
4. **Strict Identity Matching**: Merge CRM and Excel manifests **only** by exact trimmed tracking identity (`shipment_number`). Never fuzzy-match tracking numbers or duplicate shipments/packages during enrichment.
5. **Customer Linking & Provisional Companies**:
   - Valid new CRM ICRIS values create provisional companies (`is_provisional = True`).
   - Repeated ICRIS values link to the existing company record.
   - Blank ICRIS shipments remain valid but unlinked (`match_status = icris_missing`).
   - ICRIS exact matching wins over source-name differences. If a manifest row has a different shipper name than the company master, preserve the source name, link by ICRIS, and log a `DataQualityIssue` (`name_mismatch`). Never overwrite an official non-provisional company name from a manifest row.
   - Fuzzy name matching is suggestion-only (`match_status = suggested`).
   - Manual links (`manually_matched = True`) are **never** overwritten by CRM sync, Excel imports, or rematch operations.
6. **Air Waybill Integrity**: One `Shipment Number` represents one air waybill, even when repeated across multiple Excel package rows. `Package Id` must remain unique.
7. **Weight & Currency Separation**:
   - `Shipment Weight` is shipment-level and must **never** be copied into package weight.
   - Keep PP (Prepaid), FC (Freight Collect), and FD (Free Domicile) totals strictly separate.
   - **Never** aggregate monetary values across different currencies or weights across different units.
   - Unspecified CRM bill amounts without currency stay labeled as source bill amounts.
   - Import timestamps do **not** represent shipment dates.
8. **Document Storage & Safety**: Documents live on disk beneath `/data/company-documents/{company_uuid}/` with UUID filenames. Deleting a document archives its database metadata; physical files are retained.
9. **CRM Scraper Safety**: CRM integration is strictly **read-only**. Never invoke CRM save/update/delete actions, expose credentials or cookies, or guess unverified selectors. Runtime session state lives in `/data/crm-session` outside the git repository.
10. **Data Mutations & Schemas**: All imports and multi-step mutations must run inside database transactions. Schema changes must be managed via Alembic migrations. All timestamps must be timezone-aware.

---

## 5. Ingestion, Matching & Synchronization Pipelines

### A. CRM Scraper & Sync Engine (`backend/app/crm_*.py`)
- **Session Management (`crm_connector.py`)**: Uses `httpx` with ASP.NET Web Forms postback state helpers (`__VIEWSTATE`, `__EVENTVALIDATION`). Manages login authentication without headless browsers.
- **Parsing (`crm_parser.py`)**: Parses strict HTML tables. Validates the **17 verified source headers**:
  `SN`, `Tracking No.`, `Bill Type`, `Icrisno`, `Shipper`, `Consignee`, `Dest.`, `Act wt`, `Pcs`, `Dim wt`, `Pay Term`, `Bill no.`, `Bill amt`, `Gross amt`, `Tarriff Rate`, `AE`, `Delivery`.
- **Worker (`crm_worker.py`)**: Runs continuous claim loops over `CrmSyncItem` using `FOR UPDATE SKIP LOCKED`. Handles attempts (up to max 5), lease expirations (10 min timeout), heartbeats (30s), exponential backoff, and error reporting.
- **Backfills (`crm_backfills.py`)**: Breaks large historical sync requests into sequential 7-day chunks (`CrmBackfillChunk`), managing lifecycle states (`draft`, `running`, `paused`, `completed`, `needs_attention`).

### B. Company Master Bulk Import (`backend/app/company_imports.py`)
- Supports `.csv`, `.xls`, and `.xlsx`.
- Requires `ICRIS Number` and `Company Name` columns.
- Modes:
  - `create_only`: Only imports new ICRIS records.
  - `upsert_by_icris`: Updates existing companies by exact ICRIS; existing non-blank fields are never overwritten with blank cells.
- Automatically handles alias creation, provisional status promotion, and duplicate grouping inside single import transactions.

### C. Operational Manifest Bulk Import (`backend/app/imports.py`)
- Expects exact **26 headers contract**:
  `Shipment Number`, `Package Id`, `Pieces`, `Shipment Weight`, `Weight Unit`, `Bill Type`, `Shipper_Name`, `Shipper Address1`, `Shipper Address2`, `Shipper Address3`, `Shipper Postal Code`, `Shipper City Name`, `Export Country`, `Importer Name`, `Importer Adresse 1`, `Importer Adresse 2`, `Importer Adresse 3`, `Importer Postal Code`, `Importer City Name`, `Import Country`, `Importer Telephone Number`, `Description`, `Billing Term Field`, `Declared Value`, `Value Currency`, `TND`.
- Maps `TND` to `tnd_value`.
- Groups rows by `Shipment Number` into a single `Shipment` record and creates corresponding child `Package` records.

### D. Matching & Rematching API
- `POST /api/v1/crm-sync/rematch`: Idempotent batch rematching across all unlinked shipments using exact ICRIS, then exact normalized company name, then alias matching.
- `POST /api/v1/manifest-imports/{batch_id}/rematch`: Batch-specific rematch operation that preserves existing manual links.

---

## 6. Frontend UI Architecture

### 6.1 Design Principles (Enterprise UI)
- **Compact & Dense**: The app relies heavily on standard Radix primitives styled with precise, dense Tailwind utility classes (`h-8`, `px-3`, `text-[10px]`, `text-xs`, `rounded-sm`, `rounded-md`).
- **Chart Performance**: `ReactECharts` (`echarts-for-react`) is used exclusively over Recharts to avoid `react-is` import resolution errors in Vite.
- **Core Components**:
  - `ExecutiveLayout.tsx`: The standard page wrapper ensuring correct max-widths and enterprise framing.
  - `KpiCard.tsx` / `AlertBanner.tsx`: Reusable micro-components for dashboards.
  - `shadcn/ui`: The component primitives live in `src/components/ui/*.tsx`.

### 6.2 Application Routing & Views
- **`App.tsx`**: Single-page application router and primary navigation context.
  - `/` (Executive Overview): High-level KPIs and business alerts using ECharts.
  - `/analytics` (Business Analytics): Interactive charting workspace (Revenue, Geo, Tiers, AEs).
  - `/customers` (Customer Directory): Paginated customer list with a compact filter sidebar (`w-[220px]`).
  - `/customers/:id` (Customer360): Deep dive tabbed interface for a single company entity.
  - `/awb` & `/mawb` (Operations): Listings for waybills.
  - `/matching`, `/quality`, `/sync` (Governance): Unmatched queues, backfill trackers, and issue logs.

---

## 7. Verification & Development Workflow

### Local vs Docker Execution
- **Backend**: Runs strictly via Docker Compose (`docker compose up -d backend`).
- **Frontend**: Best run natively using `npm run dev` in the `/frontend` directory to ensure fast HMR and circumvent Docker Node module syncing issues.

### Verification Suite
Execute verification in order:
```bash
# 1. Database Migrations
docker compose exec backend alembic upgrade head

# 2. Backend Unit & Integration Tests (11 test suites)
docker compose exec backend pytest

# 3. Frontend TypeScript Type-checking
cd frontend && npm run typecheck
```

---

## 8. Known Operational Quirks
- **Max Pagination Limit**: The backend `get_companies` API (`/api/v1/companies`) strictly enforces a maximum `limit` of 200 records via FastAPI's `Query(le=200)`. Do not request `limit: 1000` from the frontend to avoid HTTP 422 errors.
- **Vite Pre-bundling**: If adding/removing dependencies (like `echarts-for-react`), run `rm -rf node_modules/.vite` before restarting the dev server to prevent stale cache errors.
- **Sample Manifest Discrepancy**: The sample workbook at `samples/NP Manifest_ (004).xls` contains 26 exact headers but does **not** include an `ICRIS` or `Shipper ID` column. Operational Excel manifest imports map `Shipper_Name` to company name for fallback matching, while genuine primary customer linking relies on CRM final manifests containing `Icrisno`.
