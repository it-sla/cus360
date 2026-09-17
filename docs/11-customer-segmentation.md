# Customer Segmentation Rule

**Decided 2026-09-03.** This supersedes the previous state documented in `10-known-issues.md` (M-item: "`companies.customer_type` is static and not derived by any code path... intentional, do not build a recompute without being asked again"). We were asked again — this file is that recompute, and it is now the sole authority for `customer_type`.

## The rule

Evaluated per company, in this order:

1. **AE assignment wins first, unconditionally** — revenue is not considered if this matches:
   - `assigned_ae_code` is `RT` or `AJ` → **Key Account**
   - `assigned_ae_code` is `DN` → **Reseller**
2. **Otherwise, tier by the single highest-revenue calendar month the company has ever had** (all-time peak, not current month, not a rolling window):
   - Peak month revenue ≥ **$5,000** → **Large Account**
   - Peak month revenue ≥ **$1,000** → **SME**
   - Otherwise → **Small Customer**

"Revenue" here is the same `REVENUE_AMOUNT_SQL` every other analytics endpoint uses (`backend/app/main.py:47-48`) — `bill_amount`/`declared_value` on shipments with `pay_term` in `PP`/`FC`/`FD` only. Never a different revenue definition for this feature.

## Why "best month ever" instead of "this month"

The explicit requirement was: **a company that has ever reached Large Account can never be demoted back to SME**, even if its revenue later drops. Using the company's all-time peak month (rather than a live/rolling window) makes that a *free property* of the calculation rather than something that needs separate state to track — a peak can only stay the same or increase as more shipment history accumulates, so re-running this rule on the same company can never move it down a tier. No "has this company ever hit Large Account" flag exists or is needed; the SQL naturally never regresses.

This also means: SME ↔ Small Customer has no such protection and isn't supposed to have one — those two aren't part of any explicit "never demote" instruction, and the peak-month logic doesn't create one for them either, since a company could have a $1,200 peak month (SME) while never approaching Large Account territory; that's still permanent under this rule, by the same peak-based logic.

## What this replaces

Old tiers were `Strategic Account`, `Large Account`, `SME`, `Small Customer` — all four were on `companies.customer_type` but **never written by any code path** (see `docs/10-known-issues.md`); values came from manual admin edits or a one-time company-master import (`backend/app/customer_clean_import.py`, which mapped an imported "Type" column: `IFC → 'Strategic Account'`, etc.). That import file is untouched by this change — it still exists and still writes those old values when someone runs a company-master import — but any value it (or a manual edit, or old CRM data) sets is **overwritten the next time someone runs a recompute**, since this rule has no manual-override exemption (see below).

New tiers: `Key Account`, `Reseller`, `Large Account`, `SME`, `Small Customer`. `AE_SEGMENTS` in `backend/app/main.py` is the canonical list; `SEGMENTS` in `frontend/src/components/AnalyticsFilterBar.tsx` mirrors it.

## No manual-override exemption — deliberately

Most automated writers in this app respect `manual_override_fields` (a per-row JSONB list of field names an admin has manually edited, which future automated writers must skip — see `docs/03-data-rules.md`). **This rule does not** — `customer_type` is fully rule-derived now; there is no "pin this customer's tier" escape hatch. If that's ever needed, it has to be added deliberately (a new field, not reusing `manual_override_fields`, since that mechanism is documented elsewhere as being respected by *every* automated writer — silently exempting one field from that guarantee would be surprising to whoever reads that doc next).

## Where it lives

