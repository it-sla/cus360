# Session Handover — Customer 360

**Date:** 2026-09-01
**Scope:** AWB/MAWB detail + filter polish → password-setup/bulk-user creation → gamified AE Leaderboard (incl. pipeline Wins) → deploy pipeline fixes → local dev port-conflict fix → a deep dive into ICRIS-linked revenue accuracy that turned into a full Data Quality rework (30-day accounting buffer, a new "not in customer master" category, and a Resolution Log). Everything in this doc is **local only** unless explicitly marked deployed — check before assuming production matches local.

---

## 1. What's actually deployed vs. not

**Deployed to `shangrila002` (via the earlier part of this session):**
- Password setup / bulk user creation feature (migration `a4d8f2c91b03`)
- Leaderboard feature (`/leaderboard` endpoint + `/app/leaderboard` page, including Wins)
- The clipboard-copy fix for setup links (insecure-context fallback)
- `crm-scraper` and `backend` both rebuilt at that point

**NOT deployed — everything from here down in this doc:**
- All AWB/MAWB UI changes (status filter removal, weight fix, timeline removal, package/activity removal, search fix, MAWB airline dropdown, MAWB header/refresh cleanup)
- Customer Analytics Retention Rate removal
- The entire Data Quality rework (migration `b7f3c1a92e44`, unified buffer, new issue type, Resolution Log)
- Local `docker-compose.yml` port changes (db → 5433, pgadmin → 5051) — **local-only, do not carry this into the remote `.env`/compose**, the remote server doesn't have the same port conflict

If picking this up fresh: run the standard deploy pipeline (tar-over-ssh, documented in `handoversession.md` §1) for everything below before assuming it's live. Two real migrations are pending on the remote server (`a4d8f2c91b03` was deployed; `b7f3c1a92e44` — the `resolved_by` column — was **not**).

---

## 2. AWB / MAWB page work

All verified live in-browser with real data (not just type-checked).

**Air Waybills (`AirWaybills.tsx`):**
- Date filter swapped for the shared `DateRangeControl` popover (Quick Ranges / Calendar Period / By Year / All History / Custom) — same component now used everywhere. **Fixed a real timezone bug in the process**: the shared date-resolution helpers (`AnalyticsFilterBar.tsx`) used `toISOString()`, which silently shifts dates back a day for any timezone ahead of UTC (Nepal is UTC+5:45). Now uses local calendar-date components. This bug affected every page already using `DateRangeControl` (Executive Overview, Business Analytics, Geography, Operations, Customer Analytics, AE Performance) — not just AWB/MAWB.
- Removed the Status filter dropdown entirely (per request).
- **Real weight-display bug found and fixed**: every single shipment (56,604/56,604, confirmed via direct DB query) has `shipment_weight = NULL` — all real weight data lives in `actual_weight` instead. The list column and detail drawer only ever read `shipment_weight`, so weight showed "—" for literally every row even though the backend's weight *filter* was already correctly reading both fields via `coalesce()`. Now both display paths use the same coalesce logic as the filter.
- Removed the fake hardcoded "Cathay Cargo / RA-401" carrier text from the drawer (there's no real carrier field on `Shipment` — it was fabricated placeholder text). Replaced with real Weight + Pieces fields.
- Removed "Shipment Progress Timeline" from the drawer — it was never real tracking data, just a hardcoded guess (`matched` → stage 6, else stage 3).
- Removed "Package Manifest" and "Audit & Activity History" sections from the drawer (per request) — their `useQuery` calls removed too.
- **Search accuracy bug found and fixed**: the search box placeholder promised "Search AWB Number, Customer, Destination, Airline..." but the backend's `q` filter only ever matched `shipment_number`/`package_id`. Customer name, shipper, destination, and airline were never actually searched. Fixed in `main.py` (both `/shipments` list and `/shipments/stats`, which had the identical bug) to match linked company name, shipper/importer name, origin/destination country, and airline (via the shipment's MAWB flight number).

