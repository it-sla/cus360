# Data Rules

**This is the most important file in the repo.** These invariants encode how the business actually works. Breaking one silently corrupts customer data in ways that are hard to detect and harder to unwind.

Each rule below records **where it is enforced** and **whether it currently holds**. Verdicts marked [verified] were tested on 2026-08-06 by exercising the real code against the live schema inside a rolled-back transaction (`qa/test_data_rules.py`, 16/17 passing).

---

## 1. ICRIS is the customer identity

ICRIS is unique, case-insensitive, and trimmed. UUIDs are internal keys and are never the customer identity.

**Enforced by** `utils.normalize_icris` (`utils.py:7`) — NFKC-normalises, strips whitespace and zero-width characters, uppercases. Note it **does not** delete internal characters; `.7427X8` is a legitimate ICRIS.

**Lookup** `crm_sync.exact_company` (`crm_sync.py:13`):
```sql
WHERE upper(trim(icris_number)) = <normalized>
```

**Verdict: holds** [verified] — both the authoritative sync path and the two UI search endpoints.

**Fixed 2026-08-07.** Both UI search endpoints used to ignore trimming:
- `main.py:129` — `/companies?q=` built `f'%{q}%'` without `.strip()`. `q='  R11241  '` returned 0 results.
- `main.py:742-793` — `/search` stripped for the `LIKE` but compared the exact-match rank against untrimmed, non-`normalize_icris`'d `q`, so a padded ICRIS dropped from rank 1 to rank 7.

