# Session Handover — Customer 360

**Date:** 2026-09-03
**Scope:** Deployed the previous session's pending work → new Document Type (DOC) analytics page → a real data-quality bug hunt across four pages (transit-airport-vs-real-destination confusion) → a brand-new customer segmentation rule (Key Account / Reseller / Large Account / SME / Small Customer) → a Tier Shipping Gap alert + Gmail SMTP email digest built from scratch → a full Profitability page audit and fix → Alerts page redesign → a real AE-assignment data bug found and fixed on Customer/Business Analytics. Backend test suite grew from 148 → **173 passing**. Everything below is **local only** unless explicitly marked deployed.

---

## 1. What's actually deployed vs. not

**Deployed to `shangrila002` (early in this session):**
- Everything that was pending at the end of the previous session per `handover2.md` §2 and §7 — AWB/MAWB UI changes, Customer Analytics Retention Rate removal, the full Data Quality rework (migration `b7f3c1a92e44`, unified buffer, `crm_icris_not_in_master`, Resolution Log).
- Verified live: destination-country fix (`import_country` over dirty `mawb_destination`) confirmed live via the fixed `top_destinations`/`geography` logic that existed at deploy time.

**NOT deployed — everything below in this doc:**
- Document Type Analytics page (`/app/doc-type`)
- All four "transit airport vs. real destination" fixes (Geography, Rankings, Customer 360, company-analytics)
- The Customer 360 Origin-filter removal / destination-dropdown self-emptying fix
- Geography's "Top Countries by Revenue" chart removal
- **The entire customer segmentation rule** (new `customer_type` values, `customer_segments.py`, the admin recompute endpoint/button) — **this has been run against the real local database**, so local `customer_type` values are now rule-driven; the remote database still has the old static values until this ships and someone runs "Recompute Segments" there too
- Tier Shipping Gap alert + the whole Gmail SMTP email digest feature (`tier_alerts.py`, `email_notifications.py`, `crm_worker.py` scheduler hook, admin endpoint, Alerts-page button)
- Profitability page fixes (real backend `sort=margin`, margin-trend math, date-label off-by-one)
- "Jump to page" command palette removal
- Alerts page redesign (stat tiles, consolidated filters, pagination) + Pipeline/Operations category removal + SB/RTL/JS AE removal
- The Customer/Business Analytics "Unassigned" AE-filter bug fix (`assigned_ae_code` priority in `executive_dashboard`)

If picking this up fresh: standard deploy pipeline (tar-over-ssh, `handoversession.md` §1) for everything below before assuming it's live. **One new migration-free but important step**: after deploying, someone with admin access needs to click "Recompute Segments" on the remote Customer Management page — the new tier rule does nothing until it's explicitly run once (no cron/auto-trigger, deliberately — see §3).

---

## 2. Document Type (DOC) Analytics page

New page at `/app/doc-type`, sidebar under Business Analytics → "Document Type (DOC)". Sourced from `Shipment.bill_type` (CRM's own field — `Document`/`Letter` → DOC, `Non-Doc` → NON-DOC, blank → Unclassified), which existed in the DB but was never surfaced anywhere before this session.

**Went through several rounds of user feedback, final state:**
- Shows **DOC and Unclassified only** — NON-DOC was explicitly removed per request (backend still returns it, just unused by this page).
- KPI strips (not cramped nested cards) with real trend arrows (`pop_pct`), correctly suppressed at "All Time" (no real prior period to compare against).
- Trend chart (stacked by day), Top Customers by DOC Revenue, and a **Destination Countries** breakdown.
- **The destination breakdown was originally wrong** — see §3 below, this was the first instance of the transit-airport bug, since fixed.
- No pie chart (removed per request — "revenue share" was redundant with the KPI strips).

Backend: `GET /api/v1/analytics/document-type` in `main.py`.

---

## 3. The "transit airport vs. real destination" bug — fixed in 4 places

**Root cause, found once and then found again three more times:** `master_air_waybills.destination` is the flight's transit airport (e.g. `DXB`, `HKG`) and is genuinely dirty in the source data (stray garbage rows like `"Exchange Rate: 147.16"`, case-variant duplicates `HK`/`hk`). Several places prioritized this field over `shipments.import_country` (the shipment's real consignee country) when computing "destination." The fix is always the same: `coalesce(nullif(import_country,''), mawb_destination)` — import_country wins, MAWB destination is only a fallback for the rare row missing it.

