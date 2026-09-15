# Customer 360 — QA Audit Report

**Date:** 2026-08-06
**Mode:** read-and-test only. No source file was modified, no volume touched, no `down -v`.
**Artifacts written:** `qa/QA-REPORT.md`, `qa/BUGS.md`, `qa/OPEN-QUESTIONS.md`, plus two throwaway probes (`qa/test_data_rules.py`, `qa/test_parser.py`).

---

## 0. Environment actually used

| Item | Value |
|---|---|
| Stack | **Local Docker**, not remote-compose |
| Backend | `customer360-backend-1` → `http://localhost:8360` |
| DB | `customer360-db-1` (PostgreSQL 16), 999 companies / 56,085 shipments |
| Nginx (built dist) | `customer360-web-1` → `http://localhost:3600` |
| Vite dev server | started by me on `:5199` for live page testing |
| Frontend container | **not running** |

**Deviation from the brief, and why.** You asked me to assume remote-compose. I did not use it. `scripts/remote-compose.sh sync` runs `rsync -az --delete` against `shangrila002@100.94.204.57`, which would have overwritten the remote tree with my local one — a write, and out of scope for a read-only audit. I confirmed the remote is reachable and that `customer360-dev` exists there, but the customer360 stack is **not running on it** (only unrelated `shangrila-marketing-tracker` and `ratecalculator` containers). You then confirmed everything is local now. All results below are from the local stack.

**One caveat on the tree under test:** it still contains the provisional-count change from our previous session (`main.py` `is_provisional` in `all_comp_rows`; `CustomerAnalytics.tsx`; `BusinessAnalytics.tsx`). Nothing in this audit depends on those edits.

---

## 1. Required command results

| Command | Result |
|---|---|
| `pytest` | **89 passed**, 1 deprecation warning, 7.92s |
| `alembic current` vs `heads` | **`20260804_0010` = head.** No pending migration |
| `npm run typecheck` | **FAILS — script does not exist.** `package.json` defines only `dev, build, lint, preview` |
| `npm run build` | **FAILS — exit code 2. 165 TypeScript errors. `tsc -b` aborts, `vite build` never runs, no bundle emitted** |
| `npm run lint` (oxlint) | Passes with warnings only (unused imports) |

Build error breakdown: 117 × TS6133 (unused), 22 × TS2339 (property missing), 5 × TS18048, 4 × TS7006, 4 × TS2304 (name not found), 3 × TS2345, 2 × TS2353, 2 × TS2307 (**module not found**), and 6 others.

---

## 2. Findings by area

Severity: **blocker** = ship-stopper · **major** = wrong data / broken feature · **minor** = cosmetic, perf, or docs.

### A. Auth — **BROKEN (blocker)**

| # | Test | Result | Sev | Conf | Location |
|---|---|---|---|---|---|
| A1 | Login with wrong password | pass — 401 | — | high | `main.py:58` |
| A2 | Login `admin@gmail.com` / `admin123` | pass — 200, cookie set | — | high | migration `20260804_0010:34` |
| A3 | Session restore on refresh (`GET /auth/me`) | pass — 200 after reload | — | high | `auth.tsx:30` |
| A4 | `/auth/me` with no cookie | pass — 401 | — | high | `auth.py:88` |
| A5 | Cookie flags | `HttpOnly` ✓, **`Secure=false`**, `SameSite=lax`, no expiry | minor | high | `main.py:63-70` |
| A6 | **`require_role` gating** | **BROKEN — never applied to any route** | **blocker** | high | `auth.py:104`, `main.py:14` |
| A7 | **Session secret** | **BROKEN — shipped default in use, tokens forgeable** | **blocker** | high | `auth.py:32`, `core.py:6` |
| A8 | Session expiry | none — token is `user_id.hmac`, valid forever | major | high | `auth.py:84` |

**A6 detail.** `require_role` is imported at `main.py:14` and never called. Of 100 route operations across 87 paths, exactly **one** (`GET /auth/me`) has an auth dependency. Verified live with no cookie at all:

```
200  GET /api/v1/companies          200  GET /api/v1/crm-sync/runs
200  GET /api/v1/matching-review    200  GET /api/v1/analytics/overview
200  GET /api/v1/shipments          200  GET /api/v1/company-imports
200  GET /api/v1/admin/backups
```

