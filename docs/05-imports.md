# Imports

Two import paths exist. **Only one is reachable.**

| Import | Module | Status |
|---|---|---|
| Company master (ICRIS + names) | `company_imports.py` | **Live** — `POST /api/v1/company-imports` |
| Excel operation manifest (26 columns) | `imports.py` | **Disabled** — no route exists |

---

## 1. Company-master import — LIVE

Supplies the authoritative ICRIS → company-name mapping and promotes provisional companies.

### File format

**`.xlsx` only.** [verified] Enforced twice — `company_imports.py:32` and `main.py:552`.

> Older docs claim `.xls` and `.csv` are accepted. **They are not**; both are rejected with HTTP 415.

- Default worksheet: `BASE SHEET`
- Worksheet named `PIVOT TABLE` is explicitly refused as a source
- Size cap: `MAX_COMPANY_IMPORT_MB` (25 MB)

### Column mapping

Only **two** columns are read:

| Mapping key | Auto-detected from | Required |
|---|---|---|
| `ICRIS Number` | a header named `Account Number` or `ICRIS Number` | yes |
| `Company Name` | a header named `Company Name` | yes |

Both must resolve or the upload fails with *"Account Number and Company Name columns must be mapped"*. A client-supplied `mapping_json` overrides auto-detection.

> **Nothing else is imported.** `phone`, `email`, `address`, `pan_vat_number`, `customer_type`, `legal_name` are never touched by this import, regardless of what columns the workbook contains. Those fields are manual-entry only.

### Two-step flow

```bash
# 1. Preview — parses, analyses, writes nothing
curl -X POST http://localhost:8360/api/v1/company-imports/preview \
  -F 'file=@companies.xlsx' -F 'worksheet=BASE SHEET'

# 2. Commit — requires explicit mapping_json
curl -X POST http://localhost:8360/api/v1/company-imports \
  -F 'file=@companies.xlsx' \
  -F 'mapping_json={"ICRIS Number":"Account Number","Company Name":"Company Name"}'
```

Preview returns headers, suggested mapping, available worksheets, and counts: `total_source_rows`, `valid_rows`, `blank_icris_count`, `blank_company_name_count`, `unique_normalized_icris_count`, `duplicate_icris_group_count`, `new_companies`, `existing_companies`, `provisional_companies_to_promote`, `unchanged_companies`, `name_conflict_count`, `invalid_row_count`, plus `duplicate_groups`, `name_conflicts`, `invalid_rows`, and 10 preview rows.

### Commit semantics

Rows are grouped by normalised ICRIS; the **first** name in a group is primary.

| Case | Behaviour |
|---|---|
| ICRIS not seen before | Create `Company` — `source='upload'`, `name_source='company_master'`, `is_provisional=False` → `created_count` |
| Existing, provisional | `is_provisional = False` → `promoted_count` |
| Existing, name differs, **no manual override** | Update `company_name` + `normalized_name` → `updated_count` |
| Existing, name differs, **`company_name` in `manual_override_fields`** | **Name left alone**, `conflict_count++`, raises `company_master_name_conflict` |
| Existing, name matches | `unchanged_count` |
| Blank ICRIS or blank name | Rejected, row archived with `processing_status='rejected'` |

**Aliases:** every distinct name in a group that differs from the final company name is added as a `company_master` alias, including the *previous* name when it changes (`:79`). Nothing is lost.

**Batch status:** `completed_with_conflicts` if any conflict, else `completed_with_errors` if any rejection, else `completed`.

**Transactional:** the whole import is one transaction — `main.py:571-577` rolls back on any exception.

### There are no import modes

> `create_only` and `upsert_by_icris` appear in `README.md` and `AGENTS.md` but **exist nowhere in the backend** [verified]. There is no mode parameter. The behaviour is always: upsert by ICRIS, respecting manual overrides, never erasing.

### Live history [verified]

```
ICRIS List (Updated).xlsx  800 rows  →  773 created, 7 updated  (2026-07-16)
  + two later re-runs, both 0/0, status completed_with_conflicts
```
781 official companies today, 218 provisional awaiting promotion.

### Raw row retention

