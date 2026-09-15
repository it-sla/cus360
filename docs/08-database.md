# Database

PostgreSQL 16, driver `psycopg` v3. Connection string in `DATABASE_URL`:

```
postgresql+psycopg://customer360:<password>@db:5432/customer360
```

---

## Migrations

Alembic, files in `backend/alembic/versions/`. The `backend` container runs `alembic upgrade head` on every start (`docker-compose.yml:25`), so schema is applied automatically.

| Revision | File | What it added |
|---|---|---|
| `20260714_0001` | `initial.py` | Core schema — companies, shipments, packages, documents, MAWBs |
| `20260715_0002` | `crm_connector.py` | CRM sync runs, raw manifest archive |
| `20260716_0003` | `crm_reliability.py` | `crm_sync_items`, leases, retry/quarantine |
| `20260716_0004` | `field_provenance.py` | `crm_field_provenance`, `manual_override_fields` |
| `20260716_0005` | `company_master_import.py` | Company import batches + raw rows |
| `20260716_0006` | `repeat_company_imports.py` | Repeatable imports, promotion counters |
| `20260716_0007` | `unique_normalized_icris.py` | Unique constraint on normalised ICRIS |
| `20260716_0008` | `crm_backfills.py` | Backfill runs and chunks |
| `20260802_0009` | `pg_trgm.py` | `pg_trgm` extension for text search |
| `20260804_0010` | `auth_users.py` | `users` table + seeded admin/user accounts |

**Current: `20260804_0010` = head, no pending migrations** [verified].

```bash
docker exec customer360-backend-1 alembic current
docker exec customer360-backend-1 alembic heads
docker exec customer360-backend-1 alembic upgrade head
```

### Rules

- **Never hand-edit an existing migration.** Add a new revision.
- Always run `alembic upgrade head` after pulling schema changes.
- `20260804_0010` imports `hash_password` from `app.auth` — migrations may import application code, so keep that import surface stable.

---

## Views

Analytics are computed in **PostgreSQL views**, not Python. Seven exist; `CLAUDE.md` mentions only four.

| View | Rows | Used by |
|---|---|---|
| `vw_company_operational_summary` | 999 | `/companies`, `/companies/{id}`, `/analytics/customers`, dashboard |
| `vw_destination_summary` | 150 | `/analytics/destinations` |
| `vw_company_document_summary` | 999 | `/analytics/document-completeness` |
| `vw_manifest_import_quality` | **0** | `/analytics/import-quality` |
| `vw_crm_sync_quality` | — | not referenced in `main.py` |
| `vw_customer_name_quality` | — | not referenced in `main.py` |
| `vw_mawb_reconciliation` | — | not referenced in `main.py` |

`vw_manifest_import_quality` is empty because `manifest_import_batches` has 0 rows — the Excel import is disabled. Correct behaviour, but any UI surfacing it will always look broken.

### Accuracy [verified 2026-08-06]

Both views that carry business totals were cross-checked against ground-truth SQL:

```
vw_company_operational_summary : 0 shipment_count mismatches, 0 package_count
                                 mismatches across all 999 rows
vw_destination_summary         : 150 rows = 150 distinct import_country values
                                 sum(shipment_count) = 56,085 = COUNT(*) FROM shipments
```

Both reconcile exactly. If you change a view, re-run this check:

```sql
WITH truth AS (
  SELECT c.id, count(DISTINCT s.id) ship, count(DISTINCT p.id) pkg
  FROM companies c
  LEFT JOIN shipments s ON s.company_id = c.id
  LEFT JOIN packages p ON p.shipment_id = s.id
  GROUP BY c.id)
SELECT count(*) FILTER (WHERE v.shipment_count <> t.ship) AS ship_mismatch,
       count(*) FILTER (WHERE v.package_count  <> t.pkg)  AS pkg_mismatch
FROM vw_company_operational_summary v JOIN truth t ON t.id = v.company_id;
```

---

## Key constraints

