# Open Questions

Things that look wrong but I'm **under 70% sure** about — usually because the answer depends on business intent I can't read off the code. Confirmed defects are in `BUGS.md`; these are not.

---

## New as of 2026-08-07

### ~~Q13~~ — RESOLVED 2026-09-10: option 2 (flag via `DataQualityIssue`, leave value in place) — see `docs/10-known-issues.md` M-10, `qa/flag_historical_data_gaps.py`

Confirmed root cause: [`docs/10-known-issues.md`](../docs/10-known-issues.md) M-10. 52 of 3,039 MAWBs have a parser-garbage `destination`/`origin` — things like `'Exchange Rate: 147.16'` or `'Total'` instead of a real airport code. The parser now **detects and warns** on this pattern going forward, but the 52 existing rows in the database are untouched, and I can't recover their true original values — the raw CRM HTML isn't archived and `crm_snapshots` retention (30 days) expired long ago for these records (some are from 2018-2021).

Three options, not mutually exclusive:
1. **Null them out** — treat `destination`/`origin` as unknown for these 52, consistent with how blank ICRIS is handled (valid record, missing field, no fabricated value).
2. **Flag via `DataQualityIssue`** and leave the current (wrong) value in place for manual review — matches the app's existing pattern for other anomalies.
3. **Leave as-is** — they're a small fraction (1.7%).

**I checked whether the "dummy" MAWBs are actually inert — they're not, mostly.** `MAWB 1` genuinely has 0 shipments and $0 revenue (safe to ignore). But `MAWB 277` has **73 real shipments and $23,590.53 in revenue**, `217` has 4 shipments/$380.26, and `227` has 1 shipment/$58.27 — all real business activity riding on a MAWB whose header metadata happens to be corrupted. Their short, non-standard MAWB *numbers* look like test data, but the *shipments* attached to them aren't. That rules out "leave as-is because it's dummy data" as a full answer — option 3 would still leave real revenue misattributed to a garbage destination in Geography Analytics.

**Should I clean these up, and if so, which way?**

### Q14 — Should the Alerts page's 100-item cap be raised, paginated, or budgeted per category?

