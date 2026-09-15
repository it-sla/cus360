"""Tier Shipping Gap breach detection — shared by the in-app Alerts page
(main.py's /analytics/alerts) and the Resend email digest (email_notifications.py,
scheduled from crm_worker.py). One query, one definition of "overdue", used both
places — see docs/customer-segmentation-rules.md for the SLA rule itself.

No import from main.py here (deliberately) — this doesn't need REVENUE_AMOUNT_SQL,
and crm_worker.py (a separate process/container) needs to import this module too.
"""
from datetime import date

from sqlalchemy import text
from sqlalchemy.orm import Session

# Days since last shipment before a tier is considered overdue. Tiers not listed here
# (Small Customer, unclassified/None) have no SLA. Kept in sync with main.py's own
# TIER_SHIPPING_SLA_DAYS by test_tier_alerts.py.
TIER_SHIPPING_SLA_DAYS = {'Key Account': 7, 'Reseller': 7, 'Large Account': 7, 'SME': 15}


def get_tier_shipping_gap_breaches(db: Session) -> list[dict]:
    """Every company whose tier has an SLA and has gone quiet past it. Companies that
    have never shipped are excluded (nothing to measure a gap against)."""
    today = date.today()
    rows = db.execute(text("""
        SELECT c.id, c.company_name, c.customer_type, c.assigned_ae_code,
               MAX(s.shipment_date) AS last_shipment
        FROM companies c
        JOIN shipments s ON s.company_id = c.id
        WHERE c.customer_type = ANY(:tiers)
        GROUP BY c.id
    """), {'tiers': list(TIER_SHIPPING_SLA_DAYS.keys())}).fetchall()

    breaches = []
    for r in rows:
        if not r.last_shipment:
            continue
        sla_days = TIER_SHIPPING_SLA_DAYS.get(r.customer_type)
        if not sla_days:
            continue
        days_since = (today - r.last_shipment).days
        if days_since > sla_days:
            breaches.append({
                'company_id': str(r.id), 'company_name': r.company_name,
                'customer_type': r.customer_type, 'assigned_ae_code': r.assigned_ae_code,
                'days_since': days_since, 'sla_days': sla_days,
            })
    return sorted(breaches, key=lambda b: b['days_since'], reverse=True)
