# Customer 360 — Confirmed Defects

Only defects I reproduced. Ranked by severity, then blast radius.
Suspicions I could not confirm are in `OPEN-QUESTIONS.md`.

---

## BLOCKERS

### B-1 — Every API endpoint except `/auth/me` is unauthenticated

**Severity:** blocker · **Confidence:** high · **Where:** `backend/app/auth.py:104`, `backend/app/main.py:14`

`require_role` is imported and never invoked. Of 100 route operations across 87 paths, only `GET /api/v1/auth/me` carries an auth dependency. `App.tsx:51`'s `RequireAdmin` hides UI but guards nothing on the wire.

**Repro**
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8360/api/v1/companies
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8360/api/v1/crm-sync/runs
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8360/api/v1/admin/backups
```
All return `200` with no cookie. Observed: `companies`, `crm-sync/runs`, `matching-review`, `analytics/overview`, `shipments`, `company-imports`, `admin/backups` — all open.

**Root cause** — the dependency was written but never wired into the route decorators. Every mutating route is equally exposed, including `POST /api/v1/companies/{source_id}/merge/{target_id}`, which hard-deletes a company (see D-2), and `DELETE /api/v1/documents/{id}`.

**Blast radius** — full read *and write* access to customer, shipment, and document data for anyone who can reach port 8360. Note `docker-compose.yml:18` publishes `8360:8000` on all interfaces locally; only the remote overlay binds to `127.0.0.1`.

---

### B-2 — Session tokens are forgeable: shipped default `AUTH_SECRET` is live

**Severity:** blocker · **Confidence:** high · **Where:** `backend/app/auth.py:32`, `backend/app/core.py:6`

`.env` never sets `AUTH_SECRET`, so `Settings.auth_secret` falls back to the hardcoded literal `"customer360-dev-auth-secret"`. The session cookie is `f"{user_id}.{hmac_sha256(secret, user_id)}"` with no expiry, nonce, or issued-at.

**Repro**
```bash
SIG=$(python3 -c "import hmac,hashlib;print(hmac.new(b'customer360-dev-auth-secret',b'11111111-1111-1111-1111-111111111111',hashlib.sha256).hexdigest())")
curl -s http://localhost:8360/api/v1/auth/me -H "Cookie: c360_session=11111111-1111-1111-1111-111111111111.$SIG"
```
Returns `{"id":"11111111-…","email":"admin@gmail.com","role":"admin"}` — full admin identity, never having logged in. The forged signature matched the real cookie byte-for-byte.

The admin UUID is not even a secret: migration `20260804_0010_auth_users.py` seeds it as the fixed literal `11111111-1111-1111-1111-111111111111`.

**Root cause** — a development default that is safe to *have* but must never be the *effective* value; nothing fails closed when `AUTH_SECRET` is absent.

**Compounding:** tokens never expire (`auth.py:84`), so a leaked cookie is valid forever — `POST /auth/logout` only clears the client cookie (`main.py:77`), it cannot revoke. And `secure=False` (`main.py:69`) allows transmission over plaintext HTTP.

---

### B-3 — `npm run build` fails; no production bundle can be produced

**Severity:** blocker · **Confidence:** high · **Where:** `frontend/package.json` (`"build": "tsc -b && vite build"`)

**Repro**
```bash
cd frontend && npm run build; echo "exit=$?"
```
`exit=2`. **165 TypeScript errors.** `tsc -b` aborts before `vite build` ever runs — zero bundle output.

**Root cause** — `tsconfig` has `noUnusedLocals`/`noUnusedParameters` on (117 of 165 are TS6133 unused-symbol errors) *and* there is a tail of genuine type breakage. The build has evidently not been run in a while: the dist currently served by `customer360-web-1` is dated **2026-07-28**, predating the 2026-08-04 auth migration. The deployed frontend cannot be rebuilt without fixing this.

**The substantive (non-unused) errors worth fixing regardless:**

| Location | Error |
|---|---|
| `src/api.ts:308` | `Cannot find name 'Shipment'` — `MawbDetail.shipments: Shipment[]` references an undefined type |
| `src/components/charts/chart-loading-label.tsx:5` | `Cannot find module '../components/shimmering-text'` (see D-4) |
| `src/components/ui/live-sales-dashboard.tsx:3` | `Cannot find module '@/demos/hooks/useRealtimeSalesData'` (see D-4) |
| `src/pages/AirWaybills.tsx:494` | `Property 'getShipment' does not exist` (see D-3) |
| `src/pages/AirWaybills.tsx:584,600` | `Cannot find name 'Check'` / `'Globe'` — icons used but never imported |
| `src/pages/CrmSync.tsx:42` | `Property 'getDiagnoseData' does not exist` (see D-5) |
| `src/pages/MatchingReview.tsx:44` | `Cannot find name 'Shipment'` |
| `src/pages/CustomerDirectory.tsx:579,583,605,615` | `revenue`/`shipment_count`/`country`/`ae_code` missing on `CompanyDetail` |
| `BusinessAnalytics` / `CustomerAnalytics` (11×) | `all_customers`, `prev_trend` missing from the `api.ts` response types — the backend *does* return them; the type definitions are stale |

`AirWaybills.tsx:584,600` is a latent runtime `ReferenceError` in whatever branch renders those icons.

---

### B-4 — `npm run typecheck` does not exist, yet is the documented verification step

**Severity:** blocker (for the documented workflow) · **Confidence:** high · **Where:** `frontend/package.json`

**Repro**
```bash
cd frontend && npm run typecheck
```
→ `npm error Missing script: "typecheck"`. Available scripts are only `dev, build, lint, preview`.

**Root cause** — the script was removed or never added. It is cited as a required step in `CLAUDE.md`, `AGENTS.md` ("Verification order: alembic upgrade head → pytest → npm run typecheck → npm run build"), and `README.md`, and in the `remote-compose.sh exec frontend npm run typecheck` examples. Every one of those instructions fails.

---

## MAJOR

### M-1 — CRM sync overwrites a manually-edited `shipment_date`

> ## ✅ RESOLVED 2026-08-06
> Fixed in `crm_sync.py:96-98` — the `overrides` lookup was hoisted above the CRM field
> assignments and `shipment_date` is now guarded by it. `qa/test_data_rules.py` C-17 passes
> (**17/17**); regression test added at
> `tests/test_crm_sync.py::test_manual_shipment_date_override_is_preserved_but_others_still_sync`.
> Suite went 89 → **90 passing**. The findings below are the original 2026-08-06 audit record.

**Severity:** major · **Confidence:** high · **Where:** `backend/app/crm_sync.py:96`
**Key data rule:** *"Manual company links are never overwritten"* / manual override preservation.

**Repro** — `qa/test_data_rules.py`, case C-17 (runs in a rolled-back transaction):
```bash
docker exec -i customer360-backend-1 python - < qa/test_data_rules.py
```
```
FAIL  C-17 manual override on shipment_date respected
      got=datetime.date(2026, 7, 16) expect=datetime.date(2020, 1, 1)
