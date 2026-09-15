# Known Issues

**As of 2026-08-06.** Every item here was reproduced against the running system. Full evidence and repro steps are in [`qa/BUGS.md`](../qa/BUGS.md); the audit method is in [`qa/QA-REPORT.md`](../qa/QA-REPORT.md); unresolved questions are in [`qa/OPEN-QUESTIONS.md`](../qa/OPEN-QUESTIONS.md).

> **Read this before trusting any other doc.** Several statements elsewhere in the repo describe intended behaviour that is not current behaviour.

---

## Blockers

### ~~B-1~~ · Every API endpoint except `/auth/me` is unauthenticated — mostly fixed independently, remaining gap closed 2026-09-10
`auth.py:104`, `main.py:14`

**Re-verified 2026-09-10: `require_role`/`get_current_user` are now wired onto most routes** (73 call sites) — this was fixed at some point after 2026-08-06 without this doc being updated, a stale-docs case in its own right. Two gaps remained and were closed today:
- `/admin/backup`, `/admin/backups`, `/admin/backups/{filename}/download` had **zero** auth dependency — an unauthenticated full database backup listing/download. Now `require_role('super_admin')`.
- A cluster of 11 legacy analytics endpoints (`overview`, `dashboard`, `customers`, `destinations`, `bill-types`, `values-by-currency`, `weights-by-unit`, `import-quality`, `document-completeness`, `data-quality`, `{report}/export.csv`) had no gate at all — an incomplete rollout, not intentional (their newer siblings like `executive-dashboard`/`ae-performance` were already gated via `get_ae_scope`→`get_current_user`). Now gated with `Depends(get_current_user)`, matching that pattern.

Verified live: all 14 previously-open routes now return 401 with no cookie; a regular (`role='user'`) session can still read analytics (200) but is correctly 403'd from `/admin/backups`.

The frontend's `RequireAdmin` still only hides UI — server-side enforcement is what actually matters and now holds for every route checked.

### ~~B-2~~ · Session tokens are forgeable — ✅ FIXED 2026-09-10
`auth.py:32`, `core.py:6`