The frontend's `RequireAdmin` (`App.tsx:51`) only hides UI. Every admin-gated page's data — CRM Sync, Matching Review, Data Quality — plus destructive `POST`/`DELETE` routes are open to anyone who can reach port 8360. This includes `POST /api/v1/companies/{source}/merge/{target}`, which **hard-deletes** a company row.

**A7 detail.** `.env` sets no `AUTH_SECRET`, so `core.py:6`'s default `"customer360-dev-auth-secret"` is live. I recomputed the HMAC for the admin UUID offline and it matched the real cookie byte-for-byte, then authenticated with the forged value having never logged in:

```
forged sig 611580aaff7307b71a07d2310c0deb08…  ==  live cookie sig
GET /auth/me  →  200 {"role":"admin"}
```

### B. Company directory / ICRIS — **mostly pass, 2 minor defects**

| # | Test | Result | Sev | Conf | Location |
|---|---|---|---|---|---|
| B1 | ICRIS exact match | pass | — | high | — |
| B2 | ICRIS case-insensitive (`r11241`) | pass | — | high | — |
| B3 | **ICRIS trimmed via `/companies?q=`** | **FAIL — `"  R11241  "` returns 0** | minor | high | `main.py:129` |
| B4 | ICRIS trimmed via `/search` | finds it, but **rank drops 1→7** | minor | high | `main.py:743` vs `756` |
| B5 | SQL-level `exact_company` (upper+trim) | pass | — | high | `crm_sync.py:13` |
| B6 | Company detail / aliases / documents / analytics / activity | all 200, <70ms | — | high | — |
| B7 | **`/companies/{id}/shipments`** | **16.3 MB in 2.28s, no pagination** | major | high | `main.py:438` |
| B8 | Alias volume | **4,775 aliases; 1,870 on one company** | major | high | `crm_sync.py:23` |

**Key data rule touched — "ICRIS matching is exact, case-insensitive, trimmed."** The *authoritative* path (`exact_company`, used by CRM sync) honours it fully. Only the two UI-facing search endpoints don't: `main.py:129` interpolates `%{q}%` without stripping, and `main.py:756` compares the exact-match rank against untrimmed `q` while the `LIKE` at `:743` uses `q.strip()`. Pasting an ICRIS with a trailing space out of Excel silently returns nothing in the directory.

### C. CRM sync + worker — **pass, 1 major defect**

Claim loop, lease recovery, and backoff are well built: `claim_item` uses `FOR UPDATE SKIP LOCKED` (`crm_worker.py:120`), `recover_stale` reclaims expired leases (`:54`), `classify` splits retryable from permanent (`:29`), and each manifest commits in its own transaction (`:141-148`). `direction=='import'` is force-dry-run at `:144`, so import manifests never write business tables.

I exercised the data rules directly against the live schema inside a transaction that was always rolled back (`qa/test_data_rules.py`): **16 of 17 passed.**

| # | Rule under test | Result | Sev | Conf | Location |
|---|---|---|---|---|---|
| C1-2 | New valid ICRIS → provisional company created | pass | — | high | `crm_sync.py:39` |
| C3 | Repeated ICRIS reuses same company | pass | — | high | `crm_sync.py:35` |
| C4 | ICRIS match case-insensitive + trimmed | pass | — | high | `crm_sync.py:13` |
| C5-7 | Blank ICRIS → `icris_missing`, stays unlinked | pass | — | high | `crm_sync.py:34` |
| C8-9 | **Manual company link never overwritten** | pass | — | high | `crm_sync.py:31` |
| C10 | **Exact name match + blank ICRIS does NOT auto-link** | pass | — | high | `crm_sync.py:33` |
| C13-14 | **Blank cells never erase existing values** | pass | — | high | `crm_sync.py:98,101` |
| C15 | Non-blank value does update | pass | — | high | — |
| C16 | Manual override on `importer_name` respected | pass | — | high | `crm_sync.py:98` |
| C17 | **Manual override on `shipment_date` respected** | **FAIL — clobbered** | **major** | high | `crm_sync.py:96` |
| — | `crm_sync_state.entity_type` uniqueness | **not enforced in DB; duplicate rows exist** | major | high | `models.py:159` |
| — | Cron `"0 18,21 * * *"` parsing | pass — quotes stripped, matches 18:00/21:00 only | — | high | `crm_worker.py:196` |

