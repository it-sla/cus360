# Data Model

All models live in `backend/app/models.py`. Two mixins are composed into most tables:

```python
class UUIDPK:     id: uuid.UUID = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
class Timestamps: created_at, updated_at  # timezone-aware, updated_at has onupdate
```

Timestamps are **always timezone-aware** (`DateTime(timezone=True)`, `now()` returns UTC). Never introduce a naive datetime.

---

## The identity model — read this before touching anything

**ICRIS is the customer identity.** It is a string on `companies.icris_number`, unique, and compared case-insensitively after trimming. UUIDs are internal keys only and must never be shown to users as the customer identity or used to reconcile across sources.

```
ICRIS  ──1:1──  Company
                   │
                   ├──1:N──  CompanyAlias        (alternate name spellings)
                   ├──1:N──  CompanyDocument     (files on disk + metadata)
                   └──1:N──  Shipment            (= one air waybill)
                                 │
                                 ├──1:N──  Package        (Package Id ≠ Tracking No.)
                                 └──N:1──  MasterAirWaybill
```

Three distinct identifiers that are easy to confuse:

| Identifier | Column | Meaning |
|---|---|---|
| **ICRIS** | `companies.icris_number`, `shipments.source_icris_number` | The customer. Authoritative |
| **Tracking No.** | `shipments.shipment_number` | One air waybill. Unique. The CRM/Excel merge key |
| **Package Id** | `packages.package_id` | One physical piece. Unique. **Not** a tracking number |

A MAWB groups many air waybills operationally. It is **never** customer identity. A company has many shipments via `shipments.company_id`; a MAWB has many via `shipments.mawb_id`. These are independent relationships.

---

## Core entities

### `Company` — `companies`

The customer master.

| Field | Notes |
|---|---|
| `icris_number` | **unique, indexed.** The identity |
| `company_name` | Display name |
| `normalized_name` | `normalize_name()` output — indexed, used for alias/fuzzy comparison |
| `legal_name`, `phone`, `email`, `address`, `pan_vat_number`, `customer_type` | Profile fields. **Not populated by any import** — see [05-imports.md](05-imports.md) |
| `status` | `active` (default) or `archived`. `DELETE /companies/{id}` sets `archived`, it does not delete |
| `source` | `manual` · `upload` (company-master import) · `crm_scrape` (provisional) |
| `is_provisional` | `True` when auto-created by CRM sync from an unknown ICRIS |
| `name_source` | `manual` · `company_master` · `crm_manifest` |
| `manual_override_fields` | **JSONB list.** Field names a human edited. Imports and sync must respect this |
| `crm_customer_id`, `crm_last_synced_at` | CRM provenance |
| `last_company_import_at`, `last_company_import_batch_id` | Import provenance |

**Provisional companies** are created by CRM sync when a valid, unseen ICRIS appears on a manifest row (`crm_sync.py:39`). They are named `Provisional <ICRIS>` unless the manifest supplied a shipper name. A company-master import **promotes** them: `is_provisional = False` (`company_imports.py:75`). Live: 218 of 999 are provisional [verified].

### `Shipment` — `shipments`

One air waybill. The busiest table (56,085 rows).

| Group | Fields |
|---|---|
| Identity | `shipment_number` (**unique**), `company_id`, `mawb_id`, `manifest_batch_id` |
| Core | `shipment_date`, `pieces`, `shipment_weight`, `weight_unit` |
| Billing | `bill_type`, `billing_term`, `pay_term`, `bill_number`, `bill_amount`, `gross_amount`, `tariff_rate` |
| Value | `declared_value`, `value_currency`, `tnd_value` |
| Shipper | `shipper_name`, `shipper_address_1..3`, `shipper_postal_code`, `shipper_city`, `export_country` |
| Importer | `importer_name`, `importer_address_1..3`, `importer_postal_code`, `importer_city`, `import_country`, `importer_telephone` |
| CRM weights | `actual_weight`, `dimensional_weight` |
| Matching | `match_status`, `match_confidence`, `matched_by_method`, `manually_matched`, `is_manually_matched`, `name_mismatch` |
| Provenance | `source`, `source_icris_number`, `source_customer_name`, `crm_source_key`, `crm_source_url`, `crm_manifest_id`, `crm_manifest_direction`, `crm_parser_version`, `crm_last_synced_at` |
| Overrides | `manual_override_fields` (JSONB list), `crm_field_provenance` (JSONB dict) |
| Other | `ae_code`, `delivery_code`, `goods_description` |