**Master Air Waybills (`MasterAirWaybills.tsx`):**
- Same `DateRangeControl` swap as AWB.
- Removed Origin/Destination free-text filters.
- Replaced the free-text "Flight No..." input with an **Airlines dropdown** built from the real flight-number prefixes found in the data (queried directly): `G9` Air Arabia, `KA` Cathay Dragon, `RA` Nepal Airlines, `FZ` flydubai, `TG` Thai Airways, `CX` Cathay Pacific Cargo — matches the "Airline Name (CODE)" label style already used elsewhere in the app (MAWB detail's `carrier_names` dict). No backend change needed — existing `flight_number` filter already does substring match.
- Removed the "Refresh" button and the boxed blue-icon header badge — replaced with a plain black/white plane icon (was flagged as looking "AI-generated").

**Customer Analytics (`CustomerAnalytics.tsx`):**
- Removed the "Retention Rate" KPI card (it had already been removed once per `handover.md` §3, but was apparently back — this time removed the underlying computation too, not just the card). KPI grid changed from 6 to 5 columns.

---

## 3. Password setup / bulk user creation (deployed)

Full design lives in the conversation history, not written up separately here since it's already live. Quick summary for context:
- New migration `a4d8f2c91b03`: `User.password_hash` now nullable, plus `must_change_password`, `setup_token_hash`, `setup_token_expires_at`.
- `POST /auth/set-password` (public) — the only place a user's own password ever gets set.
- `POST /admin/users` (single) and `POST /admin/users/bulk` (up to 200 rows) both create users with **no password** — return a one-time setup link instead.
- `POST /admin/users/{id}/setup-link` regenerates a link for lost-link or forgot-password cases.
- Frontend: new `/set-password` page, Users admin page rebuilt around this (no password field anywhere in the admin UI anymore).
- **Known deploy gotcha already fixed**: `FRONTEND_BASE_URL` needed to be set explicitly on the remote server's `.env` (currently `http://192.168.101.244:3600`) or setup links point at `localhost:5173` and are useless. **Update this again** once the `customer360.shangrilatours.com.np` subdomain (see §6) is actually live — that's the better long-term value for this setting.
- **Clipboard fix (deployed)**: the "Copy" button on setup links used `navigator.clipboard`, which requires a secure context (HTTPS or localhost) — silently did nothing on the plain-HTTP `192.168.101.244:3600` origin the app is actually served from. Fixed with an `execCommand('copy')` fallback.

---

## 4. Leaderboard feature (deployed)

- New `GET /leaderboard` endpoint — deliberately **unscoped** (no `get_ae_scope`, no `require_role`) so every role sees the identical board, unlike every other AE-facing endpoint.
- Ranks AEs by Revenue / Shipments / Weight / **Wins** (pipeline items with a non-blank, non-"loss" `win_loss` — currently mostly 0 across the board since the CRM has essentially never sent an explicit "Win" value; that's real data, not a bug).
- New `/app/leaderboard` page, visible to all roles, reuses the existing `LeaderboardRankings` component (podium + ranked list).
- **Real bug caught during testing**: ranking a metric where everyone is tied at 0 (like Wins today) would crown a fake "#1" — fixed by showing "—" instead of a rank number for any metric where that entry's own value is genuinely 0, and showing a proper empty state instead of a podium when *no one* has a nonzero value on the active metric.

---

## 5. Local dev environment fix

`docker compose up -d` was failing locally on two **pre-existing** port conflicts with an unrelated project on this machine (`ratecalculator-postgres` / `ratecalculator-pgadmin`, both fighting over `5432`/`5050`). Fixed by moving Customer 360's `db` and `pgadmin` host ports to `5433`/`5051` in `docker-compose.yml`. This only affects direct host-machine access (native `psql`, pgAdmin-outside-docker) — internal container-to-container traffic (backend/pgadmin → `db:5432`) uses the Docker network hostname, unaffected.

**Do not carry this port change into the remote server's config** — it doesn't have this conflict.

Local URLs after the fix: Frontend `:5173`, built frontend `:3600`, Backend `:8360/docs`, pgAdmin `:5051` (was `:5050`).

---

## 6. The `customer360.shangrilatours.com.np` subdomain (blocked, not done)

User wants the app reachable at `https://customer360.shangrilatours.com.np` instead of `http://192.168.101.244:3600`, because some locked-down office laptops block non-standard ports outbound and this is a real, wildcard-cert-covered domain already used the same way for 11 other internal tools (`esrc`, `crm`, `upssales`, etc. — all proxy through the same host nginx to different internal ports).

**Two blockers, neither resolved:**
1. **DNS**: `*.shangrilatours.com.np` is **not** a wildcard DNS record — each subdomain has its own individual A record. `customer360` has no DNS record yet. Confirmed via `nslookup` — it doesn't resolve, same as any made-up string would. Someone needs to add an A record: `customer360` → `110.44.121.225` (same IP every other subdomain uses) wherever that domain's DNS is managed. **User doesn't have access to this** — unclear who does; whoever set up `esrc`/`crm`/etc. would.
2. **Server config + sudo**: the exact nginx config block to add is already written (matches the existing 11-subdomain pattern in `/etc/nginx/sites-available/shangrilatours` on `shangrila002`, proxying to `127.0.0.1:3600`). I don't have passwordless sudo on that server, so I can't run `nginx -t` / `systemctl reload nginx` myself. The commands are ready to hand to whoever does have the sudo password.

**Once both are resolved**, also update `FRONTEND_BASE_URL` on the remote `.env` to `https://customer360.shangrilatours.com.np` so new-user setup links use it.

---

## 7. Data Quality — the big one this session

Started from a simple question ("is this $63 revenue tracked?") and turned into a full audit + rework. Read the conversation for the full reasoning; summary of what changed:

### Findings (real data, confirmed via direct queries)
- **6,935 shipments** are unlinked to any customer (**$178,482.69** in tracked-but-orphaned revenue) — split between placeholder ICRIS (4,364 shipments, $75,611.19) and truly blank ICRIS (2,571 shipments, $102,871.50).
- **FC (Freight Collect) shipments** are ~10x more likely to have no usable ICRIS than PP (53.7% vs 5.1%) — confirmed as mostly-expected (96.8% of FC shipments genuinely bill $0 to us), but **not entirely**: 233 FC shipments ($76,332.75) do have a real bill amount and are just as much a problem as PP gaps.
- **PP (the real business, $11M total) has ~$149K in orphaned revenue** across blank ($86,219.44) and placeholder ($63,168.83) ICRIS — this is the number that actually matters.
- Of the blank-ICRIS PP revenue specifically, **94% is older than 60 days and has never resolved** despite many sync cycles — confirming the "self-resolves automatically" framing on the old Data Quality page was misleading for the vast majority of that bucket.
- User's own accounting-team answer: **30 days is the real buffer window** (not the 60-day guess used earlier in the session) — accounts needs that long to bill a shipment before CRM sync would even have a chance to fill in the ICRIS.

### What got built (backend)
- **New migration `b7f3c1a92e44`**: `DataQualityIssue.resolved_by` column (`'crm_sync'` / `'company_master_import'` for automatic resolutions, or the admin's email for manual ones). Previously both cases collapsed into `status='resolved'` with no way to tell which happened.
- **`ICRIS_BUFFER_DAYS = 30`** (in `main.py`), replacing the earlier 60-day `BLANK_ICRIS_STALE_DAYS` guess — now applies to **both** `crm_invalid_icris` and `crm_blank_icris`, not just blank.
- **New issue type `crm_icris_not_in_master`**: raised in `crm_sync.py`'s `link_icris()` at the exact point a provisional company gets created for a well-formed-but-unmatched ICRIS — this used to happen completely silently. Auto-resolves in `company_imports.py` when that provisional company gets promoted via a company-master import. Deliberately **excluded** from the 30-day buffer — it's waiting on a master-list import, not on accounting.
- `/data-quality/summary` now returns `icris_buffer_age` (pending/stuck + revenue at risk, covering both buffer types combined) and `icris_not_in_master_open`.
- `/data-quality/issues` gained `icris_buffer_state` (pending/stuck, generalized from the old blank-only `blank_icris_state`) and `sort=revenue` params — both computed and sorted in raw SQL (joined to `shipments`), not paginated in Python.
- **New `/data-quality/resolution-log` endpoint**: before/after view of resolved issues. No new table — "before" is what the issue already captured at creation time (`source_icris_number`/`source_company_name`, never mutated), "after" is a live join to the shipment's/company's current real state.
- `patch_quality` and `bulk_patch_quality` now stamp `resolved_by` with the acting admin's email.

### What got built (frontend, `DataQuality.tsx`)
- The two separate priority cards from earlier in the session (ICRIS Number Mismatch + Blank ICRIS Stuck) **merged into one**: "ICRIS Issues — Stuck >30 Days" — click it to jump to that filtered, revenue-sorted view.
- New **"Pending Master List"** tab (4th tab) for `crm_icris_not_in_master` — framed explicitly as "not an error," with its own review/resolve/ignore actions.
- New **"Resolution Log"** tab (5th... well, 4th distinct new one) — before/after table, filterable by issue type / resolved-by / date window, with a "days to resolve" column.
- Per-row "stuck >30d" / "pending" badges, and a Revenue at Risk column with a standalone sort toggle usable on any filter combination.

### Verified live (real production data)
- Unified card: **11,423 open issues, $254,146 at risk**.
- Clicking it correctly filters + sorts (confirmed descending: $2,829 → $2,829 → $2,324...).
- Resolution Log correctly shows real before→after pairs (e.g. "SPEEDEX EXPRESS" blank-ICRIS placeholder name → "Shangri La Tours - RI, A2Y500" real linked company, resolved in 5 days).
- Pending Master List correctly empty right now (0) — the new issue type only fires going forward on new syncs, confirmed via passing unit tests that it fires/resolves correctly.
- **One thing to know**: `resolved_by` is a brand-new column — all 297 historically-resolved issues (last 30 days) show blank/"—" for it, since there's no way to retroactively know how they were resolved. Only resolutions from this point forward will populate it. Don't mistake "0 auto-resolved" in the log right now for the feature being broken — it's just that no *new* resolution has happened since the migration ran.

### Tests
9 new tests across `test_data_quality_icris_buffer.py`, `test_crm_sync.py`, `test_company_master_import.py`. **148/148 total backend suite passing.**

---

## 8. Where to pick up

1. **Deploy everything in §2 and §7** (nothing there is live yet) — standard tar-over-ssh pipeline, remember `crm-scraper` needs rebuilding too (shares the backend image, easy to forget — bit us earlier this session).
2. **`customer360.shangrilatours.com.np`** (§6) is blocked on someone else — find who manages `shangrilatours.com.np` DNS and who has the `shangrila002` sudo password. Both are needed; neither is optional.
3. Once that subdomain is live, update `FRONTEND_BASE_URL` on the remote `.env`.
4. The FC-shipments-with-real-revenue nuance (§7, 233 shipments / $76,332.75) isn't specifically surfaced anywhere yet — the current Data Quality rework treats FC and PP identically under the same 30-day buffer, which is fine, but if anyone wants FC deprioritized relative to PP specifically (since it's usually genuinely low-stakes), that'd be a filter/sort addition, not built here.
5. Nothing else known-broken or half-finished from this session — everything above was verified live before being called done.
