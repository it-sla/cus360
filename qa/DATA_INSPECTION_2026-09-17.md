# Data Inspection Report — 2026-09-17

## Summary

Full data audit comparing Customer 360 local DB against CRM source (Export). **All metrics match exactly.**

## Monthly (September 2026) — CRM vs Customer 360

| Metric | CRM Dashboard | Customer 360 (PP only) | Match |
|--------|--------------|----------------------|-------|
| Revenue | $93,492.98 | $93,492.98 | Exact |
| Volume (kg) | 10,117.00 | 10,117.00 | Exact |
| Pieces | 621 | 621 | Exact |

**Note:** CRM "Target And Actual (Export)" counts only PP (prepaid) shipments for Volume/Pcs. FC (freight collect) shipments have $0 revenue and are excluded from CRM's volume/pieces totals. Customer 360 stores all pay terms; filter to `pay_term = 'PP'` to match CRM.

## Root causes found and fixed

### 1. Missing bill_amounts on 88 shipments
Shipments synced from CRM list pages only — detail pages (which carry bill_amount, weight, pieces) were not fetched. Fixed by running a full September backfill.

### 2. Revenue gap was ~$10K before fix
- Before backfill: $83,422.06 (missing detail-page data)
- After backfill: $93,492.98 (exact CRM match)

## Weight/Pieces discrepancy explanation

Our DB totals (all pay terms): 10,200 kg / 647 pcs
CRM dashboard (PP only): 10,117 kg / 621 pcs
Difference: 83 kg / 26 pcs — these are FC shipments with $0 revenue, correctly excluded by CRM.

## Probes

- Data rules: **17/17 passing**
- KPI checks: **13/13 passing**
- All-time revenue: $11,241,418.90
- All-time companies: 658
- All-time shipments: 57,098

## Pending

- [ ] Re-dump local DB to production (192.168.101.244 via Tailscale 100.94.204.57)
- [ ] Deploy frontend dist to production (blocked by file permissions — run manually on server)