**`match_status` values in live data** [verified]:

| Value | Count | Meaning |
|---|---|---|
| `matched` | 49,102 | Linked to a company via exact ICRIS |
| `invalid_icris` | 4,375 | ICRIS present but structurally invalid, no company |
| `icris_missing` | 2,608 | ICRIS blank on the manifest row. Valid shipment, unlinked |

Other values the code can produce: `manually_linked`, `unmatched`, `suggested`.

**`matched_by_method`**: `exact_icris` · `exact_company` · `exact_alias` · `suggested` · `manual` · `none`.

**Two manual flags exist** — `manually_matched` and `is_manually_matched`. Both are checked together everywhere (`crm_sync.py:31`, `:115`). Treat them as one concept; the duplication is historical.

**`crm_field_provenance`** records, per field, which CRM manifest last wrote it:
```json
{"bill_amount": {"source": "crm", "manifest_id": "12345", "updated_at": "2026-07-16T..."}}
```

### `Package` — `packages`

| Field | Notes |
|---|---|
| `package_id` | **unique.** Not a tracking number |
| `shipment_id` | FK, `ON DELETE CASCADE` |
| `piece_number`, `package_weight`, `weight_unit`, `package_type`, `description` |
| `length_cm`, `width_cm`, `height_cm`, `dimensional_weight`, `chargeable_weight` |
| `barcode`, `package_status`, `remarks` |

> `shipment_weight` is **shipment-level** and must never be copied into `package_weight`. They are different measurements.

Packages come only from the Excel manifest import, which is currently disabled — so there are effectively no packages in live data.

### `MasterAirWaybill` — `master_air_waybills`

Unique on `(mawb_number, manifest_date)`.

Header: `flight_number`, `origin`, `destination`, `exchange_rate`, `fuel_surcharge`.

**Payment-term totals, kept in nine separate columns:**

```
pp_weight  fc_weight  fd_weight
pp_pieces  fc_pieces  fd_pieces
pp_bill_amount  fc_bill_amount  fd_bill_amount
pp_gross_amount fc_gross_amount fd_gross_amount
```

PP / FC / FD are payment terms. **They are stored separately on purpose and must not be summed together** — see [03-data-rules.md](03-data-rules.md).

Provenance: `source_system`, `source_key`, `source_url`, `source_checksum`, `last_synced_at`, `manifest_direction`, `crm_manifest_id`, `parser_version`.

`source_checksum` drives change detection: if it matches and `parser_version` matches, `upsert_detail` short-circuits and marks the item `unchanged` (`crm_sync.py:79`).

### `CompanyAlias` — `company_aliases`

Unique on `(company_id, normalized_alias_name)`. `source` ∈ `manual` · `crm` · `company_master` · `manifest`.

Alternate spellings of a company name, used to resolve shipper names to companies.

> **Live data warning:** 4,775 aliases exist, 4,679 auto-created by CRM sync, with **1,870 on a single company**. `crm_sync._add_alias` inserts any shipper spelling that differs from the company's normalized name, with no cap or review. See [10-known-issues.md](10-known-issues.md) M-7.

### `CompanyDocument` — `company_documents`

Binaries live at `/data/company-documents/{company_uuid}/{document_uuid}-{safe_filename}`; metadata lives in Postgres.

- `checksum_sha256` — **deduplication**: an identical active file for the same company reuses the existing path instead of writing a second copy (`main.py:630`).
- `version_number` + `replaces_document_id` — replacement archives the old row and creates a new one, incrementing the version.
- `status` — `active` / `archived`. Deletion archives; **the file on disk is never removed**.
- Allowed extensions: `.pdf .doc .docx .xls .xlsx .csv .txt .png .jpg .jpeg`.
- PNG/JPEG are recompressed and capped at 2000px on upload (`main.py:588`).
- Only PDF and images can be previewed inline; everything else downloads.

---

## CRM sync entities