M-11: alerts are sorted by severity then hard-capped at 100 total. With 568+ genuine `high`/`medium`/`low` severity Customer alerts, `info`-severity Operations alerts (now correctly computing Heavy Shipment / High Volume MAWB after the M-9 fix) can never appear regardless of correctness. Options: raise the cap (simplest, doesn't scale), add real pagination to the frontend, or reserve a minimum number of slots per category so no alert type is ever fully starved. **Which direction, and roughly what cap/page-size?**

---

## Product intent

### Q1 — Is the Excel manifest import gone for good, or paused? *(~50% it's permanent)*

`imports.py` implements the full 26-column contract correctly, but nothing calls it: no route in the OpenAPI spec, `ManifestImports.tsx` makes zero API calls, and `read_file` is imported into `main.py:16` and never used. README says "disabled in both the web application and API."

This changes the priority of three findings:
- `imports.py:63` can null a CRM-derived company link (BUGS D-8) — a data-loss landmine **only if re-enabled**.
- `match_company` loads every company plus all 4,775 aliases per row group — unusable at current data volume.
- `vw_manifest_import_quality` will stay permanently empty.

**Should I treat `imports.py` as dead code to delete, or as a feature to fix before re-enabling?**

---

### Q2 — Which party is the customer on an *import* manifest? *(~40% confident it's wrong)*

`crm_parser.py:236` maps ICRIS as `Shipper Acc No` **or** `Consignee Acc. No.`, shipper first. On an export manifest the shipper is your customer. On an import manifest, intuitively the *consignee* is. If that's right, the fallback would link import shipments to the wrong party.

I can't confirm because import direction is force-dry-run (`crm_worker.py:144`) and the code even flags itself: *"Import customer party role is unverified; business linking is disabled"* (`:140`).

**Is the shipper-first precedence deliberate, or a placeholder pending verification of the import party role?**

---

### Q3 — Are the seven stub pages planned, or should they come out of the nav? *(~50%)*

`/app/imports`, `/app/profitability`, `/app/rankings`, `/app/users`, `/app/roles`, `/app/audit-logs`, `/app/settings` render only shell chrome. There are no backend endpoints for user or role management at all, yet `App.tsx:129-148` wraps them in `RequireAdmin` as if they're functional.

**Build them out, or remove them from the sidebar so the app doesn't advertise capability it lacks?** This also affects how I'd rate B-1: if user management is coming, the auth gap is on the critical path.

---

## Data semantics

### Q4 — What currency is `bill_amount`, and should the UI stop showing `$`? *(~60% that `$` is wrong)*

All 56,085 shipments have `bill_amount` populated and `value_currency` NULL. `AGENTS.md` says CRM bill amounts have no assumed currency, yet `main.py:1078` does `coalesce(s.value_currency,'USD')` and every analytics page formats with `` `$${v}` ``.

Given Shangrila is a Nepal operation, I'd guess these are NPR, which would make every "$" figure in the dashboards misleading by roughly two orders of magnitude.

**What currency are CRM bill amounts actually in?** If it's a single known currency, the fix is a labelled constant rather than removing formatting. If it's genuinely unknown, the amounts should render unlabelled.

---

### Q5 — Is summing PP + FC + FD weight acceptable? *(~50%)*

`main.py:790` adds `pp_weight + fc_weight + fd_weight` for MAWB search metadata. PP/FC/FD look like payment terms (prepaid / freight collect / freight deferred?) rather than different *units*, so a combined weight is physically meaningful — but the rule as written says keep them separate, and this is the only place they're combined.

**Is the rule about units and currencies specifically (making this fine), or about PP/FC/FD as reporting buckets that must never be merged (making it a defect)?**

---

### Q6 — Should `shipment_date` be manually overridable at all? *(~65% the fix is to honour the override)*

BUGS M-1 is confirmed: CRM sync clobbers a manual `shipment_date`. But there are two defensible fixes and they differ in intent:

1. Honour the override — add `shipment_date` to the guard at `crm_sync.py:96`. Consistent with every other field.
2. Treat `shipment_date` as CRM-owned and *reject* manual edits to it in `PATCH /shipments/{id}`, since it derives from `mawb.manifest_date`.

Today you get the worst of both: the API accepts the edit and records the override, then sync silently discards it.

**Which is intended?**

---

## Operational

### Q7 — Should company merge be a hard delete? *(~65% it shouldn't)*

`main.py:1942` does `db.delete(source)` — the only hard delete of a business entity in the codebase. Everything else soft-deletes (`status='archived'`), including `DELETE /companies/{id}` two handlers away. The merge also writes no audit record and reassigns shipments without checking `manually_matched`.

**Should merge archive the source instead of deleting it, and write an `ActivityLog` entry?** With B-1 unfixed this is an unauthenticated, unlogged, irreversible operation.

---

### Q8 — Should CRM alias auto-creation be capped? *(~55% on the right threshold)*

1,870 aliases on one company (BUGS M-7). I'm confident it's undesirable; I'm not confident what the intended behaviour is. Options: only add an alias when the name differs beyond a similarity threshold; cap per company; route new variants to Data Quality for review instead of auto-inserting; or stop auto-aliasing from CRM entirely and keep aliases manual/company-master only.

**What was `_add_alias` meant to accomplish on the CRM path?** If it's for future name matching, the current junk volume defeats it.

---

### Q9 — Two `entity_type='worker'` rows: leftovers, or is something re-creating them? *(~50%)*

BUGS M-4 confirms the missing unique index. What I can't tell is whether the duplicate is inert history (updated `2026-07-22` vs `2026-08-06` — consistent with a container restart before the constraint mattered) or whether a code path keeps inserting.

`heartbeat()` (`crm_worker.py:47`) only inserts when no row matches, so with one worker I'd expect one row. **Was there ever a period with `CRM_SYNC_MAX_CONCURRENCY > 1` or multiple worker containers?** That decides whether the migration needs a dedup step before adding the constraint.

---

### Q10 — Is the stale July 28 `dist/` actually what's in front of users? *(~60%)*

`customer360-web-1` (nginx, port 3600) serves `frontend/dist/`, built **2026-07-28** — before the 2026-08-04 auth migration. Meanwhile the compose file also runs a Vite dev server on 5173.

**Which one do people actually use?** If anyone relies on port 3600, they're on a build that predates auth entirely — and because `npm run build` now fails (B-3), that dist cannot be refreshed until the TypeScript errors are cleared.

---

### Q11 — Was `AUTH_SECRET` meant to be set on the remote host? *(~55%)*

`.env.example` documents it and `.env` omits it, so locally the hardcoded default is live (B-2). It's possible the remote `.env` — which `remote-compose.sh` deliberately never syncs — does set a real secret, making B-2 local-only.

I couldn't check without reading the remote `.env`, which I didn't do. **Does the remote `.env` set `AUTH_SECRET`?** Either way I'd suggest failing startup when it's missing, rather than defaulting.

---

## Scope check

### Q12 — Do you want the 117 unused-import errors fixed, or the tsconfig relaxed?

Of the 165 build errors, 117 are `TS6133` unused-symbol from `noUnusedLocals`/`noUnusedParameters`. Two very different fixes: clean up every file, or relax those two flags and fix only the ~48 substantive errors.

Relaxing gets the build green fastest, but `noUnusedLocals` is what surfaced `Check`/`Globe` being used-but-unimported in `AirWaybills.tsx:584,600` — a real latent `ReferenceError`. **Which way do you want to go?** I'd lean toward keeping the flags and doing the cleanup, but it's a bigger diff.