```
Set `shipment.shipment_date = 2020-01-01` with `manual_override_fields = ['importer_name','shipment_date']`, then run `upsert_detail` for a manifest dated 2026-07-16. `importer_name` is correctly preserved (C-16 passes); `shipment_date` is silently replaced.

**Root cause** — line 96 assigns unconditionally:
```python
shipment.mawb_id=mawb.id;shipment.shipment_date=mawb.manifest_date;shipment.crm_source_url=source_url;…
```
This sits *above* the guard that protects every other business field two lines down:
```python
overrides=set(shipment.manual_override_fields or [])
for src,target in field_map.items():
    if raw[src].strip() and target not in overrides: setattr(...)
```
`shipment_date` is never consulted against `overrides`, even though `PATCH /shipments/{id}` (`main.py:513-519`) does record it there. Silent, and it recurs on every subsequent sync.

---

### M-2 — Company merge: non-unique React key makes bulk selection operate on the wrong rows

**Severity:** major · **Confidence:** high · **Where:** `frontend/src/pages/DataQuality.tsx:40,108`; `backend/app/main.py:1928`

**Repro**
1. Open `/app/quality`. Console logs *"Encountered two children with the same key"* (17 occurrences).
2. ```bash
   curl -s http://localhost:8360/api/v1/quality-issues/company-conflicts
   ```
   → 29 rows, only **12 distinct `source_id`**; `b02344f5-ca51-4034-89ec-de08f1a8be0e` appears **18 times**.

**Root cause** — the endpoint fans out one source company across many merge targets. The page keys on `source_id` alone (`:108`) and builds selection state as `new Set(conflicts.map(c => c.source_id))` (`:40`). Eighteen distinct conflict rows collapse to one key, so React cannot tell them apart and per-row checkboxes toggle siblings.

**Why this is major rather than cosmetic** — the action behind the selection is `mergeCompanies(source_id, target_id)`, and `main.py:1942` does `db.delete(source)`: a **hard delete** of a `companies` row. This is the only hard delete of a business entity in the app (everything else soft-deletes to `status='archived'`). A user selecting one conflict may not be merging the pair they see. Combined with B-1 the endpoint is also unauthenticated.

Two secondary issues in the same handler: it reassigns shipments with a blanket `UPDATE … SET company_id = target` (`:1934`) without checking `manually_matched`, and it rewrites `ActivityLog` rows by `entity_id` with **no `entity_type` filter** (`:1937`). No audit record is written for the merge itself.

---

### M-3 — `api.getShipment` is undefined; the AWB detail drawer throws

**Severity:** major · **Confidence:** high · **Where:** `frontend/src/pages/AirWaybills.tsx:494`

**Repro** — in the running app's console:
```js
const m = await import('/src/api.ts');
await m.api.getShipment('00000000-0000-0000-0000-000000000000');
```
→ `TypeError: m.api.getShipment is not a function`. `api.ts` exports 45 methods; `getShipment` is not among them (`getShipments`, plural, exists).

**Root cause** — the page calls a client method that was never added to `api.ts`. It sits unguarded inside a `useQuery` `queryFn`, so it throws whenever the AWB detail drawer mounts. The backend route `GET /api/v1/shipments/{shipment_id}` exists and works — only the client binding is missing.

---

### M-4 — `crm_sync_state.entity_type` uniqueness is declared but not enforced; duplicates already exist

**Severity:** major · **Confidence:** high · **Where:** `backend/app/models.py:159`

**Repro**
```bash
docker exec customer360-db-1 psql -U customer360 -d customer360 -c "\d crm_sync_state"
docker exec customer360-db-1 psql -U customer360 -d customer360 -c \
  "SELECT entity_type, count(*) FROM crm_sync_state GROUP BY 1 HAVING count(*)>1;"