Both now use `q.strip()` plus `utils.escape_like()` (new — escapes `%`, `_`, `\` so a literal ICRIS never gets misread as a LIKE pattern) for the substring search, and `normalize_icris()` — the same function `crm_sync.exact_company` uses — for the exact-match comparison, so a padded, mixed-case, unicode-variant ICRIS is treated identically everywhere. `/search` additionally now runs a guaranteed exact-ICRIS lookup (`WHERE upper(trim(icris_number)) = ...`, mirroring `crm_sync.exact_company`) and prepends it to the result set, so an exact match can never be silently dropped by the query's `LIMIT` before ranking runs.

Verified live end-to-end: pasting `"  8x05v9  "` into Customer Directory search correctly finds the company; the same string sent to `/search` ranks it #1.

---

## 2. Fuzzy matching is suggestion-only and is never auto-applied

**Enforced in three places:**

| Location | Behaviour |
|---|---|
| `crm_sync.link_icris` (`:33-37`) | Only exact ICRIS links. A blank ICRIS sets `icris_missing` and leaves `company_id` NULL — even when the shipper name exactly matches an existing company |
| `imports.py:63` | `shipment.company_id = company.id if status=='matched' else None`. A `suggested` result never sets `company_id` |
| `imports.match_company` (`:31`) | `rapidfuzz` at threshold ≥70 returns status `'suggested'`, never `'matched'` |

Fuzzy suggestions surface in Matching Review for a human to accept.

**Verdict: holds** [verified]. Test C-10 confirmed that an exact *name* match with a blank ICRIS does not link.

---

## 3. Manual links are never overwritten

Once a human links a shipment to a company, no automated process may change it.

**Enforced by** the `manually_matched or is_manually_matched` guard:

| Location | Behaviour |
|---|---|
| `crm_sync.link_icris:31` | Returns `'manual'` immediately, raises an informational `crm_manual_link_preserved` issue, changes nothing |
| `crm_sync.rematch:115` | Skips the shipment, counts it as `manual_preserved` |
| `imports.py:63` | `if not shipment.manually_matched:` gates the whole matching block |

**Verdict: holds in sync and import** [verified] — tests C-8 and C-9.

**One bypass:** `merge_companies` (`main.py:1934`) reassigns every shipment with a blanket `UPDATE shipments SET company_id = target WHERE company_id = source`, with no manual check and no audit entry. Arguably intended for a merge, but it is the one path that moves a manually-linked shipment.

---

## 4. Manual field overrides are preserved

`manual_override_fields` (JSONB list) records every field a human edited via `PATCH`. Automated writers must skip those fields.

**Enforced by** `crm_sync.py:97-102`:
```python
overrides = set(shipment.manual_override_fields or [])
for src, target in field_map.items():
    if raw[src].strip() and target not in overrides: setattr(...)
for src, target in num_map.items():
    if row['parsed'][src] is not None and target not in overrides: setattr(...)
```
and `company_imports.py:77` for `company_name`.

**Verdict: holds** [verified 2026-08-06] — test C-17 passes.

**This was violated until 2026-08-06.** `crm_sync.py:96` used to assign `shipment_date` unconditionally, one line *above* the point where `overrides` was computed, so a manually corrected date was silently replaced on every sync. Fixed by hoisting the `overrides` lookup and guarding the assignment:

```python
overrides=set(shipment.manual_override_fields or []);provenance=dict(...)
shipment.mawb_id=mawb.id;shipment.crm_source_url=source_url;...
if 'shipment_date' not in overrides:shipment.shipment_date=mawb.manifest_date
```

Both directions are now covered by `tests/test_crm_sync.py::test_manual_shipment_date_override_is_preserved_but_others_still_sync` — an overridden date survives sync, and a non-overridden one still updates from the manifest.

> `shipment_date` is the only CRM-written field with no entry in `crm_field_provenance`. Harmless, but inconsistent with every other field in `field_map`/`num_map`.

---

## 5. Blank cells never erase existing values

An empty cell in an incoming manifest or workbook means "no information", not "clear this field".

**Enforced by:**
- `crm_sync.py:98` — `if raw[src].strip() and ...` (text fields)
- `crm_sync.py:101` — `if row['parsed'][src] is not None` (numeric fields)
- `imports.py:61` — `if value is not None: setattr(...)`
- `imports.py:53` — takes the **first non-null** value across grouped rows

**Verdict: holds** [verified] — tests C-13 and C-14. A second manifest with a blank consignee and blank bill amount left both original values intact, while a non-blank shipper correctly updated.

---

## 6. PP, FC and FD totals stay separate. Never aggregate across currencies or weight units

PP / FC / FD are payment terms. They are stored in nine separate columns on `master_air_waybills` (see [02-data-model.md](02-data-model.md)).

**Enforced by** `crm_sync.py:88` — `for key, value in detail.totals.items(): setattr(mawb, key, value)`, where keys are `pp_weight`, `fc_pieces`, etc. The parser produces them as distinct keys (`crm_parser.py:170,180`).

**Correct currency/unit handling** in the dedicated endpoints:
- `main.py:847` `/analytics/values-by-currency` — `GROUP BY company_id, value_currency`
- `main.py:1592` `/companies/{id}/analytics` — groups by `value_currency` **and** `weight_unit` separately

**Verdict: holds in storage. Two violations in read paths:**

| Location | Issue | Status |
|---|---|---|
| `main.py:790` | `/search` sums `pp_weight + fc_weight + fd_weight` for MAWB metadata | Display-only, same unit. Flagged, low impact |
| `main.py:982, 1077, 1116, 1151, 2035, 2258` | `COALESCE(s.bill_amount, s.declared_value, 0)` mixes an amount with **no currency** against one that **carries** `value_currency` | **Latent** — see below |
| `main.py:1078, 1243, 1489` | `coalesce(s.value_currency, 'USD')` and hardcoded `'currency': 'USD'` | **Live now** |

**Why "latent":** all 56,085 shipments currently have `declared_value IS NULL` and `value_currency IS NULL` [verified], so the `COALESCE` never reaches `declared_value` and no cross-currency sum is actually produced today. It becomes real the moment Excel manifest data lands. The fabricated `USD`/`$` labelling, however, is wrong right now — every analytics page formats with `` `$${v}` ``.

---

## 6b. The revenue basis — which pay terms count

**Established 2026-08-07 by reconciling against the source CRM.** Revenue is `bill_amount` (the invoiced figure), **not** `gross_amount`.

The CRM totals revenue into exactly **three pay-term buckets** on every manifest footer — PP, FC, FD — and its `Rep_ManifestOption.aspx` "SP Export Report" defaults to `Pay Term = "FC & PP"`. Anything outside those buckets is not revenue to the CRM, and must not be to us.

| Pay term | Meaning | Billable? |
|---|---|---|
| `PP` | Prepaid — **shipper** (your ICRIS customer) pays | ✅ yes |
| `FC` | Freight Collect — **consignee** abroad pays | ✅ yes |
| `FD` | Free Domicile — shipper pays, incl. duties | ✅ yes |
| `NON_REV` | Non-revenue — own-account / admin shipments | ❌ no |
| `RTS` | Return to shipper | ❌ no |
| *blank / NULL* | Inferred at sync time — see below | depends on inference |
| *anything unseen* | Unknown term | ❌ no (allowlist) |

**Blank-Pay-Term inference (added 2026-08-07, supersedes the exclusion rule below the table).** The CRM's own manifest footer omits blank-term rows entirely, which is why the original rule (still described further down for history) excluded them from revenue. Per the business owner, that undercounts real revenue: a blank Pay Term with a `Bill amt` on the row means the shipment **was** billed prepaid and should count as `PP`; a blank Pay Term with no `Bill amt` means it was never billed and should count as `FC` (bills $0, so it's revenue-neutral either way but keeps the shipment consistently bucketed). `crm_sync.upsert_detail` now sets `shipment.pay_term` to the inferred value (tagging provenance as `crm_inferred`) instead of leaving it blank, and still raises `crm_missing_pay_term` so the inference stays visible for review. **This means C360 revenue will no longer match the CRM footer to the cent for months containing blank-term rows with a bill amount** — the reconciliation numbers below predate this change and need to be re-run (`qa/reconcile_revenue_vs_crm.sql`) to establish a new baseline.

**Enforced by** the single shared expression `REVENUE_AMOUNT_SQL` (`main.py`, just below the app setup):
```sql
CASE WHEN upper(trim(coalesce(s.pay_term,''))) IN ('PP','FC','FD')
     THEN coalesce(s.bill_amount, s.declared_value, 0) ELSE 0 END
```

This is an **allowlist on purpose** — a pay term nobody has seen before must default to non-revenue rather than silently inflating totals (`test_unknown_pay_term_defaults_to_non_revenue_not_revenue`).

Used by **all 8** revenue call sites (`/companies`, `/analytics/ae-performance`, executive dashboard current + previous, CLV aggregate, `/analytics/geography`, `/analytics/operations`, alerts gainer/decliner). `test_revenue_expression_is_shared_by_every_analytics_call_site` fails the build if any site hand-rolls its own formula again — this had already drifted once (`/companies` used `SUM(bill_amount)` with no `declared_value` fallback while every other site had one).

**Excluded rows remain counted as SHIPMENTS.** They are real cargo movements; only their monetary contribution is zeroed. Verified: July 2026 revenue `176,424.87 → 152,337.59` while the shipment count stayed at 821.

### Reconciliation evidence

**Baseline re-run 2026-09-10** (`qa/reconcile_revenue_vs_crm.sql`), post-inference — this supersedes the pre-inference table below, which the 2026-08-07 blank-Pay-Term change already flagged as stale.

**80 of the last 128 months match the CRM footer to the cent; whole-history gap is now +$211,998.57 (C360 over-reports).** Unlike the pre-inference gap (which was a few thousand dollars, driven almost entirely by the 9 uningested MAWBs below), the post-inference gap is large, one-directional, and growing month over month:

| Month | CRM footer | C360 revenue | Gap |
|---|---:|---:|---:|
| 2026-01 | $165,640.12 | $181,594.07 | +$15,953.95 |
| 2026-02 | $169,176.03 | $186,845.71 | +$17,669.68 |
| 2026-03 | $232,775.75 | $274,257.92 | +$41,482.17 |
| 2026-04 | $191,779.37 | $228,580.87 | +$36,801.50 |
| 2026-05 | $224,119.16 | $251,068.25 | +$26,949.09 |
| 2026-06 | $183,253.85 | $202,252.53 | +$18,998.68 |
| 2026-07 | $190,130.89 | $217,957.63 | +$27,826.74 |
| 2026-08 | $168,589.10 | $189,470.75 | +$20,881.65 |

Months before 2026-01 mostly still match exactly (the blank-Pay-Term inference only affects rows that actually have a blank term with a bill amount, and that population is concentrated in more recent months). **This growing gap needs its own decision** — it means the PP-if-bill-amount-else-FC inference is now the dominant source of reconciliation drift, larger than the two known-and-flagged gaps below combined. Whether the inference itself needs revisiting, or this divergence from the CRM footer is accepted as intentional (the CRM footer excludes blank-term rows by construction, so a permanent gap here may just be the cost of not undercounting revenue) is a business call, not something to silently "fix" by reverting the inference.

Reproduce with `qa/reconcile_revenue_vs_crm.sql`.

<details><summary>Pre-inference baseline (2026-08-06, superseded) — kept for history</summary>

Month-by-month against the CRM's own manifest footers (`master_air_waybills.pp/fc/fd_bill_amount`), **11 of the 12 most recent months matched to the cent** on this basis. Counting blank-term rows had been overstating revenue by 2–18% per month:

| Month | CRM footer | Overstatement if blank terms counted |
|---|---:|---:|
| 2026-07 | $152,337.59 | +$24,087.28 |
| 2026-05 | $224,119.16 | +$26,949.09 |
| 2026-04 | $191,779.37 | +$36,801.50 |
| 2026-03 | $232,775.75 | +$41,482.17 |

</details>

**Do not use `gross_amount` as a revenue basis.** It is the pre-discount list price (row-level: `34.51` bill vs `48.39` gross) and is populated on only ~41% of PP rows.

**Blank pay term backfill — since resolved [verified 2026-09-10].** The 926 pre-existing blank-pay-term shipments this section originally described (2019–2026, $216,495) are gone: `qa/backfill_infer_pay_term.py` has since run and applied the `PP`-if-bill-amount-else-`FC` inference to all of them (`SELECT count(*) FROM shipments WHERE pay_term IS NULL OR pay_term=''` returns 0). `qa/backfill_missing_pay_term_issues.py`'s 976 `crm_missing_pay_term` issues remain as a historical record of what was inferred, not an indicator of unresolved rows. **This retroactive backfill is almost certainly the main driver of the growing reconciliation gap in the table above** — rows that used to resolve to non-revenue under `REVENUE_AMOUNT_SQL` now count as PP/FC revenue that the CRM's own footer (which excludes blank-term rows by construction) never included.

> **Remaining known gap — flagged, not corrected [re-verified 2026-09-10, unchanged].** 9 MAWBs hold a manifest footer total but have **zero imported shipment rows**, so $32,340.50 of CRM revenue was never ingested (earliest 2018-12-15, latest 2025-12-31). Largest: `51408009945` (2025-01-08, $9,995.42), `51408015744` (2025-07-04, $8,204.73), `28505791030` (2023-07-28, $6,769.79). Three of the nine are the corrupted-header MAWBs from [10-known-issues.md](10-known-issues.md) M-10 (`1`, `277`, `217`). This makes C360 **under**-report those specific MAWBs. Each now carries an open `crm_mawb_footer_unshipped` `DataQualityIssue` (`qa/flag_historical_data_gaps.py`) for manual review — the underlying ingestion gap itself is not corrected here, per owner decision to flag rather than mutate history.

---

## 7. CRM and Excel merge only on exact trimmed tracking number

Never fuzzy-match tracking numbers. Never duplicate a shipment during enrichment.

**Enforced by** `crm_sync.normalized_tracking` (`:11`) — NFKC + strip, then an exact equality lookup:
```python
shipment = db.scalar(select(Shipment).where(Shipment.shipment_number == tracking))
```
`shipment_number` is `unique=True`, so duplication is impossible at the schema level.

**Source ownership:**

| Source | Owns |
|---|---|
| **CRM** | ICRIS, MAWB/flight, actual & dimensional weight, bill fields, final-manifest snapshots |
| **Excel** | Package Ids and grouping, addresses, description, declared value + currency, TND |

**Verdict: holds.** The parser additionally raises `DuplicateTrackingConflict` when the same tracking number appears twice within one manifest with *different* values (`crm_parser.py:211`); identical duplicates are collapsed and counted.

---

## 7b. UPS Profit/Loss matches by MAWB number only, and never creates a MAWB

`crm_sync.upsert_pnl` (`POST /crm-sync/pnl`) matches each P&L row onto an **existing** `MasterAirWaybill` by `mawb_number` — the manifest sync remains the sole source of MAWB existence, same principle as rule 7 for shipments. If no MAWB with that number exists yet, or the number matches more than one `MasterAirWaybill` (same `mawb_number`, different `manifest_date`) and none of them share the P&L row's date, the row is counted as `unmatched`/`ambiguous` in the response and **nothing is guessed or written**.

**Verdict: holds** [verified live against the production CRM 2026-08-11] — matched 22/22 real rows onto pre-synced MAWBs; a synthetic unknown MAWB number correctly counted as `unmatched` with zero rows written.

---

## 7c. A shipment billed but not yet costed by UPS has unknown profit, never zero

The per-shipment UPS grid (`S_MenifestPrevUPS.aspx`) leaves `UPS BillAmt` / `Profit/Loss` **blank**
for shipments that were billed to the customer but not yet costed by UPS. Those cells parse to
`NULL`, never `0` — writing zero would understate cost and overstate margin.

The CRM's own manifest `Total` row **excludes** these rows from its bill total, so the Total will
not equal the sum of the rows above it. [verified 2026-08-12] MAWB `16014396060`: rows sum to
`11,565.21` but the CRM Total reads `11,183.32` — a `381.89` gap accounted for exactly by two
uncosted shipments (`339.16` + `42.73`). Profit matched exactly, since neither row contributes profit.

**Therefore:**
- MAWB-level `pnl_*` figures come from the CRM's Total row (authoritative, and consistent with the
  separate `MenifestPreview_UPSProLossTot.aspx` report).
- Margin is computed over **costed shipments only**; uncosted ones are reported separately as
  `awaiting_cost_shipments` / `awaiting_cost_bill` rather than folded in.
- Do **not** "fix" the discrepancy by recomputing the MAWB total from its rows — the gap is real
  and is itself the signal (revenue booked, cost pending).

---

## 8. Provisional companies

A valid, unseen ICRIS on a manifest creates a provisional company. Repeated ICRIS values reuse it. Company-master import promotes it.

**Enforced by** `crm_sync.py:39-47` (creation, with `begin_nested()` + `IntegrityError` fallback for the race) and `company_imports.py:75` (promotion).

**Verdict: holds** [verified] — tests C-1, C-2, C-3.

Blank ICRIS never creates a company; the shipment stays valid but unlinked with `match_status='icris_missing'` (test C-5/C-6/C-7).

---

## 9. ICRIS wins over source-name differences

When a manifest row's shipper name disagrees with the official company name, **the ICRIS link stands**. Preserve the source name, raise a quality issue, and never overwrite a non-provisional official name from a manifest row.

**Enforced by** `crm_sync.py:53-54` — sets `shipment.name_mismatch = True` and raises `crm_customer_name_mismatch`, but does not touch `company.company_name`.

**Verdict: holds.** This is why there are 68,484 open name-mismatch issues [verified] — the rule is working as designed; the volume reflects how much shipper-name variance exists in the CRM data.

---

## 10. CRM integration is read-only

Never invoke CRM save/update/delete actions, never expose credentials or cookies, never guess unverified URLs or selectors.

**Enforced by:**
- `crm_connector.CrmSessionManager._validate` — host allowlist from `CRM_ALLOWED_HOSTS`
- Only `GET` and Web Forms postbacks used for navigation
- `crm_worker._summary` (`:24`) redacts `password`, `cookie`, `viewstate`, `eventvalidation` from error text before persisting
- Credentials are `SecretStr` in `core.py`, environment-only, never persisted to Postgres or returned by an API

**Verdict: holds.** Session state belongs in the `crm_session` volume, never the repository.

---

## 11. Deletion is archival

- `DELETE /companies/{id}` → `status = 'archived'` (`main.py:443`)
- `DELETE /documents/{id}` → `status = 'archived'`, file left on disk (`main.py:726`)
- Document replacement archives the old version and increments `version_number`

**Verdict: holds — with one exception.** `merge_companies` (`main.py:1942`) does `db.delete(source)`, a **hard delete** of a `companies` row. It is the only hard delete of a business entity in the codebase.

---

## 12. Source spellings are preserved exactly

The CRM's 17 column headers include the source misspellings `Icrisno` and `Tarriff Rate`. The Excel contract includes `Importer Adresse 1/2/3`. **Do not "correct" these.**

**Enforced by** `crm_parser.ROW_HEADERS` (`:11`) and a strict positional check (`:195`):
```python
if len(headers) < 17 or normalized[:17] != expected:
    raise CrmParseError('Shipment headers differ from the verified 17-column contract')
```

**Verdict: holds** [verified]. Substituting `ICRIS No` or `Tariff Rate` into a fixture is **rejected** with `crm_header_mismatch`. Raw rows are archived with the exact original headers in `crm_raw_manifest_rows.source_headers_json`.

---

## 13. Structure changes fail loudly, never silently

A changed CRM table must raise, never be treated as an empty result.

**Enforced by** the parser's exception hierarchy — `CrmParseError`, `PartialManifestError`, `EmptyManifestError`, `DuplicateTrackingConflict`, `LoginRequired` — plus `crm_worker.classify` (`:29`), which decides retryable vs permanent, and `crm_worker.py:139`:
```python
if detail.source_data_row_count != len(detail.rows) + detail.duplicate_row_count:
    raise PartialManifestError('Parsed row count does not match nonblank source rows')
```

**Verdict: holds** [verified]. A junk table raises `crm_partial_page`. A login page raises `crm_session_expired`. A zero-row manifest parses but the worker converts it to `EmptyManifestError` (`:138`).

**One blemish:** the import-direction fallback branch (`crm_parser.py:240-247`) **fabricates** values the source doesn't contain — `'Dim wt': '0'`, `'Tarriff Rate': '0'`, `Pcs` defaulting to `'1'`. That contradicts *"never invent source data"*. Currently inert because import direction is force-dry-run (`crm_worker.py:144`).

---

## 14. Transactions and schema

- Every import and each sync item is one transaction. A failing manifest never poisons a succeeding one (`crm_worker.py:141-148`).
- Schema changes go through Alembic. **Never hand-edit an existing migration.**
- Timestamps are always timezone-aware.

**Verdict: holds.** One drift exists — `crm_sync_state.entity_type` declares `unique=True` with no matching DB index [verified]. A full model-vs-database diff found no others.

---

## Quick verdict table

| # | Rule | Verdict |
|---|---|---|
| 1 | ICRIS exact, case-insensitive, trimmed | holds in authoritative path; 2 UI search endpoints don't trim |
| 2 | Fuzzy never auto-applied | **holds** |
| 3 | Manual links never overwritten | holds; `merge_companies` bypasses |
| 4 | Manual field overrides preserved | **holds** (was violated for `shipment_date`; fixed 2026-08-06) |
| 5 | Blank cells never erase | **holds** |
| 6 | PP/FC/FD and currency separation | holds in storage; violated in exec analytics (latent) + `$` labelling (live) |
| 6b | Revenue basis — NON_REV/RTS excluded, one shared expression | **holds**; blank Pay Term now inferred (PP if bill amount, else FC) rather than excluded, changed 2026-08-07 |
| 7 | Exact-tracking merge only | **holds** |
| 8 | Provisional creation / promotion | **holds** |
| 9 | ICRIS wins over name differences | **holds** |
| 10 | CRM read-only | **holds** |
| 11 | Deletion is archival | holds; `merge_companies` hard-deletes |
| 12 | Source spellings preserved | **holds** |
| 13 | Structure change fails loudly | holds; import fallback fabricates defaults |
| 14 | Transactions + Alembic | holds; one unique-constraint drift |

---

## If you are about to change matching, importing, or sync

Run the probe first, and again afterwards:

```bash
docker exec -i customer360-backend-1 python - < qa/test_data_rules.py
```

It exercises rules 1-5 and 8 against the real code inside a transaction that is always rolled back. Baseline is **17/17 passing** as of 2026-08-06. Any failure means you have broken an invariant.
