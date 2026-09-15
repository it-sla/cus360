"""Customer segmentation rule — decided 2026-09-03, full writeup in
docs/customer-segmentation-rules.md. Read that file before changing anything here.

Summary: AE assignment overrides revenue for two fixed tiers (Key Account, Reseller);
every other company is tiered by the single highest-revenue calendar month it has ever
had (all-time peak, not current-month) against two thresholds. Using the all-time peak
instead of a rolling/current window makes the "never demote" requirement automatic: a
company's peak month can only stay the same or increase as more shipment history
accumulates, so recomputing this on a schedule can never move a company down a tier.

This is the sole source of truth for `companies.customer_type` going forward — legacy
values (however they got there: CRM import, customer_clean_import.py, manual edit) are
discarded on every recompute. There is deliberately no manual-override exemption for
this field, unlike most other automated writers in this app.
"""
from sqlalchemy import text
from sqlalchemy.orm import Session

KEY_ACCOUNT_AE_CODES = {'RT', 'AJ'}
RESELLER_AE_CODES = {'DN'}
LARGE_ACCOUNT_MIN_MONTHLY_REVENUE = 5000
SME_MIN_MONTHLY_REVENUE = 1000


def recompute_customer_segments(db: Session, revenue_amount_sql: str) -> dict:
    """Recomputes `customer_type` for every company. Returns {tier: count}.

    `revenue_amount_sql` must be main.py's REVENUE_AMOUNT_SQL, passed in rather than
    imported here to avoid a circular import (main.py imports this module) — it's the
    single shared revenue definition every other analytics endpoint already uses.
    """
    sql = f"""
        UPDATE companies c
        SET customer_type = CASE
            WHEN upper(trim(coalesce(c.assigned_ae_code,''))) IN ({','.join(f"'{code}'" for code in KEY_ACCOUNT_AE_CODES)}) THEN 'Key Account'
            WHEN upper(trim(coalesce(c.assigned_ae_code,''))) IN ({','.join(f"'{code}'" for code in RESELLER_AE_CODES)}) THEN 'Reseller'
            WHEN coalesce(b.best_month_revenue, 0) >= {LARGE_ACCOUNT_MIN_MONTHLY_REVENUE} THEN 'Large Account'
            WHEN coalesce(b.best_month_revenue, 0) >= {SME_MIN_MONTHLY_REVENUE} THEN 'SME'
            ELSE 'Small Customer'
        END
        FROM (
            SELECT c2.id AS company_id, bm.best_month_revenue
            FROM companies c2
            LEFT JOIN (
                SELECT company_id, max(month_revenue) AS best_month_revenue
                FROM (
                    SELECT company_id, sum({revenue_amount_sql}) AS month_revenue
                    FROM shipments s
                    WHERE company_id IS NOT NULL AND shipment_date IS NOT NULL
                    GROUP BY company_id, to_char(shipment_date, 'YYYY-MM')
                ) monthly
                GROUP BY company_id
            ) bm ON bm.company_id = c2.id
        ) b
        WHERE c.id = b.company_id
    """
    db.execute(text(sql))
    db.commit()

    counts = {row['customer_type']: row['count'] for row in [
        dict(r) for r in db.execute(text(
            "SELECT customer_type, count(*)::int AS count FROM companies GROUP BY customer_type"
        )).mappings()
    ]}
    return counts