| Table | Constraint |
|---|---|
| `companies` | `icris_number` unique + indexed |
| `shipments` | `shipment_number` unique + indexed |
| `packages` | `package_id` unique + indexed |
| `master_air_waybills` | `(mawb_number, manifest_date)` unique |
| `company_aliases` | `(company_id, normalized_alias_name)` unique |
| `crm_sync_items` | `(run_id, manifest_direction, crm_manifest_id)` unique |
| `crm_backfill_chunks` | `(backfill_id, direction, date_from, date_to)` unique |
| `manifest_import_batches` | `file_hash` unique |
| `company_documents` | `stored_file_name`, `relative_storage_path` unique |
| `users` | `email` unique |

**Cascades:** `company_aliases`, `packages`, `crm_sync_items`, `company_import_raw_rows`, `manifest_raw_rows` all `ON DELETE CASCADE` from their parent. `shipments.company_id` does **not** cascade — archiving a company leaves its shipments intact.

### ⚠️ One schema drift

`models.py:159` declares `crm_sync_state.entity_type` as `unique=True`, but **no unique index exists in the database**, and duplicate `entity_type='worker'` rows are already present [verified].

`heartbeat()` and `watermark_state()` both resolve state with `db.scalar(select(...).where(entity_type == …))`, which silently returns an arbitrary row when duplicates exist. If a `watermark:<direction>` row ever duplicates, incremental sync could read the wrong high-water mark.

A full model-vs-database diff found **no other drift**. To re-run it:

```bash
docker exec customer360-backend-1 python -c "
from sqlalchemy import create_engine, inspect
from app.models import Base
from app.core import settings
insp = inspect(create_engine(settings.database_url))
for tname, tbl in sorted(Base.metadata.tables.items()):
    dbcols = {c['name'] for c in insp.get_columns(tname)}
    for c in tbl.columns:
        if c.name not in dbcols: print(f'MISSING COL: {tname}.{c.name}')
    dbuniq = {tuple(sorted(u['column_names'])) for u in insp.get_unique_constraints(tname)}
    dbuniq |= {tuple(sorted(ix['column_names'])) for ix in insp.get_indexes(tname) if ix.get('unique')}
    for c in tbl.columns:
        if c.unique and (c.name,) not in dbuniq:
            print(f'UNIQUE NOT ENFORCED: {tname}.{c.name}')
"
```

Fixing it needs a dedup step before adding the constraint — there are already duplicate rows.

---

## Live row counts [verified 2026-08-06]

| Table | Rows |
|---|---|
| `companies` | 999 (781 official, 218 provisional) |
| `shipments` | 56,085 (all `source='crm'`) |
| `company_aliases` | 4,775 (4,679 crm / 75 manual / 21 company_master) |
| `data_quality_issues` | ~81,000 open |
| `company_documents` | 2 |
| `manifest_import_batches` | 0 |
| `company_import_batches` | 3 |
| `packages` | effectively 0 (only the Excel import creates them) |

---

## Backup and restore

Helpers in `scripts/`: `backup.sh`, `restore.sh`, `restore.ps1`, `export_standalone.sh`.

```bash
./scripts/backup.sh
```

> **Back up `postgres_data` and `company_documents` together.** Document metadata lives in Postgres and binaries live on the volume; restoring one without the other leaves orphaned rows or unreferenced files. If `crm_snapshots` is retained, include it too.

> **`docker compose down -v` permanently destroys every declared volume** — database, documents, CRM session, snapshots, pgAdmin config. Use plain `down` unless deletion is explicitly intended.

`POST /api/v1/admin/backup` and `GET /api/v1/admin/backups/{filename}/download` exist as API endpoints, and are **currently unauthenticated**.

---

## Direct access

```bash
docker exec -it customer360-db-1 psql -U customer360 -d customer360
docker exec customer360-db-1 psql -U customer360 -d customer360 -c "SELECT count(*) FROM companies;"
```

pgAdmin at `http://localhost:5050` — connect to host `db`, port `5432`, database and user `customer360`, password from `.env`.

`TEST_DATABASE_URL` points at `customer360_test`; `conftest.py` creates it and runs migrations automatically when the variable is set.