**C17 is the one real rule violation in the sync engine.** `crm_sync.py:96` assigns `shipment.shipment_date = mawb.manifest_date` unconditionally, *outside* the `overrides` guard that correctly protects every `field_map` and `num_map` field two lines below. A date a user edited via `PATCH /shipments/{id}` (which does record `shipment_date` in `manual_override_fields`, `main.py:513`) is silently overwritten on the next sync. Measured: manual `2020-01-01` → `2026-07-16`.

A full schema diff of every model against the live DB found exactly one drift: `crm_sync_state.entity_type` declares `unique=True` but has no unique index in Postgres, and two `entity_type='worker'` rows already exist. `heartbeat()` and `watermark_state()` both do `db.scalar(select(...).where(entity_type==...))`, which silently picks one arbitrary row.

### D. Parser — **pass, clean**

| # | Test | Result | Conf |
|---|---|---|---|
| D1 | 17-column contract | pass — exactly 17 | high |
| D2 | `Icrisno` / `Tarriff Rate` kept as source spellings | pass | high |
| D3 | **Corrected spellings rejected** (`ICRIS No`, `Tariff Rate`) | pass — `CrmParseError(crm_header_mismatch)` | high |
| D4 | All 8 fixtures | all behave correctly (see below) | high |
| D5 | Structure change never yields silent empty | pass — raises `crm_partial_page` | high |
| D6 | PP/FC/FD stored as separate keys | pass — `pp_/fc_/fd_` × weight/pieces/bill/gross | high |

Fixture results: `crm_manifest_detail` → 3 rows, `Icrisno='R1100X'`, `Tarriff Rate='4.5'`, raw keys identical to `ROW_HEADERS`; `crm_export_live_structure` → 1 row; `crm_manifest_list` → 2 rows; `crm_login` + `crm_webforms_login` → `LoginRequired`; `crm_changed` → `PartialManifestError`; `crm_invalid_numeric` → parses with a warning (does not crash); `crm_empty` → 0 rows + warning, and the worker converts that to `EmptyManifestError` at `crm_worker.py:138`.

One blemish, **minor**: the import-manifest fallback branch (`crm_parser.py:214-265`) synthesises values that don't exist in the source — `'Dim wt': '0'`, `'Tarriff Rate': '0'`, `Pcs` defaulting to `'1'`, `Act wt` to `'0'` (`:240-247`) — which contradicts *"Never invent dates, dimensions, IDs, currency, or other source data."* It also `continue`s past a blank tracking number (`:252`) where the strict path raises (`:202`). Impact is currently nil because import direction is force-dry-run.

### E. Imports — **pass, but far narrower than documented**

**Company master (`company_imports.py`)** — reachable, correct:

| # | Test | Result | Sev | Conf |
|---|---|---|---|---|
| E1 | Preview + commit flow | pass — `/company-imports/preview` then `/company-imports` | — | high |
| E2 | Requires ICRIS Number + Company Name | pass | — | high |
| E3 | Provisional promotion | pass (`:75`) | — | high |
| E4 | Manual `company_name` override respected | pass (`:77`) | — | high |
| E5 | Name conflicts → `DataQualityIssue`, not silent overwrite | pass (`:87`) | — | high |
| E6 | **Accepts `.xls` / `.csv` as documented** | **FAIL — `.xlsx` only** | major | high |
| E7 | **`create_only` / `upsert_by_icris` modes** | **FAIL — do not exist in code** | major | high |

`create_only` and `upsert_by_icris` appear only in `README.md` and `AGENTS.md`; grep finds them nowhere in `backend/`. There is no mode parameter — the import always upserts by ICRIS while respecting manual overrides. `.xlsx` is enforced twice (`company_imports.py:32`, `main.py:552`) against README's claim of `.xls`/`.xlsx`/`.csv`.

**26-column manifest (`imports.py`)** — contract correct, but **dead code**:

- `MANIFEST_HEADERS` is exactly 26, source misspellings `Importer Adresse 1/2/3` preserved, missing headers rejected (`:38`).
- Blank cells don't erase (`:61`), manual links protected (`:63`), fuzzy is suggestion-only — `status='suggested'` never sets `company_id` (`:63`).
- **But `import_manifest` / `preview_manifest` / `match_company` are never called from `main.py`.** Only `read_file` is imported (`main.py:16`) and it too is unused. No manifest-import route exists in the OpenAPI spec, and `ManifestImports.tsx` makes zero API calls. This matches README's *"Excel operation-manifest upload is disabled."*
- **Latent landmine at `imports.py:63`:** `shipment.company_id = company.id if status=='matched' else None`. On an existing shipment whose link came from CRM exact-ICRIS matching, a re-import whose shipper name doesn't match would **null out that link** (only `manually_matched` is checked, not ICRIS provenance). Harmless today; a data-loss bug the moment this endpoint is re-enabled.