`.env` set no `AUTH_SECRET`, so the shipped default `"customer360-dev-auth-secret"` was live, and tokens never expired. Fixed:
- `core.py`: `auth_secret` has **no default** now — `Settings()` fails at import (app won't start) if it's unset, instead of silently falling back to a literal anyone can read on GitHub.
- A real secret is set in the local `.env`; `.env.example` documents the key and how to generate one.
- `create_session_token`/`get_current_user` (`auth.py`) now embed and check an issue timestamp (`user_id:issued_at`, 14-day TTL) — a correctly-signed but expired token is rejected with "Session expired". The cookie's `max_age` was set to match.

Verified live: the documented forged-cookie exploit (HMAC computed offline with the old default secret) now returns 401; a fresh login still works; a bit-flipped signature is rejected; a correctly-signed 15-day-old token is rejected while a fresh one succeeds. This intentionally logs out every session that existed before the rotation — expected and acceptable for a local dev secret rotation.

Compounding, still open: `secure=False` on the cookie permits plaintext transmission (not changed — flipping it would break login on the current plain-HTTP local setup; revisit once the app is served over HTTPS). Logout still can't revoke a token before its TTL, only delete the client-side cookie — acceptable now that the TTL bounds the exposure window to 14 days instead of forever.

### ~~B-3 · `npm run build` fails — no bundle can be produced~~ — ✅ FIXED by 2026-09-09
`frontend/package.json`

Was exit code 2, 165 TypeScript errors (`tsc -b` aborting before `vite build`). As of 2026-09-09, `npx tsc -b --force` and `npm run build` both exit 0 — the underlying source errors (unresolved modules, missing `Check`/`Globe` imports in `AirWaybills.tsx`, the `Shipment` type issue in `api.ts:308`) were resolved somewhere between 2026-08-06 and now. The dist nginx serves at `:3600` is a manually-built static bundle (`docker-compose.yml:42`, read-only bind mount) — it does **not** rebuild automatically on deploy or on source change, so it must be rebuilt (`cd frontend && npm run build`) and shipped whenever frontend source changes are meant to reach `:3600`. The live-reloading surface is the Vite dev server on `:5173` (proxies `/api` to `:8360` locally; bound to `127.0.0.1` only on the remote server, reachable via `scripts/remote-compose.sh tunnel`).

### B-4 · `npm run typecheck` does not exist
Cited as a required verification step in `CLAUDE.md`, `AGENTS.md`, and `README.md`. `package.json` defines only `dev`, `build`, `lint`, `preview`. Use `npx tsc -b --noEmit`.

---

## Major

### ~~M-1 · CRM sync overwrites a manually-edited `shipment_date`~~ — ✅ FIXED 2026-08-06
`crm_sync.py:96-98`

The `overrides` lookup was hoisted above the CRM field assignments and `shipment_date` is now guarded:
```python
if 'shipment_date' not in overrides:shipment.shipment_date=mawb.manifest_date
```
Verified: `qa/test_data_rules.py` C-17 now passes (**17/17**), and a regression test covering both directions was added — `tests/test_crm_sync.py::test_manual_shipment_date_override_is_preserved_but_others_still_sync`. Suite is **90 passing**.

### ~~M-2~~ · Company merge: non-unique key makes bulk selection act on the wrong rows — ✅ FIXED 2026-09-10
`DataQuality.tsx` · `main.py`

A company can appear as a merge candidate more than once (paired with different targets), so keying selection/expand state on `source_id` alone let checking one row silently toggle every row sharing that source. Fixed by keying on the pair everywhere (`conflictKey = (c) => \`${c.source_id}:${c.target_id}\``): the "select all" set, the per-row checkbox, the React list `key`, and the expand/collapse toggle. Verified live: selecting one candidate now shows "Merge Selected (1)", not more.

`merge_companies` itself (`main.py`) had three further issues, all fixed in the same pass:
- **No auth at all** — now `require_role('super_admin')`.
- **Hard delete** (`db.delete(source)`, the only hard delete of a business entity in the app) — now archival (`source.status = 'archived'`), consistent with rule 11.
- **Reassigned every shipment regardless of `manually_matched`** (the one bypass of rule 3) — now only auto-matched shipments move to target; manually-matched ones stay on the archived source, which remains a real, queryable row instead of a dangling FK target. An `ActivityLog` entry now records the merge (who, source/target, counts reassigned vs. preserved).

Verified functionally: archived source still exists post-merge, auto-matched shipment moved to target, manually-matched shipment stayed on source. Full backend suite (192 tests) and both QA probes still pass.

### ~~M-3~~ · `api.getShipment` is undefined — AWB detail drawer throws — already fixed, docs were stale
`AirWaybills.tsx`

**Re-verified 2026-09-10: this was already fixed** — `api.getShipment` exists in `api.ts` and `AirWaybills.tsx` calls it correctly. Another case of this doc describing a state that no longer matched the code; no change needed.

### M-4 · `crm_sync_state.entity_type` uniqueness not enforced
`models.py:159`

The model declares `unique=True`; the database has no such index, and duplicate `entity_type='worker'` rows already exist. `heartbeat()` and `watermark_state()` use `db.scalar(...)`, which silently picks an arbitrary row. A duplicated `watermark:<direction>` row would make incremental sync read the wrong high-water mark.

The only model/DB drift in the schema. Fixing it needs a dedup step first. **Re-verified 2026-09-10: still live** (2 `worker` rows) — deliberately not fixed in this pass since it needs a dedup migration decision, not a mechanical change.

### M-5 · Analytics mix two amount columns
`main.py:982, 1077, 1116, 1151, 2035, 2258` · **violates rule 6**

`COALESCE(s.bill_amount, s.declared_value, 0)` treats a CRM bill amount and a declared value as the same quantity, at six sites. **Confirmed 2026-08-07: `bill_amount` is genuinely USD**, so `coalesce(s.value_currency, 'USD')` (`main.py:1078`) and the hardcoded `'currency': 'USD'` at `:1243`/`:1489` are correct as written — that part of this finding is resolved. What remains open is the `COALESCE` mixing itself: `bill_amount` and `declared_value` are still two different fields being summed as if interchangeable.

**Latent for now:** all 56,085 shipments have `declared_value` NULL, so no cross-column mixing is actually produced today. It activates the moment Excel manifest data brings `declared_value` in.

The dedicated endpoints (`/analytics/values-by-currency`, `/companies/{id}/analytics`) handle this correctly, which suggests the exec path is an oversight.

### M-6 · `/companies/{id}/shipments` is unpaginated
`main.py:438` — **16.3 MB in 2.28 s** for a customer with 5,527 shipments. Sibling endpoints all cap at `Query(50, le=200)`.

Related: `/api/v1/companies` (`:154-160`) materialises all matching rows in Python and slices afterwards, so `limit`/`offset` don't reduce database work.

**Re-verified 2026-09-10: still live.** Deliberately not fixed in this pass: the frontend's `Customer360.tsx` detail page currently does its own client-side pagination assuming this endpoint returns the *entire* shipment list (`Math.ceil(filtered.length/PAGE_SIZE)`) — adding server-side `limit`/`offset` here without updating that page in the same change would silently truncate what it displays. Needs a coordinated backend+frontend change, not a one-line fix.

### M-7 · Unbounded alias creation
`crm_sync.py:23-27`

4,775 aliases across 431 companies, **1,870 on a single company**, 98% auto-created by CRM sync. `_add_alias` inserts any shipper spelling that differs from the company's normalized name — every typo and casing variant becomes permanent, with no cap or review.

Consequences: `/companies/{id}/aliases` returns 446 KB for that company, `/search` joins the table on every query, and alias matching is progressively diluted.

**Re-verified 2026-09-10: still live.** Deliberately not fixed in this pass — the right threshold/policy (similarity cutoff, per-company cap, or routing new variants to Data Quality review instead of auto-inserting) is a product decision (`qa/OPEN-QUESTIONS.md` Q8), not a mechanical fix.

### M-8 · Documentation describes features and commands that don't exist

| Claim | Source | Reality |
|---|---|---|
| `npm run typecheck` | CLAUDE.md, AGENTS.md, README.md | does not exist |
| Company master accepts `.xls`, `.csv` | README.md:81 | `.xlsx` only |
| `create_only` / `upsert_by_icris` modes | README.md, AGENTS.md | **exist nowhere in the backend** |
| "Vite proxies are not used" | CLAUDE.md | false — `vite.config.ts:42` proxies `/api` |
| "no authentication in this phase" | AGENTS.md:19 | stale — auth shipped `20260804_0010` |
| Playwright in the stack | README.md:131 | not used by the connector |
| `main.py` is "~480 lines" | AGENTS.md:23 | 2,541 |
| `App.tsx` is the entire SPA | AGENTS.md:24 | 21 separate page components |
| Backend at `localhost:8000` | README.md | `8360` in this compose setup |

`docs/` (this folder) is written against verified behaviour and supersedes those claims.

### ~~M-9 · Weight KPIs, charts, and alerts were silently zero everywhere~~ — ✅ FIXED 2026-08-07
`main.py:476-477, 765, 984, 1079, 1117, 2036, 2510, 2524`

`shipments.shipment_weight` is `NULL` for **all 56,085 rows** — it's the Excel-import field, and Excel import is disabled. But most weight computations read it directly instead of falling back to `actual_weight` (the CRM-populated field, avg 23kg, populated on 56,053/56,085 rows). Confirmed dead before the fix: total/avg weight on `/shipments/stats`, `total_weight`/`weight_by_country`/destination weights on Geography Analytics, the **Heavy Shipment alert** (87 real shipments historically exceeded 500kg, zero alerts ever fired), and the **"High Volume MAWB" alert** (picked an arbitrary MAWB via `SUM(NULL)` instead of the actual heaviest one).

**Fixed:** every location above now uses `COALESCE(shipment_weight, actual_weight[, 0])`, matching the pattern two other locations (`mawb_detail`, `/analytics/operations`) already used correctly. Verified against ground-truth SQL — `/shipments/stats` now returns `total_weight=1290757.558, avg_weight=23.014`, exact match. `/analytics/weights-by-unit` and `/companies/{id}/analytics` weights were **deliberately left alone** — `weight_unit` is also 100% NULL, so falling back to `actual_weight` there would mean assuming an unrecorded unit (the same category of fabrication as M-5's currency issue). They report correctly-empty rather than wrong.

Note: the Heavy Shipment / High Volume MAWB alerts are now computed correctly but still may not be *visible* on the Alerts page — see M-11.

### M-10 · CRM parser silently stores corrupted MAWB destination/origin values
`crm_parser.py:118-125` (`labels()`), `:129-158` (`parse_manifest_detail` header extraction)

`master_air_waybills.destination`/`.origin` contain parser artifacts, not real airport/country codes, for **52 of 3,039 MAWBs (1.7%)**. Confirmed live values: `'Total'` (×42), `'Exchange Rate: 147.16'`, `'Exchange Rate: 144.62'`, `'Exchange Rate: 137.07'`, `'Exchange Rate: 118.01'`, `'Flight No: FZ0574'`, `'DD FRANK CO LLC'`, `'SN'` (×2), `'1'` (×2) as destinations; `'TO:'` (×43), `'TO: KTM'`, `',KTM'` as origins. This fed directly into `/analytics/geography`'s `top_destinations`/`top_origins`/`trade_lanes` — **"Exchange Rate: 147.16" was shown to users as a shipping destination.**

**Root cause, confirmed via archived raw headers** (`crm_raw_manifest_headers.raw_values_json`): `labels()` pairs table cells two-at-a-time as `(label, value)`. Two distinct triggers:
1. **Dummy/placeholder MAWB numbers `277`, `217`, `227`, `1`** — near-zero exchange rates, blank fields, clearly not real air waybill numbers — account for the bulk (MAWB `277` alone: 41 corrupted records). Their header table renders without value cells for blank fields, desyncing the positional pairing (`From` captures the literal text `"TO:"`, `Flight No` captures `"From:"`).
2. A handful of isolated one-off cases on otherwise well-formed real manifests (Exchange Rate strings, `DD FRANK CO LLC`), where the destination cell contained genuinely wrong content — cause not fully determined, and the original HTML can't be recovered (not archived; `crm_snapshots` retention is 30 days and these records are 1-8 years old).

**Fixed (detection only):** `parse_manifest_detail` now checks the `From`/`TO` header values against a heuristic — starts with another field's label (`exchange rate:`, `flight no:`, `fuel surch`, `from:`, `to:`, `date:`, `mawb:`), is exactly `total`/`sn`, is purely numeric, or starts with punctuation — and appends a `ManifestDetail` warning when matched. Verified against all 25 real distinct destination/origin values in the live DB: **11/11 known-bad values flagged, 0/14 known-good values false-positived** (one exception, `DD FRANK CO LLC`, isn't catchable by this heuristic — a company name substituted for a destination has no generic detectable pattern without a maintained code list). Regression tests added: `test_crm_parser.py::test_misaligned_header_row_flags_leaked_label_as_warning`, `::test_well_formed_header_row_never_flagged`.

**Decided 2026-09-10 [verified]:** flag for manual review rather than null out. `qa/flag_historical_data_gaps.py` raised a `crm_corrupted_mawb_geo` `DataQualityIssue` against each of the 53 affected MAWBs (52 documented here plus one more that has appeared since 2026-08-06); the destination/origin values are left in place — they still distort Geography Analytics (e.g. MAWB 277's $23,590.53 across 73 shipments) until a human corrects them via the flagged review queue. The true original value for the isolated one-off cases remains unrecoverable.

### M-11 · Alerts page truncates at 100, unordered relative to relevance within severity
`main.py:2540` — `return {"alerts": alerts[:100]}`

Ground truth: **493 companies** are genuinely dormant 180+ days, plus 36 at 90+, 39 at 30+, plus 63 Strategic-Account-inactive — all `high`/`medium`/`low` severity, all competing for the same 100 slots as `info`-severity Operations alerts (Heavy Shipment, High Volume MAWB — now correctly computed per M-9). Alerts are sorted by severity before truncation (`:2538`), so with 568+ higher-severity candidates, **no `info`-severity alert can ever appear** regardless of how correct its underlying computation is — confirmed live: after fixing M-9, the Alerts feed still shows only `Dormant (180+ days)` and `Strategic Account Inactive`, zero Operations alerts, purely because of this cap.

Separately, 347 companies that have **never shipped at all** are excluded from dormancy alerting entirely (`if not c.last_shipment: continue`) — may be intentional (a company that's never shipped isn't "dormant"), flagged for a decision rather than treated as a bug.

### ~~M-12~~ · Case-variant destinations aren't merged in Geography Analytics — ✅ FIXED 2026-09-10
`main.py` (`dest_map`, `orig_map`, `country_map`, `trade_lanes_map`)

`HK` vs `hk` (35 MAWBs split across two buckets) and `DXB` vs `dxb` (2 MAWBs) used to appear as separate entries in `top_destinations` because grouping keyed on the raw string without case-folding. Fixed by folding every grouping key (`_fold()`, trim + uppercase) at all four affected map sites in `geography_analytics`; verified live that `top_destinations` no longer contains case-variant duplicates.

---

## Not a bug — confirmed intentional

**`companies.customer_type` was static through 2026-09-03** — no import, sync, or migration wrote it, and the project owner confirmed on 2026-08-07 that this was intentional. **That changed 2026-09-03**: the project owner asked again for a recompute rule, so it now exists — see [11-customer-segmentation.md](11-customer-segmentation.md). Tiers are `Key Account` / `Reseller` / `Large Account` / `SME` / `Small Customer`, driven by AE assignment (RT/AJ, DN) and a company's peak-revenue calendar month, applied via an admin-triggered endpoint. If you're reading this expecting the old static behavior, it's gone — check the linked doc before assuming `customer_type` is untouched by any code path.

---

## Minor

| # | Issue | Location |
|---|---|---|
| ~~D-1~~ | ✅ FIXED 2026-08-07 — `/companies?q=` now strips and LIKE-escapes `q`. Padded/mixed-case ICRIS (`"  8x05v9  "`) verified live to return the correct company | `main.py:129` |
| ~~D-2~~ | ✅ FIXED 2026-08-07 — `/search` rank comparisons now use `normalize_icris()` (trim + NFKC + case) instead of raw `.casefold()`, and a guaranteed exact-ICRIS lookup (mirroring `crm_sync.exact_company`) is prepended so an exact match can never be missed or buried below the `limit` cutoff | `main.py:742-793` |
| D-3 | CRM Sync diagnose panel silently empty — `api.getDiagnoseData` undefined but guarded | `CrmSync.tsx:42` |
| D-4 | Two unresolvable module imports (build-only, dead code) | `chart-loading-label.tsx:5`, `live-sales-dashboard.tsx:3` |
| ~~D-5~~ | Was "seven routes are empty stubs". ✅ `Profitability` and `Rankings` built out 2026-08-11/12 (P&L, per-customer/per-route profitability, leaderboards). Still stubs: `ManifestImports`, `admin/*` — no backend exists for user/role management |
| D-6 | Import-manifest parser fabricates `Dim wt='0'`, `Tarriff Rate='0'`, `Pcs='1'` | `crm_parser.py:240-247` |
| D-7 | `/search` sums PP + FC + FD weight | `main.py:790` |
| D-8 | Dead manifest-import code can null a CRM-derived company link if re-enabled | `imports.py:63` |
| D-9 | Cookie `secure=false`, no expiry, logout can't revoke | `main.py:63-70`, `auth.py:84` |
| D-10 | `<title>frontend_new</title>` scaffold title; `vw_manifest_import_quality` always empty | `index.html` |
| ~~D-11~~ | ✅ FIXED 2026-09-10 — `prev_billing_trend` now gets the same `round(...,2)` pass `billing_trend` already had | `main.py` |
| ~~D-15~~ | ✅ FIXED 2026-09-10 — Operations Analytics `monthly_operations[].growth_pct` was hardcoded `0.0` for every month, presented as a computed figure. Now computed month-over-month from the same sorted monthly series (`calc_pop`); first month in any window still reports `0.0` since there's no prior month in scope, not because growth is unknown | `main.py` |
| ~~D-12~~ | ✅ FIXED 2026-08-10 — `CRM_SCHEDULE_CRON` was `"0 18,21 * * *"`, intended as 6pm/9pm, but the matcher compares against the container's OS clock (UTC), not Nepal time (NPT, UTC+5:45) — it was actually firing at 11:45pm/2:45am NPT. Changed to `"15 8,14 * * *"` (2pm/8pm NPT) and documented the UTC requirement in `.env`/`.env.example` and `docs/04-crm-sync.md` and `docs/09-development.md` so the next change doesn't repeat this | `.env`, `crm_worker.py:207` |
| ~~D-13~~ | ✅ FIXED 2026-08-10 — `link_icris`'s auto-resolve path (clears `crm_blank_icris`/`crm_invalid_icris` when a later sync fills in the ICRIS) set `status='resolved'` but never `resolved_at`, unlike the manual and bulk resolve API paths. 349 already-resolved issues had a null timestamp — no way to measure how long an issue took to clear | `crm_sync.py:50` |
| D-14 | **CRM-side, not fixable here.** `S_MenifestPrevUPS.aspx` (per-shipment UPS P&L detail) throws a genuine server-side .NET crash — `Object cannot be cast from DBNull to other types` (HTTP 500) — on individual old records where some field the page doesn't null-check is blank. Confirmed on **every** record for Sep–Dec 2023 (81/81 manifests) and **19 of 20** in Jan 2022 [verified 2026-08-12]. Not confined to one contiguous window — expect it scattered across older history generally. Almost certainly why `MenifestPreview_UPSProLossTot.aspx` (the Total report) is also empty for Sep–Dec 2023. Do not keep retrying a month once it's confirmed this way; it will not recover. `Apr–May 2020` is a separate, unrelated gap — the UPS manifest **list** itself returns 0 rows there (no CRM error, just no records), plausibly a real COVID-era volume drop | `crm_connector.py`, `S_MenifestPrevUPS.aspx` |

---

## Verified working — don't re-litigate

- **Parser 17-column contract** — exactly 17 columns; `Icrisno` and `Tarriff Rate` preserved; corrected spellings **rejected**; structure changes raise rather than returning empty.
- **Manual link protection** — holds in `link_icris`, `rematch`, and `imports.py`. Only `merge_companies` bypasses.
- **Blank cells never erase** — holds in both CRM sync and Excel import.
- **Fuzzy never auto-applied** — exact name match with blank ICRIS does not link; `suggested` leaves `company_id` NULL.
- **Analytics view totals** — `vw_company_operational_summary` reconciles with 0 mismatches across 999 rows; `vw_destination_summary` sums to exactly 56,085.
- **Worker claim loop** — `FOR UPDATE SKIP LOCKED`, lease recovery, bounded backoff, per-manifest transactions, correct retryable/permanent classification.
- **`api.ts` route correctness** — all 46 call sites resolve to real backend routes.
- **Session restore on refresh** — works.
- **Cron parsing** — `"0 18,21 * * *"` parses correctly and matches only 18:00 / 21:00.
- **Alembic** — at head, no pending migrations, no drift except M-4.
- **92 backend tests pass** (was 89; +1 for M-1's shipment_date regression, +2 for M-10's parser corruption detection).
- **Executive Dashboard KPIs** — revenue, active/new/returning/reactivated counts, retention rate, ARPU, AIV, highest spender all cross-checked exactly against ground-truth SQL for both `all_time` and `this_month`. AE Performance per-AE totals sum exactly to the grand total. Company Directory revenue/shipment counts match ground truth.
- One semantic-only note, not a bug: at `timeframe=all_time`, `new_customers` and `reactivated_customers` both mechanically show 100% (652/652) — a guaranteed artifact of comparing against a period start of year 2000, not a reflection of the data.

---

## Suggested order of work

1. ~~**M-1**~~ — ✅ done 2026-08-06.
2. ~~**M-9**~~ — ✅ done 2026-08-07 (weight fallback across all analytics/alerts).
3. ~~**M-10**~~ — ✅ detection done 2026-08-07 (parser now flags corrupted headers going forward). Cleanup of the 52 existing bad rows still needs a decision — see `qa/OPEN-QUESTIONS.md`.
4. **B-1 + B-2 together** — apply `require_role`/`get_current_user` to routes and make startup fail when `AUTH_SECRET` is unset. They share a fix surface and are the only items with a security impact.
5. **B-3/B-4** — get the build green and add a `typecheck` script. Until this is done, no frontend change can be deployed.
6. **M-11** — the Alerts truncation now also hides the correctly-computed weight-based alerts from M-9. Needs a decision: raise the cap, paginate, or budget slots per category.
7. **M-2** — key on `source_id:target_id`, and consider making merge archival with an audit entry.
8. **M-3** — add `getShipment` to `api.ts`.
9. **M-6, M-7, M-12** — pagination, an alias cap, and case-fold destination grouping; all load-bearing as data grows.
10. **M-5** — currency question answered 2026-08-06: `bill_amount` is USD, so the `'USD'` labelling is correct. What remains is the `COALESCE(bill_amount, declared_value, 0)` mixing at six sites — still wrong in principle, still latent while `declared_value` is entirely NULL.

`companies.customer_type` is confirmed intentional (see above) — not on this list.

Remaining items in `qa/OPEN-QUESTIONS.md` need a human decision before they can be actioned.