```
The table has only `crm_sync_state_pkey` on `id` — no unique index on `entity_type`. Two `entity_type='worker'` rows exist today.

A full model-vs-database diff across every table found this as the **only** drift, so it is a one-off migration miss rather than systemic.

**Root cause** — the model gained `unique=True` without a matching Alembic migration.

**Impact** — `heartbeat()` (`crm_worker.py:45`) and `watermark_state()` both resolve state with `db.scalar(select(CrmSyncState).where(entity_type == …))`, which returns an arbitrary row when duplicates exist. If a `watermark:export` row ever duplicates, incremental sync would read the wrong high-water mark and silently re-scan or skip a date range.

---

### M-5 — Analytics invent a currency and mix two incompatible amount columns

**Severity:** major (latent today) · **Confidence:** high · **Where:** `backend/app/main.py:1078`, and `:982, 1077, 1116, 1151, 2035, 2258`
**Key data rule:** *"PP, FC, FD totals stay separate. Never aggregate different currencies or weight units"* / *"CRM bill amounts have no assumed currency."*

**Repro**
```bash
grep -n "coalesce(s.value_currency, 'USD')\|bill_amount, s.declared_value" backend/app/main.py
docker exec customer360-db-1 psql -U customer360 -d customer360 -c \
  "SELECT coalesce(value_currency,'(null)') cur, count(*), count(declared_value), count(bill_amount) FROM shipments GROUP BY 1;"
```
→ all 56,085 shipments: `value_currency` NULL, `declared_value` NULL, `bill_amount` present.

**Root cause** — two separate assumptions:
1. `coalesce(s.value_currency, 'USD')` (`:1078`) fabricates USD for rows that have no declared currency, plus hardcoded `'currency': 'USD'` at `:1243` and `:1489`.
2. `COALESCE(s.bill_amount, s.declared_value, 0)` at six call sites treats a CRM bill amount (no currency) and a declared value (carries `value_currency`) as the same quantity, then sums across companies.

**Status** — the `COALESCE` fallback never reaches `declared_value` today because that column is entirely NULL, so no cross-currency sum is *currently* produced. It becomes a live data-correctness bug the moment Excel manifest data (which supplies `declared_value` + `value_currency`) is ingested. The fabricated `$` labelling in every analytics page (`fmt$` in `AEPerformance`, `BusinessAnalytics`, `GeographyAnalytics`, `OperationalAnalytics`) is wrong **now**.

The dedicated endpoints do it correctly (`/analytics/values-by-currency` `:847`, `/companies/{id}/analytics` `:1592` group by currency and weight unit), which is what makes the exec path look like an oversight rather than a decision.

---

### M-6 — `/companies/{id}/shipments` is unpaginated: 16.3 MB in one response

**Severity:** major · **Confidence:** high · **Where:** `backend/app/main.py:438`

**Repro**
```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s %{size_download}B\n" \
  http://localhost:8360/api/v1/companies/bacb5447-0d44-40bd-aa71-a4b4996204dc/shipments