### F. Analytics views — **pass, totals verified correct**

| View | Rows | Verification |
|---|---|---|
| `vw_company_operational_summary` | 999 | **0 mismatches / 999 rows** vs ground-truth `COUNT(DISTINCT …)` for both `shipment_count` and `package_count` |
| `vw_destination_summary` | 150 | **exact reconciliation** — view sum 56,085 = `COUNT(*) FROM shipments` 56,085; 150 view rows = 150 distinct countries |
| `vw_company_document_summary` | 999 | returns data |
| `vw_manifest_import_quality` | **0** | correct-but-empty: 0 rows in `manifest_import_batches` because Excel import is disabled |

Three additional views exist that CLAUDE.md doesn't mention: `vw_crm_sync_quality`, `vw_customer_name_quality`, `vw_mawb_reconciliation`.

**Currency / unit aggregation — the one rule breach here.** The dedicated endpoints are correct: `/analytics/values-by-currency` groups by `value_currency` (`main.py:847`) and `/companies/{id}/analytics` groups by both `value_currency` and `weight_unit` (`main.py:1592`). The executive/business analytics path is not:

- `coalesce(s.value_currency, 'USD')` at `main.py:1078` — invents a currency.
- `COALESCE(s.bill_amount, s.declared_value, 0)` at `main.py:982, 1077, 1116, 1151, 2035, 2258` — mixes CRM bill amounts (no currency) with declared values (which carry `value_currency`), contradicting *"CRM bill amounts have no assumed currency and are excluded from declared-value currency totals."*
- Hardcoded `'currency': 'USD'` at `main.py:1243, 1489`; every analytics page formats with `` `$${v}` ``.

**Severity is major but currently latent:** all 56,085 shipments have `value_currency IS NULL` and `declared_value IS NULL` — 100% carry only `bill_amount`. So the `COALESCE` never reaches `declared_value` today. It activates the moment Excel manifest data lands. The `$` labelling, however, is wrong *right now*.

PP/FC/FD are correctly kept separate everywhere except **one** place: `main.py:790` computes `pp_weight + fc_weight + fd_weight` for MAWB search metadata. Same unit, display-only — flagged, not escalated.

### G. Frontend — **loads, but build broken + 1 runtime crash**

All 21 routes render without white-screening. Console across the whole walk was clean except one error class.

| # | Test | Result | Sev | Conf | Location |
|---|---|---|---|---|---|
| G1 | All 21 routes render | pass | — | high | — |
| G2 | **`api.ts` paths vs backend** | **pass — all 46 resolve to real routes, 0 broken** | — | high | — |
| G3 | Console errors | 1 class only — duplicate React keys | major | high | `DataQuality.tsx:108` |
| G4 | **`api.getShipment`** | **`undefined` → TypeError** | **major** | high | `AirWaybills.tsx:494` |
| G5 | `api.getDiagnoseData` | `undefined`, but guarded → silently `{}` | minor | high | `CrmSync.tsx:42` |
| G6 | Stub pages | 7 routes render chrome only | minor | high | — |
| G7 | Missing modules | 2 unresolvable imports | major | high | `chart-loading-label.tsx:5` |
| G8 | Served dist freshness | **stale — built 2026-07-28** | major | high | `frontend/dist/` |

**G3 root cause.** `/api/v1/quality-issues/company-conflicts` returns 29 rows with only **12 distinct `source_id`** — one company appears **18 times** (a one-source-to-many-targets fan-out). `DataQuality.tsx:108` keys the list on `conflict.source_id`, and `:40` builds `selectedIds` as a `Set` of `source_id`. So checking one row visually checks all 18 siblings, and the selection set collapses 29 conflicts into 12. The action behind it is `mergeCompanies`, which **hard-deletes** — see BUGS.md D-2.

**G4 confirmed at runtime**, not just by `tsc`:
```
AirWaybills_getShipment: "THREW: TypeError: m.api.getShipment is not a function"
CrmSync_getDiagnoseData: "no-throw (guarded) -> {}"
```
`AirWaybills.tsx:494` is unguarded inside a `useQuery` `queryFn`, so opening an AWB detail drawer throws. `CrmSync.tsx:42` guards with `api.getDiagnoseData ? … : Promise.resolve({})`, so the diagnose panel is permanently empty instead of crashing.

