# Customer 360 — Documentation

Reference documentation for the Customer 360 cargo customer directory.

**Written 2026-08-06** against the live local stack (999 companies, 56,085 shipments) and a full read of the backend and frontend source. Facts marked **[verified]** were tested against the running system, not inferred from code or older docs.

> **Read this first if you are an AI assistant resuming work.** `CLAUDE.md` at the repo root is the short index that loads automatically. This folder is the long form. Where the two disagree, this folder is newer. Where either disagrees with **`docs/10-known-issues.md`**, that file wins — it records things that are broken right now.

---

## Contents

| File | What's in it |
|---|---|
| [01-architecture.md](01-architecture.md) | Services, request paths, module map, how a request actually flows |
| [02-data-model.md](02-data-model.md) | Entities, ICRIS identity model, relationships, provenance tracking |
| [03-data-rules.md](03-data-rules.md) | **The invariants**, where each is enforced in code, and where each is currently violated |
| [04-crm-sync.md](04-crm-sync.md) | Connector, parser, sync engine, worker claim loop, backfills |
| [05-imports.md](05-imports.md) | Company-master import (live) and Excel manifest import (disabled) |
| [06-api-reference.md](06-api-reference.md) | All 87 routes, grouped, with auth status |
| [07-frontend.md](07-frontend.md) | Routes, page inventory, which pages are real vs stubs, api.ts |
| [08-database.md](08-database.md) | Migrations, views, indexes, live row counts |
| [09-development.md](09-development.md) | Commands **that actually work**, environment variables, ports |
| [10-known-issues.md](10-known-issues.md) | Current defects, ranked. Read before trusting anything else |
| [11-customer-segmentation.md](11-customer-segmentation.md) | The Key Account/Reseller/Large Account/SME/Small Customer rule, why it can't demote, and the tier shipping-gap alert |

---

## The one-paragraph version

Customer 360 is an internal cargo customer directory for Shangrila Courier. **ICRIS is the authoritative customer identity** — a unique, case-insensitive, trimmed string that links a company to its air waybills, packages, documents, and analytics. UUIDs are internal database keys and are never the customer identity. Air waybill data flows in from a legacy ASP.NET Web Forms CRM via a read-only `httpx` connector that parses a strict 17-column manifest table. A company-master `.xlsx` import supplies the authoritative company names. The two are reconciled on exact ICRIS. Analytics are served from PostgreSQL views. It is not a generic CRM, and no part of it should be treated as one.

---

## Ground truth as of 2026-08-06 **[verified]**

| Metric | Value |
|---|---|
| Companies | 999 — 781 official (from company-master import) + 218 provisional (auto-created by CRM sync) |
| Shipments | 56,085 — all `source='crm'` |
| Shipment match status | 49,102 `matched` · 4,375 `invalid_icris` · 2,608 `icris_missing` |
| Company aliases | 4,775 — 4,679 `crm`, 75 `manual`, 21 `company_master` |
| Documents | 2 |
| Manifest import batches | 0 (Excel import is disabled) |
| Open data-quality issues | ~81,000, dominated by 68,484 `crm_customer_name_mismatch` |
| Alembic revision | `20260804_0010` (head) |
| Backend tests | 89 passing |

Those data-quality counts are not a typo. See [10-known-issues.md](10-known-issues.md).

---

## Conventions used in these docs

- `file.py:123` — clickable reference to a specific line.
- **[verified]** — I ran it and observed the result.
- **[code-read]** — read from source but not exercised at runtime.
- **[unverified]** — inherited from older docs; treat with suspicion, several such claims turned out to be false.