Every source row is archived in `company_import_raw_rows` with `raw_data_json` and a `processing_status` of `created` / `promoted` / `updated` / `unchanged` / `rejected`.

---

## 2. Excel manifest import — DISABLED

`imports.py` implements a complete 26-column contract, but **no API route calls it** [verified]. Only `read_file` is imported into `main.py:16`, and even that is unused. `ManifestImports.tsx` makes zero API calls. `manifest_import_batches` has 0 rows.

This matches `README.md`: *"Excel operation-manifest upload is disabled in both the web application and API. Existing supplemental Excel records and schema are retained so historical package and shipment data is not destroyed."*

### The 26-column contract

```python
MANIFEST_HEADERS = [
  "Shipment Number", "Package Id", "Pieces", "Shipment Weight", "Weight Unit", "Bill Type",
  "Shipper_Name", "Shipper Address1", "Shipper Address2", "Shipper Address3",
  "Shipper Postal Code", "Shipper City Name", "Export Country",
  "Importer Name", "Importer Adresse 1", "Importer Adresse 2", "Importer Adresse 3",
  "Importer Postal Code", "Importer City Name", "Import Country",
  "Importer Telephone Number", "Description", "Billing Term Field",
  "Declared Value", "Value Currency", "TND"]
```

`Importer Adresse 1/2/3` is the **source's** misspelling. Preserve it. `Shipper_Name` uses an underscore. 24 of the 26 map to shipment fields; `Shipment Number` and `Package Id` are identity columns.

Accepts `.xls` (via `xlrd`), `.xlsx` (`openpyxl`), `.csv`. Excel defaults to worksheet `Query2`. Missing headers → hard failure listing them.

### What it would do

- **Deduplication:** `file_hash` is unique — the same file cannot be imported twice unless `allow_duplicate=True`.
- **Grouping:** rows group by `Shipment Number`; one air waybill can span many package rows. Field values take the **first non-null** across the group.
- **Mode:** `skip_existing` (default) skips shipments that already exist.
- **Blank cells never erase** (`:61`).
- **Manual links protected** (`:63`).
- **Fuzzy is suggestion-only** — exact company name → `matched`; exact alias → `matched`; `rapidfuzz` ≥70 → `suggested` with `company_id` left NULL.
- **Package/pieces reconciliation:** if `Pieces` ≠ the count of distinct Package Ids, every row in the group gets a warning.

### Two problems if it is ever re-enabled

1. **It can null a CRM-derived company link.** `imports.py:63`:
   ```python
   if not shipment.manually_matched:
       shipment.company_id = company.id if status == 'matched' else None
   ```
   An existing shipment linked by CRM exact-ICRIS matching, re-imported with a shipper name that doesn't match a company, has its `company_id` **set to NULL**. Only `manually_matched` is checked — ICRIS provenance is not. This contradicts the source-precedence rule that CRM owns ICRIS.

2. **It does not scale.** `match_company` (`:27,29`) loads *every* company and *every* alias on each call — currently 999 + 4,775 rows, per shipment group.

Both are latent. Fix before re-enabling.

---

## 3. Document upload — related but separate

Not a bulk import, but the third way files enter the system.

```
POST /api/v1/companies/{company_id}/documents
```

- Extensions: `.pdf .doc .docx .xls .xlsx .csv .txt .png .jpg .jpeg`
- Size cap `MAX_DOCUMENT_UPLOAD_MB` (25 MB)
- Categories: `company_registration`, `pan_vat`, `kyc`, `contract`, `rate_sheet`, `invoice`, `correspondence`, `operations`, `other`
- **SHA-256 dedup** — an identical active file for the same company reuses the stored path and is tagged `deduplicated`
- **Images optimised** — EXIF-transposed, capped at 2000px, JPEG q85 / PNG optimised, kept only if smaller
- **Path traversal guarded** — the resolved path must sit under `DOCUMENT_STORAGE_ROOT` (`main.py:641`)
- Stored at `/data/company-documents/{company_uuid}/{document_uuid}-{safe_filename}`
- Replacement archives the old row, increments `version_number`, sets `replaces_document_id`
- **Deletion archives metadata; the file on disk is never removed**

Back up the `company_documents` volume together with `postgres_data` — a split restore leaves orphaned metadata or unreferenced files.