```
→ `200 2.275375s 16336216B` — 16.3 MB, 2.3 s, for a customer with 5,527 shipments.

**Root cause** — the handler takes no `limit`/`offset` and serialises every shipment with its packages eagerly. Sibling endpoints (`/shipments`, `/companies`) both cap at `Query(50, le=200)`; this one was missed.

Related, lower impact: `/api/v1/companies` (`main.py:154-160`) materialises **all** matching rows in Python and slices afterwards, so `limit`/`offset` don't reduce DB work.

---

### M-7 — Unbounded alias creation: 1,870 aliases on a single company

**Severity:** major · **Confidence:** high · **Where:** `backend/app/crm_sync.py:23-27`, called from `:49`

**Repro**
```bash
docker exec customer360-db-1 psql -U customer360 -d customer360 -c \
  "SELECT c.icris_number, count(*) FROM company_aliases a JOIN companies c ON c.id=a.company_id GROUP BY 1 ORDER BY 2 DESC LIMIT 5;"
docker exec customer360-db-1 psql -U customer360 -d customer360 -c \
  "SELECT source, count(*) FROM company_aliases GROUP BY source;"
```
→ 4,775 aliases total across 431 companies; top company `A2Y500` has **1,870**; 4,679 (98%) have `source='crm'`.

**Root cause** — `link_icris` calls `_add_alias` on every successful match, which inserts any shipper-name spelling that differs from the company's normalized name. With thousands of manifest rows per customer, every typo, casing quirk, and trailing-token variant becomes a permanent alias. There is no threshold, cap, or review step.

**Impact** — `GET /companies/{id}/aliases` returns 446 KB for that company; `/api/v1/search` joins the alias table on every query; and alias-based matching is progressively diluted by junk entries, which undermines the alias mechanism's purpose.

---

### M-8 — Documentation describes features and commands that do not exist

**Severity:** major · **Confidence:** high

| Claim | Source | Reality |
|---|---|---|
| `npm run typecheck` | `CLAUDE.md`, `AGENTS.md`, `README.md` | script does not exist (B-4) |
| Company master accepts `.xls`, `.xlsx`, `.csv` | `README.md:81` | `.xlsx` only — enforced at `company_imports.py:32` and `main.py:552` |
| `create_only` / `upsert_by_icris` import modes | `README.md:81`, `AGENTS.md:81` | **no such parameter anywhere in `backend/`** |
| "Vite proxies are not used" | `CLAUDE.md` | false — `vite.config.ts:42-48` proxies `/api` → `localhost:8360` |
| "There is deliberately no authentication… in this phase" | `AGENTS.md:19` | stale — auth shipped in migration `20260804_0010` |
| "Playwright, Beautiful Soup" in stack | `README.md:131` | Playwright is not used by the connector; `AGENTS.md:75` correctly says otherwise |
| `main.py` is "~480 lines" | `AGENTS.md:23` | 2,541 lines |
| `App.tsx` is "a single file… entire SPA" | `AGENTS.md:24` | false — 21 separate page components under `src/pages/` |

Note the `CLAUDE.md` I generated earlier in this session inherited three of these (the `.csv` claim, `npm run typecheck`, and the Vite-proxy statement) by trusting `README.md`/`AGENTS.md`. They should be corrected at the same time.

---

## MINOR

### D-1 — Directory search does not trim the query
`backend/app/main.py:129`. `q='  R11241  '` → 0 results, while `q='R11241'` → 1. The handler builds `f'%{q}%'` without `.strip()`. Pasting an ICRIS with trailing whitespace from Excel silently finds nothing. **Key data rule:** *ICRIS matching is exact, case-insensitive, trimmed.*

### D-2 — `/search` exact-match ranking uses the untrimmed query
`backend/app/main.py:743` vs `:756`. The `LIKE` uses `q.strip()`, but the rank comparison uses raw `q`, so `'  R11241  '` still finds the company yet drops from rank 1 to rank 7 — an exact ICRIS hit gets buried below fuzzy name matches.

### D-3 — CRM Sync diagnose panel is silently dead
`frontend/src/pages/CrmSync.tsx:42`. `api.getDiagnoseData` is undefined, but the call is guarded (`api.getDiagnoseData ? … : Promise.resolve({})`), so the panel renders empty forever with no error. Backend `GET /api/v1/crm-sync/diagnose` exists and works.

### D-4 — Two unresolvable module imports (build-only)
`chart-loading-label.tsx:5` imports `'../components/shimmering-text'`; from `src/components/charts/` that is `src/components/components/`, which doesn't exist — the file is at `src/components/shimmering-text.tsx`, so the correct path is `'../shimmering-text'`. `live-sales-dashboard.tsx:3` imports `@/demos/hooks/useRealtimeSalesData`, which does not exist at all. Neither is reachable from any page (`area-chart-loading` has no importer), so they break `tsc` only — but they are two of the 165 errors blocking B-3.

### D-5 — Seven routes are empty stubs
`/app/imports`, `/app/profitability`, `/app/rankings`, `/app/users`, `/app/roles`, `/app/audit-logs`, `/app/settings` render ~385-396 chars of shell chrome, no `<h1>`, and make zero API calls. There are also no backend endpoints for user or role management, so the whole ADMINISTRATION nav section is non-functional — while `App.tsx:129-148` wraps them in `RequireAdmin`, implying they work.

### D-6 — Import-manifest parser fabricates source values
`backend/app/crm_parser.py:240-247` hardcodes `'Dim wt': '0'` and `'Tarriff Rate': '0'`, and defaults `Pcs` to `'1'` / `Act wt` to `'0'`, for columns the import HTML does not contain. Contradicts *"Never invent dates, dimensions, IDs, currency, or other source data."* Line `:252` also `continue`s past a blank tracking number where the strict path raises (`:202`). Currently inert: import direction is force-dry-run at `crm_worker.py:144`.

### D-7 — `/search` sums PP + FC + FD weights
`backend/app/main.py:790`: `float(m.pp_weight or 0) + float(m.fc_weight or 0) + float(m.fd_weight or 0)`. Display-only, same unit, so arguably a legitimate physical total — but it is the single place PP/FC/FD are combined, against *"Keep PP, FC, and FD totals separate."* Storage correctly keeps them apart (`crm_sync.py:88`).

### D-8 — Dead manifest-import code carries a latent link-nulling bug
`backend/app/imports.py:63`: `shipment.company_id = company.id if status=='matched' else None`. For an existing shipment linked by CRM exact-ICRIS matching, re-import with a non-matching shipper name would **null the link** — only `manually_matched` is checked, not ICRIS provenance. Unreachable today (`import_manifest` has no route; `ManifestImports.tsx` makes no calls), so this is a landmine, not a live defect. Also `match_company` (`:27,29`) loads every company *and* every one of the 4,775 aliases per row group — O(n·m).

### D-9 — Session cookie hardening
`backend/app/main.py:63-70`: `secure=False` allows the cookie over plaintext HTTP; no `Max-Age`/`Expires` and no server-side expiry (`auth.py:84`), so a captured token is valid indefinitely and logout cannot revoke it. Distinct from B-2 but compounds it.

### D-10 — Cosmetic
`frontend/index.html` still has `<title>frontend_new</title>` (the default Vite scaffold title), visible in every browser tab. `vw_manifest_import_quality` is permanently empty (0 `manifest_import_batches`) since Excel import is disabled — correct behaviour, but any UI surfacing it will always look broken.

---

## Not defects (verified working)

Recording these so they don't get re-litigated:

- **Parser 17-column contract** — exactly 17 columns; `Icrisno` and `Tarriff Rate` preserved as source spellings; corrected spellings (`ICRIS No`, `Tariff Rate`) correctly **rejected** with `crm_header_mismatch`; structure change raises rather than yielding a silent empty result.
- **Manual company link protection** — holds in `crm_sync.link_icris` (`:31`), `rematch` (`:115`), and `imports.py:63`. Only `merge_companies` bypasses it (M-2).
- **Blank cells never erase** — holds in both `crm_sync.py:98,101` and `imports.py:61`.
- **Fuzzy never auto-applied** — an exact *name* match with a blank ICRIS does not link (C-10); `imports.py` `suggested` status leaves `company_id` NULL; tracking merge is exact-trimmed-only.
- **Analytics view totals** — `vw_company_operational_summary` reconciles with 0 mismatches across all 999 rows; `vw_destination_summary` sums to exactly 56,085 = `COUNT(*) FROM shipments`.
- **Worker claim loop** — `FOR UPDATE SKIP LOCKED`, lease expiry recovery, bounded backoff, per-manifest transactions, retryable/permanent error classification all behave as documented.
- **`api.ts` route correctness** — all 46 client call sites resolve to real backend routes; zero broken paths.
- **Cron schedule parsing** — `"0 18,21 * * *"` parses correctly (dotenv strips the quotes) and matches only 18:00 and 21:00.
- **Alembic** — at head, no pending migrations, no model/DB drift except M-4.