**Fixed in:**
1. `document_type_analytics` (`main.py`) — the new page's own destination breakdown.
2. `geography_analytics`'s `top_destinations` (`main.py`) — backs Rankings' "Top Destinations" tab. Was showing `DXB`/`HKG` as "top destinations" instead of real countries.
3. `company_analytics` (`main.py`) — Customer 360's "Destination Distribution" chart. Same bug, same fix. Also fixed the `origin`/`destination` filter params on this endpoint to match the same field.
4. Geography's main destination charts were already correct (used `import_country` from the start) — only `top_destinations` on that same endpoint had the bug.

**Not fixed at the source** — `master_air_waybills.destination`'s underlying data quality (the "Exchange Rate: ..." garbage rows, case-variant duplicates) is still dirty in the CRM sync pipeline itself. Every fix above is a read-time workaround. If this keeps causing confusion, the real fix is at CRM ingestion/parsing time.

---

## 4. Customer 360 — Origin filter removed, Destination filter self-emptying bug fixed

Reported as: "click one filter, the other disappears."

**Root cause:** `export_country` is **100% NULL** across all 56,684 shipments — there's no real per-shipment origin-country data at all (this business ships almost exclusively from Nepal). The "All Origins" dropdown was copy-paste-wired to reuse the destinations list, and picking anything from it filtered against `mawb_origin` (always `KTM`/`NP`), which never matched — zeroing results, which then emptied the "Destinations" dropdown's own option list on the next render (it was built from the same filtered response).

**Fix:** removed the Origin filter entirely (no fixable data exists). Split the backend response into `destinations` (filtered, drives the chart) and `destination_options` (always computed from the full unfiltered set, drives the dropdown) so picking a destination can never starve the dropdown's own future options.

---

## 5. Geography — "Top Countries by Revenue" chart removed

Per request — redundant with the "Customers by Country" table below it (which already shows revenue per country). Chart row went from 3 columns to 2 (Shipments, Weight).

---

## 6. Customer segmentation rule — the big one

**New rule** (`docs/customer-segmentation-rules.md` has the full writeup — read it before touching this again):

1. `assigned_ae_code` in (`RT`, `AJ`) → **Key Account**. `assigned_ae_code` = `DN` → **Reseller**. Both unconditional, revenue not considered.
2. Otherwise, tier by the company's **single highest-revenue calendar month ever** (all-time peak, not current month): ≥$5,000 → **Large Account**, ≥$1,000 → **SME**, else **Small Customer**.

**Why "peak month ever" instead of current/rolling revenue:** the explicit requirement was "Large Account can never be demoted." Using the all-time peak makes that automatic — a peak can only stay the same or grow as more history accumulates, so re-running the rule can never move a company down a tier. No extra "locked" flag needed.

**This replaces the old tier names** (`Strategic Account`, `Large Account`, `SME`, `Small Customer`) everywhere in the app — `AE_SEGMENTS` in `main.py`, `SEGMENTS` in `AnalyticsFilterBar.tsx`, filter dropdowns on Customer Directory/Management/Business Analytics, the Executive Overview "Customer Tier Distribution" widget and "VIP" KPI. Old `Strategic Account` references would otherwise silently show 0 forever since that tier is never assigned anymore.

**No manual-override exemption** — deliberately. Unlike every other automated writer in this app, this recompute does NOT respect `manual_override_fields`; it's fully rule-derived, on purpose (explicit decision, documented in the rules doc).

**Trigger:** admin-only endpoint `POST /api/v1/admin/customers/recompute-segments` + "Recompute Segments" button on Customer Management. **Not** auto-triggered after CRM sync yet — the sync worker (`crm_worker.py`) runs in a separate container that deliberately doesn't import `main.py` (to avoid duplicating `REVENUE_AMOUNT_SQL`, guarded by an existing test). Revisit if manual recompute cadence turns out to be too infrequent.

**Already run once against real local data**: Key Account 110 · Reseller 82 · Large Account 19 · SME 107 · Small Customer 723 (at time of running — will drift as data changes and whenever someone clicks the button again).

---

