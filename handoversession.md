# Session Handover — Customer 360

**Date:** 2026-08-24
**Scope:** UX review → deployment pipeline setup → a long run of feature work on Rankings, Profitability, Alerts, MAWB matching. All changes below are in the working tree; deployment status per feature is noted individually.

---

## 1. Deployment pipeline (established this session)

No CI/CD exists. Deploys are manual, via `scripts/remote-compose.sh` and direct `ssh`/`tar` (rsync isn't available in this shell, so tar-over-ssh is used instead — see below).

**Target server:** `shangrila002@100.94.204.57`, directory `customer360-dev`, git repo: none (plain rsync/tar of the tree).

**Standard deploy sequence used all session:**
```bash
# 1. Type-check + build locally
cd frontend && npx tsc -b --noEmit && npm run build

# 2. Copy dist out of the Docker bind-mount (mounted dist/ locks files — copy first)
rm -rf /tmp/dist-copy && mkdir -p /tmp/dist-copy
cp -r frontend/dist/. /tmp/dist-copy/
tar czf /tmp/c360-dist.tgz -C /tmp/dist-copy .

# 3. Archive + sync source (excludes .git .env .venv venv node_modules frontend/dist
#    __pycache__ .pytest_cache crm-session crm-snapshots storage-state.json)
tar czf /tmp/c360-sync.tgz --exclude=... .
cat /tmp/c360-sync.tgz | ssh shangrila002@100.94.204.57 "tar xzf - -C customer360-dev"

# 4. Clear + replace remote dist/assets (old assets are root-owned from a container —
#    must clear via a throwaway alpine container, not directly)
ssh shangrila002@100.94.204.57 "docker run --rm -v /home/shangrila002/customer360-dev/frontend/dist:/d alpine rm -rf /d/assets"
cat /tmp/c360-dist.tgz | ssh shangrila002@100.94.204.57 "tar xzf - -C customer360-dev/frontend/dist"

# 5. Rebuild + restart backend (picks up main.py changes; no --reload on the server)
ssh shangrila002@100.94.204.57 "cd customer360-dev && docker compose -f docker-compose.yml -f docker-compose.remote.yml up -d --build backend"

# 6. Verify against the ACTUAL SERVER, not localhost — tunnel on a port that isn't
#    already used by the local stack (local web container also listens on 3600!)
ssh -f -N -L 3611:127.0.0.1:3600 shangrila002@100.94.204.57
curl http://127.0.0.1:3611/...
```

**Known deploy gotchas (all hit and fixed this session, documented so they don't recur):**
- `rsync` is not installed in this shell — use tar-over-ssh (`scripts/remote-compose.sh` calls rsync directly and will fail here).
- Local `docker-compose.yml`'s excludes list was missing `venv/` (only had `.venv/`) — a stray Windows venv got shipped to the server once; now excluded in both the manual tar command and `scripts/remote-compose.sh`.
- Root-owned `dist/assets/` from a prior container-driven build blocks `tar` extraction — always clear via a throwaway `alpine` container first, never `rm -rf` from the SSH user directly.
- **The local stack's `web` container also publishes host port 3600** — a tunnel to the *server's* 3600 will silently bind to nothing useful if you reuse port 3600 locally too. Use a distinct local port (3610, 3611, etc.) and always verify with `curl`/browser against that tunnel, not bare `localhost:3600`.
- Backend runs `uvicorn --reload` locally but NOT on the server (`docker-compose.remote.yml` overrides the command) — any file sync to the server requires an explicit `docker compose up -d --build backend` restart; it will not pick up changes on its own.
- Frontend dev container has its own `node_modules` Docker volume, separate from the host — installing a new npm package (e.g. `xlsx`) requires `docker exec customer360-frontend-1 npm install <pkg>` *and* a container restart to clear Vite's dep-optimization cache, not just a host-side `npm install`.

**Current deployed state:** last full deploy was mid-session (role-gated Profitability + first Rankings tabs + custom-timeframe fix + sync-button removal). **Everything after that — the "Show 10/25/50/100" data-limit fix, the Alerts KPI-card removal, and the CRM "Re-check" feature — has NOT been deployed yet.** Confirm before assuming production matches local.

---

## 2. Local dev environment note

Docker Desktop was found reset at one point mid-session. Two non-standard things are currently true locally, worth knowing if the stack looks odd:

- **`customer360-db-1` was recreated by hand**, NOT via `docker compose up`, because the normal recreate path collided with an unrelated `cargo360-db` container also binding host port 5432. It was started with `docker run --network customer360_default --network-alias db ...` (no host port published) so it resolves via the compose network's DNS alias `db` exactly as the backend expects, without touching the other project's port. **If you run `docker compose up -d` on this project again, it may try to recreate `db` and hit the same port conflict** — prefer `docker start customer360-backend-1` etc. over a blanket `docker compose up -d` until this is reconciled properly (or `cargo360-db` is stopped/reconfigured, which is a separate project — not done here).
- Local Postgres data volume (`customer360_postgres_data`) is intact throughout — no data was lost, only container lifecycle was affected.

---

## 3. Feature work this session (chronological)

### UX review → navigation fixes
Full UX audit (`qa/UX-SYSTEM-FLOW.md`) covering all 20 routes, then fixed the top 5 findings: labeled the Customer 360 back button + added a breadcrumb, clarified the Alerts sidebar badge (critical-only, not total), resolved the AE Assignment/Targets/Performance naming collision, aligned the Revenue Analytics page heading with its sidebar label, and added an "Advanced" tag + plain-English blurb to CRM Sync's ops-console styling.

### TypeScript build fixed (165 → 0 errors)
`npm run build` was completely broken (no bundle produced). Fixed all real type errors (stale API types, a broken relative import, an unused-import sweep across ~30 files) and deleted 4 dead component-library demo files that were never wired up. Build now produces a real production bundle; `npm run typecheck` script added (was cited in docs but didn't exist).

### Production deploy pipeline stood up
First-ever deploy to `shangrila002:3600`. Discovered and dealt with a pre-existing, undocumented Postgres volume with July data from an earlier abandoned deploy attempt (asked the user; resolved by treating the fresh sync as authoritative rather than merging).

### Role-based Profitability (admin-only)
Backend: `require_role('admin')` added to 5 routes (`customer-profitability`, `mawbs/pnl-summary`, `mawbs/pnl-trend`, `mawbs/pnl-routes`, `crm-sync/pnl`, `crm-sync/ups-pnl`) — this is the **first route in the app with backend-enforced role checks**; everything else admin-gated is still frontend-only (`RequireAdmin` wrapper), a pre-existing gap (see `docs/10-known-issues.md` B-1). Frontend: `RequireAdmin` wraps the `/app/profitability` route, sidebar item hidden for non-admins. Verified 403 on direct API calls as a non-admin, 200 as admin.

### Rankings page — new tabs, full "export all," page-size fix
- Added **Excel export** (`xlsx`/SheetJS, real `.xlsx` not CSV) per-tab.
- Added **Top Destinations** tab (backend: new `destinations_limit` param on the geography endpoint, previously hardcoded to 20).
- Added **Customers by Country** tab (backend: `customers_by_country` was missing `shipments`/`weight` fields even though the underlying data already had them — added).
- Export widened to fetch the *complete* ranked list (not just the on-screen top 15) for every tab — required raising backend `limit` ceilings (`top-customers` 50→2000, `pnl-routes` 25→1000).
- **Bug found & fixed:** the on-screen "Show 10/25/50/100" selector on Top Customers / Top AEs was non-functional — the page only ever fetched 15 rows client-side, so selecting 50 or 100 had nothing more to reveal. Fixed by raising the customers fetch limit to 100 and removing a client-side `.slice(0, 15)` on the AE list.
- **Real bug found & fixed:** custom date ranges on Rankings *and* Profitability were silently ignored. `tfParams` built `{ date_from, date_to }` for custom mode but dropped the `timeframe: 'custom'` key — every backend endpoint defaults `timeframe` when it's absent, so the custom dates were sent but never used; the page quietly fell back to its default period while the header *displayed* the dates the user actually picked (since that label doesn't read from the resolved bounds in custom mode). This affected real data, not just display — worth knowing if anyone questions a report pulled with a custom range before this fix.

### Sync buttons removed from Pipeline & Profitability
Per explicit request — sync is now CRM Sync page only. Removed `Sync now` (Pipeline) and `Sync from CRM` (Profitability) buttons and their mutations; empty-state messages now link to `/app/sync` instead.

### Customer 360 → Shipments tab sorted by date
Now sorts descending by `shipment_date` (was unsorted / whatever order the backend returned). Undated rows sink to the bottom.

### Alerts page simplified
Removed all 5 KPI cards (Active Alerts, Critical/High, Revenue at Risk, Pipeline Overdue, Dormant Accounts) — they duplicated filter controls already present as pills below them. Removed the now-orphaned `overdueQuery` API call (one fewer request per page load). Added a plain alert-count line and a "Clear filters" button (only shown when a filter is active) to replace the reset-all affordance the KPI cards used to provide.

### CRM matching investigation → "Re-check CRM" feature
User reported ICRIS numbers showing as missing in-app despite being present in the live CRM. **Root cause confirmed:** the scheduled sync only revisits manifests inside a 7-day lookback window, and the existing `rematch()` maintenance function explicitly skips shipments with a currently-blank stored ICRIS (and even for ones it does touch, re-matches against the stale locally-stored value rather than the CRM). So a correction made in the CRM after the fact is never picked up automatically. Fixed via a new **"Re-check CRM" button** on the Master Air Waybills detail drawer — re-fetches that manifest live from the CRM (`force_reparse=true`, bypasses the checksum-skip), polls the sync-run status, and reports an accurate summary. No new backend endpoint was needed — reused an existing but previously-unwired-in-the-UI endpoint (`POST /crm-sync/export/{id}`). **Verified against the live CRM** (this environment has real network access to it) — confirmed it correctly bypasses the checksum skip and re-links rows.

---

## 4. Known issues / things to watch

- **Everything after the mid-session deploy checkpoint is undeployed** (see §1). Deploy before assuming these are live: Show-dropdown fix, Alerts simplification, Re-check CRM feature.
- **`docker-compose.remote.yml`'s `db` and other services still publish to `127.0.0.1` on the server** — fine, tunnel-only access, no change needed.
- **The API is still effectively unauthenticated for every route except the 5 Profitability ones** — `require_role` exists and works (proven this session) but isn't applied anywhere else. `AUTH_SECRET` is still unset in `.env` (insecure default signing key). Pre-existing, not touched this session beyond the one deliberate exception.
- **`npm run build` chunk-size warning** — single JS bundle is ~2.2–2.5MB, over Vite's 500kB warning threshold. Not an error, build succeeds, just flagged as future code-splitting opportunity.
- Local `db` container is hand-run outside compose (see §2) — worth reconciling properly at some point (either stop/move `cargo360-db` off 5432, or add a port override for this project).

---

## 5. Where to pick up

Natural next steps, not started:
- Deploy the undeployed changes (§1/§4).
- Consider whether other admin-gated pages (CRM Sync, Data Quality, Matching Review, Customer Management, AE Assignment/Targets) should get the same backend `require_role('admin')` treatment now that the pattern's proven — currently only Profitability has it.
- The "Re-check CRM" feature is per-manifest/on-demand only, by explicit user choice over a scheduled background sweep — revisit if late CRM corrections turn out to be common enough to need automation.