| Model | Table | Purpose |
|---|---|---|
| `CrmSyncRun` | `crm_sync_runs` | One sync operation. Status: `queued` → `discovering` → `running` → `completed` / `completed_with_errors` / `paused` / `interrupted` |
| `CrmSyncItem` | `crm_sync_items` | **One manifest.** The unit of work the worker claims. Unique on `(run_id, manifest_direction, crm_manifest_id)` |
| `CrmSyncState` | `crm_sync_state` | Key-value state by `entity_type`: `worker`, `manifest`, `watermark:<direction>`, `earliest:<direction>`, `auto_schedule` |
| `CrmBackfillRun` | `crm_backfill_runs` | A chunked historical backfill |
| `CrmBackfillChunk` | `crm_backfill_chunks` | One date range within a backfill |
| `CrmRawManifestHeader` | `crm_raw_manifest_headers` | Archived raw header values per manifest |
| `CrmRawManifestRow` | `crm_raw_manifest_rows` | Archived raw row values, **exact 17 source headers preserved** |

**`CrmSyncItem` status lifecycle:**

```
pending ─claim→ claimed → fetching → parsing → validating → importing → succeeded
   ↑                                                              └────→ succeeded_with_warnings
   └── retry_scheduled ←── (retryable failure, bounded backoff)
                       └── quarantined  (permanent failure or attempts exhausted)
```

Lease fields (`claimed_by`, `claimed_at`, `lease_expires_at`, `heartbeat_at`) support crash recovery — see [04-crm-sync.md](04-crm-sync.md).

> `crm_sync_state.entity_type` declares `unique=True` in the model but **has no unique index in the database**, and duplicate `worker` rows already exist [verified]. This is the only model/DB drift in the schema.

---

## Data quality

### `DataQualityIssue` — `data_quality_issues`

Links optionally to `company_id`, `shipment_id`, `mawb_id`, `sync_run_id`, `sync_item_id`. `status` ∈ `open` · `reviewed` · `acknowledged` · `resolved` · `ignored`.

**Live issue volume** [verified] — this is a real operational signal, not noise:

| Issue type | Open | Meaning |
|---|---|---|
| `crm_customer_name_mismatch` | **68,484** | Manifest shipper name ≠ official company name. ICRIS still wins and the link stands |
| `crm_invalid_icris` | 8,767 | ICRIS failed structural validation |
| `crm_blank_icris` | 2,740 | Manifest row had no ICRIS |
| `crm_manifest_total_mismatch` | 993 | Row totals ≠ manifest displayed PP/FC/FD totals |
| `crm_manifest_unavailable` | 26 | Detail page could not be fetched or had no manifest ID |
| `company_master_name_conflict` | 14 | Import supplied a name conflicting with a manual override |

Others the code emits: `crm_manual_link_preserved` (informational), `crm_numeric_parse_error`, `crm_discovery_identity_conflict`, plus parser error codes (`crm_header_mismatch`, `crm_partial_page`, `crm_empty_manifest`, `crm_duplicate_tracking_conflict`, `crm_session_expired`).

Issues are **deduplicated** — `crm_sync.issue()` (`:16`) looks for an existing open issue with the same type and entity refs and bumps `last_seen_at` rather than inserting a duplicate.

Resolving `crm_blank_icris` / `crm_invalid_icris` happens automatically when a later sync successfully links the shipment (`crm_sync.py:50`).

### `ActivityLog` — `activity_logs`

Generic audit trail: `entity_type`, `entity_id`, `action`, `description`, `source`, `metadata_json`. Written sparsely — notably **not** written by `merge_companies`.

---

## Import batch entities

| Model | Purpose |
|---|---|
| `CompanyImportBatch` / `CompanyImportRawRow` | Company-master import runs. Counters for created/updated/promoted/unchanged/conflict/rejected. Raw rows retained |
| `ManifestImportBatch` / `ManifestRawRow` | Excel manifest import. `file_hash` **unique** — prevents re-importing the same file. **0 rows live** (feature disabled) |

### `User` — `users`

`email` (unique), `display_name`, `role` (`admin` / `user`), `password_hash` (PBKDF2-SHA256, 210k iterations), `is_active`.

Seeded by migration `20260804_0010`:

| Email | Password | Role | UUID |
|---|---|---|---|
| `admin@gmail.com` | `admin123` | admin | `11111111-1111-1111-1111-111111111111` |
| `user@gmail.com` | `user123` | user | `22222222-2222-2222-2222-222222222222` |

These are development credentials with fixed UUIDs committed to the repo. They must be rotated before any real deployment — see [10-known-issues.md](10-known-issues.md) B-2.