## 7. Tier Shipping Gap alert + Gmail SMTP email digest

**The alert** (already existed as an idea, built out this session): Key Account/Reseller/Large Account get flagged after **7 days** with no shipment, SME after **15 days**. Shows on the Alerts page (`Customer` category) and contributes to the sidebar's "N critical" badge. Logic lives in `backend/app/tier_alerts.py` (`get_tier_shipping_gap_breaches`) — shared by the Alerts endpoint and the email digest so both always agree on "overdue."

**Email digest** — built twice, two different providers:
1. **First attempt: Resend.** Fully wired (`email_notifications.py` using Resend's REST API via `httpx`), but Resend's free sandbox sender (`onboarding@resend.dev`) only delivers to the email the Resend account was signed up with — no domain, no real delivery to real people. Confirmed working end-to-end but land-in-spam even for the sandbox's own address (no sender reputation on a shared domain).
2. **Switched to Gmail SMTP with an App Password** (user's call — no DNS/domain access available). Rewrote `email_notifications.py` to use `smtplib` (stdlib, no new dependency) against `smtp.gmail.com:587`. **This is what's actually configured and working right now** — confirmed with a real send to real AE/admin inboxes.

**Scoping — verified against real data, not just code-reading:** each AE only receives their own overdue accounts (Prakash got exactly his 27, Namuna exactly her 6). Admins get everything. AE codes with no known email (`AJ, AS, DN, PS, RT, SLR` as of writing — only `PR`/Prakash and `NT`/Namuna have real `User` logins) aren't emailed individually but are still covered by the admin digest.

**Schedule:** `check_tier_alert_email_schedule()` in `crm_worker.py`, following the exact same hand-rolled-cron pattern already used for CRM pipeline/PnL/call-log auto-syncs (`_cron_matches` + a `CrmSyncState` cursor row) — **no new scheduler infrastructure was needed**, this app already had one, it just wasn't obvious. Default `TIER_ALERT_EMAIL_SCHEDULE_CRON="0 8 * * *"` (8am **UTC** — not Nepal time, same caveat as the existing `CRM_SCHEDULE_CRON`).

**Manual trigger:** `POST /api/v1/admin/tier-alerts/send-emails` / "Send Tier Alert Emails Now" button on Alerts page — returns a summary (counts sent, which AE codes have no email) even when sending is disabled.

**Config added to local `.env` (real, working, not committed):**
```
TIER_ALERT_EMAIL_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=shangrilatoursextra@gmail.com
SMTP_PASSWORD=<app password, in .env only>
SMTP_FROM_EMAIL=shangrilatoursextra@gmail.com
TIER_ALERT_EMAIL_SCHEDULE_CRON="0 8 * * *"
```
**The remote server's `.env` has none of this yet** — email sending will silently no-op there until it's configured (both flags + username + password all independently gate to a no-op, which is the safety net, not a bug).

**Real incident caught and fixed during this build:** two tests had no SMTP mocking and, once real Gmail credentials existed in `.env`, would have sent real emails to real AEs/admins on **every future test run**. Fixed to mock unconditionally. Also found and fixed actual data corruption: the `test-admin@customer360.test` fixture user had somehow been mutated to `role='ae'`, `ae_code='AJ'` (none of the test code does this — happened through the live app somehow) — meaning it would have received real AJ customer data in digests. Reset to `role='admin'`, `ae_code=NULL`. Worth a periodic sanity check (`SELECT email, role, ae_code FROM users WHERE role='ae'`) that only real AE accounts hold that role.

---

## 8. Profitability page — full inspection, 3 real bugs fixed

User asked for a full inspection ("something is not right"). Found and fixed:

1. **"By Margin" sort was fake.** `/api/v1/mawbs` had no sort parameter at all — always returned the 25 most-recent-by-date MAWBs; the frontend only re-sorted that one page client-side. The true best/worst-margin MAWBs anywhere outside the current page never surfaced. Fixed with a real `sort=margin` backend parameter (SQL order by `profit_loss/NULLIF(bill_amount,0)`, null-safe).
2. **Avg Margin trend badge computed a "percent of a percent."** Margin is already a %, so the old relative `pctChange()` turned a 10%→15% move into "+50%" instead of the correct "+5 points." Fixed to a plain percentage-point difference.
3. **Off-by-one date-range label** — a 30-day pick displayed "prior 29-day period" (exclusive day math used for the label). Fixed the label only; the underlying comparison window was already correct.

This page had **zero** test coverage before this session — added 3 new backend tests for the sort fix.

---

## 9. Alerts page — full redesign + cleanup

Multiple rounds of "remove X" requests, ended at:
- Removed the "Alert Volume by Category" bar chart entirely (was the first ask).
- Full redesign: chart replaced with 4 severity stat tiles (High/Medium/Low/Info counts, doubling as the severity filter — click to toggle), filter bar consolidated from 8+ separate buttons into one row (search + 2 dropdowns + sort), and **pagination added** (was rendering all 882 rows unpaginated in one giant table — a real source of the reported "clutter," not just styling).
- Removed `Pipeline` and `Operations` from the category filter dropdown (Customer/AE only now).
- Removed `SB`, `RTL`, `JS` from the AE filter dropdown (no display name on file for any of them, unlike every other AE).
- Removed the "Jump to page" Ctrl+K command palette from the whole app (`app-shell.tsx`) — separate request, unrelated to Alerts specifically.

---

## 10. Customer/Business Analytics — real "Unassigned" filter bug found and fixed

Reported as: "when I choose Unassigned, the assigned customer list also shows."

**Root cause — two separate places** in `executive_dashboard` (`main.py`, backs both Customer Analytics and Business Analytics via `revenue_analytics.all_customers`) built the "AE" field from the wrong source, disagreeing with the (correct) `customer_type`/segment field:
1. The main per-shipment query used an arbitrary single shipment's own `ae_code`, not the company's `assigned_ae_code` (the same field the new segmentation rule uses to decide Key Account/Reseller).
2. Companies with **zero shipments in the selected date range** went through a separate fallback path (`all_comp_rows`) that called `.get('ae_code', 'UNASSIGNED')` on a row dict that **never had an `ae_code` key at all** — silently defaulting to `'UNASSIGNED'` for every such company regardless of real assignment. This was the dominant cause — 33 of 192 Key Account/Reseller companies were affected.

**Fixed both** to prioritize `companies.assigned_ae_code`. Verified live: "Unassigned" filter now correctly excludes all Key Account/Reseller companies (impossible by definition, since those tiers require an AE assignment). Added a regression test.

---

## 11. Known issues spotted but NOT fixed (flagged only)

- **`.env.example` has what look like real CRM credentials committed** (`CRM_USERNAME=akrit`, `CRM_PASSWORD=akrit`, real internal URLs) in a second block further down the file. Didn't touch it — out of scope for whatever was being worked on each time it was noticed, but worth a look.
- **`master_air_waybills.destination` is dirty at the source** (see §3) — every fix this session was a read-time workaround (prefer `import_country`), not a fix to the CRM sync/parsing pipeline that lets garbage like `"Exchange Rate: 147.16"` land in that column in the first place.
- **Only 2 of ~9 AE codes have a real email on file** (`PR`, `NT`) — the rest (`AJ`, `AS`, `DN`, `PS`, `RT`, `SLR`, and the three removed from the Alerts dropdown `SB`/`RTL`/`JS`) exist only in `account_executives` as a code + display name, no `User` login. Not a bug, just a real gap — those AEs' tier-gap breaches only reach admins, never them personally, until they get real accounts.

---

## 12. Where to pick up

1. **Deploy everything in §2–§10** — none of it is live on `shangrila002` yet.
2. **After deploying, run "Recompute Segments" on the remote Customer Management page** — the segmentation rule doesn't backfill itself, someone has to click the button once (or wait for whatever cadence gets set up later).
3. **Configure SMTP on the remote server's `.env`** if the email digest should actually run there — same 6 keys as §7, remote is currently unconfigured (safe no-op, not broken, just off).
4. Consider whether `TIER_ALERT_EMAIL_SCHEDULE_CRON`'s UTC-vs-NPT gap should be fixed the same way `CRM_SCHEDULE_CRON` was documented (currently defaults to 8am UTC = 1:45pm NPT — probably not the intended send time for a "morning digest").
5. The two "not fixed" items in §11 are real and worth someone's attention eventually, just weren't in scope for what was actually being worked on.