- **Rule engine**: `backend/app/customer_segments.py` — `recompute_customer_segments(db, revenue_amount_sql)`. Takes `REVENUE_AMOUNT_SQL` as a parameter rather than importing it, to avoid a circular import (`main.py` imports this module) and to avoid a second copy of the revenue expression that could drift from the original (there's a standing test, `test_revenue_expression_is_shared_by_every_analytics_call_site`, guarding exactly this).
- **Trigger**: `POST /api/v1/admin/customers/recompute-segments` (admin-only, `main.py`). A button ("Recompute Segments") on the Customer Management page (`frontend/src/pages/CustomerManagement.tsx`) calls it and shows the resulting tier counts.
- **Not yet wired**: automatic recompute after each CRM sync. The sync worker (`crm_worker.py`) runs in a separate process/container and deliberately doesn't import `main.py` (same circular-import/duplication concern as above), so there's no single process where "a sync just finished" and "I have `REVENUE_AMOUNT_SQL`" are both true today. Revisit if manual recompute cadence turns out to be too infrequent in practice — the fix is either a small shared module both processes import, or moving `REVENUE_AMOUNT_SQL` itself somewhere both can reach without restructuring `main.py`'s test guard.

## The "Tier Shipping Gap" alert

New alert type in the existing live-computed `/api/v1/analytics/alerts` endpoint (`main.py`, `Customer` category, replaces the old `Strategic Account Inactive` alert which referenced a tier name that no longer exists):

| Tier | Alert fires after |
|---|---|
| Key Account | 7 days with no shipment |
| Reseller | 7 days with no shipment |
| Large Account | 15 days with no shipment |
| SME | 30 days with no shipment |
| Small Customer | 30 days with no shipment |
| Unclassified | No SLA, never alerts |

Thresholds live in `TIER_SHIPPING_SLA_DAYS` in `backend/app/tier_alerts.py`. Only companies with at least one real shipment on record are considered — a company that has never shipped (e.g. AE-assigned but brand new) doesn't fire this alert; that's a different problem than "went quiet."

Accounts silent longer than `DORMANT_CUTOFF_DAYS` (90 days) are excluded from breaches entirely — they're dormant, not "overdue," and would otherwise flood the worst-offenders list with years-old dead accounts. The displayed "days overdue" figure is days past the SLA (`days_since - sla_days`), not raw days since last shipment.

The breach query itself (`get_tier_shipping_gap_breaches`) lives in `tier_alerts.py` rather than inline in `main.py` — it's shared with the email digest below, so the in-app Alerts page and the email always agree on what "overdue" means.

## Email digest (Gmail SMTP)

The same breaches also go out by email — 2026-09-03. Each AE with a known email address gets a digest of just their own overdue accounts; every admin gets one covering everyone. Design lives in `backend/app/email_notifications.py`:

- **Sends via plain SMTP** (`smtplib`, stdlib — no new dependency) using a Gmail account + **App Password** (`myaccount.google.com/apppasswords`, requires 2FA on the account) — not the account's real login password. This replaced an earlier Resend-based design; Resend needs a verified sending domain to avoid landing in spam, and there's no DNS access available here to set one up. A Gmail app password sends from an address with real sender reputation already, no domain work needed.
- **Config**: `TIER_ALERT_EMAIL_ENABLED`, `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `587`), `SMTP_USERNAME`, `SMTP_PASSWORD` (the app password), `SMTP_FROM_EMAIL` (optional, falls back to `SMTP_USERNAME`). All of `TIER_ALERT_EMAIL_ENABLED` + username + password must be set or `send_tier_alert_digests` is a silent no-op — this is what keeps it from firing in tests or in an unconfigured environment.
- **AE codes with no known email** (most of them — only AEs with a `User` login, `role='ae'`, get one) aren't emailed individually, but their breaches still reach someone via the admin digest. Nothing is silently dropped.
- **Schedule**: `TIER_ALERT_EMAIL_SCHEDULE_CRON` (default `0 8 * * *`, i.e. 8am UTC daily — note this is UTC, not Nepal time, same caveat as `CRM_SCHEDULE_CRON`), checked via `check_tier_alert_email_schedule()` in `backend/app/crm_worker.py`, following the exact same hand-rolled-cron-plus-`CrmSyncState`-cursor pattern already used there for CRM pipeline/PnL/call-log auto-syncs — no new scheduler infrastructure was needed.
- **Manual trigger**: `POST /api/v1/admin/tier-alerts/send-emails` (admin-only) / "Send Tier Alert Emails Now" button on the Alerts page — returns a summary (`enabled`, counts sent, which AE codes have no email on file) even when sending is disabled, so an admin can see what's pending without configuring SMTP first.

## Verification

- `backend/tests/test_customer_segments.py` — rule correctness (AE precedence, thresholds, peak-month-not-current-month, never-demote-from-Large behavior) and the alert SLA logic.
- `backend/tests/test_tier_alerts_email.py` — breach extraction, email grouping by AE, admin coverage, and that sending is a true no-op when disabled or breaches are empty (mocks `smtplib.SMTP`, never touches a real mail server).
- Run `docker exec customer360-backend-1 python -m pytest -q` after any change here — the shared-revenue-expression test (`tests/test_executive_analytics.py`) will fail loudly if `REVENUE_AMOUNT_SQL` gets duplicated instead of passed through.