**G7.** `chart-loading-label.tsx:5` imports `'../components/shimmering-text'`; from `src/components/charts/` that resolves to `src/components/components/`, which doesn't exist — the file is at `src/components/shimmering-text.tsx`, so the path should be `'../shimmering-text'`. `live-sales-dashboard.tsx:3` imports `@/demos/hooks/useRealtimeSalesData`, which doesn't exist at all. Neither chain is imported by any page, so they break the **build only**, not runtime.

**G6.** `/app/imports`, `/app/profitability`, `/app/rankings`, `/app/users`, `/app/roles`, `/app/audit-logs`, `/app/settings` all render ~385-396 chars of shell chrome with no `<h1>` and make zero API calls. There are also no backend endpoints for user/role management, so the entire ADMINISTRATION section is non-functional.

---

## 3. Key data rules — verdict table

| Rule | Verdict | Evidence |
|---|---|---|
| ICRIS exact, case-insensitive, trimmed | **holds in the authoritative path**; two UI search endpoints don't trim | C4 pass; B3/B4 fail |
| Fuzzy name/tracking never auto-applied | **holds** | C10 pass; `imports.py:63` suggested→`None`; tracking merge is exact-only (`crm_sync.py:93`) |
| Manual company link never overwritten | **holds** | C8/C9 pass; `crm_sync.py:31`, `imports.py:63`, `rematch` `:115` — **except `merge_companies` relinks without checking** |
| Manual field overrides preserved | **violated for `shipment_date`** | C17 fail, `crm_sync.py:96` |
| Blank cells never erase on upsert | **holds** | C13/C14 pass; `crm_sync.py:98,101`; `imports.py:61` |
| PP/FC/FD kept separate | **holds in storage**; one display-only sum | `crm_sync.py:88`; `main.py:790` |
| Currencies/units never aggregated | **violated in exec/business analytics** (latent) | `main.py:982,1077,1078,1116,1151,2035,2258` |
| CRM integration read-only | **holds** | connector issues only GET/postback; no save/update/delete |
| Provisional created / promoted | **holds** | C1/C2 pass; `company_imports.py:75` |

---

## 4. Test coverage gaps

89 tests, but **79% of them are CRM** (38 reliability + 7 parser + 7 backfills + 6 crm_api + 5 connector + 4 settings + 3 sync = 70). Remaining 19 cover company-master import (8), generic API (6), manifest (2), executive analytics (2), dossier (1).

Untested, and each maps to a finding above:

- **Auth entirely** — no test for login, session restore, expiry, or `require_role`. A test asserting "unauthenticated `GET /api/v1/companies` → 401" would have caught blocker B-1 on day one.
- **Endpoint authorization** — nothing asserts which routes require which role.
- **`merge_companies`** — the only hard-delete in the app has zero tests.
- **Documents** — upload, dedup, replace/versioning, archive, path-traversal guard: untested.
- **Search / directory filters** — the trim bugs (B3/B4) are untested.
- **Analytics** — only 2 tests; no view-total reconciliation test (I had to write the cross-check by hand).
- **`shipment_date` override** — no test covers CRM sync vs `manual_override_fields` for that field (C17).
- **Frontend** — no test framework at all: no unit, component, or e2e tests. Nothing would have caught `api.getShipment` being undefined.
- **Schema drift** — nothing asserts model constraints match the DB (would have caught `crm_sync_state`).

---

## 5. What I did not test

- Remote-compose deployment path (deliberately skipped, §0).
- Live CRM connector against `192.168.101.3:8040` — I did not trigger a real sync run, since that writes business tables. Connector behaviour is covered by the 5 existing connector tests and the fixture suite.
- `POST /api/v1/admin/backup` and document upload/replace — mutating; I inspected code and the (empty) backup listing only.
- Load/concurrency behaviour of the claim loop with >1 worker (`CRM_SYNC_MAX_CONCURRENCY=1` today).

---

## 6. Cleanup note

The Vite dev server I started on port **5199** for live page testing has been stopped. Nothing else was started, and no container, volume, or source file was altered. To reproduce the frontend findings yourself:

```bash
cd frontend && npm run dev -- --port 5199 --strictPort
```

It proxies `/api` to `localhost:8360` via `vite.config.ts:42`, so it works against the running backend with no extra setup. Log in with `admin@gmail.com` / `admin123`.
