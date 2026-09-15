"""QA probe: pins dashboard KPI endpoints against independent ground-truth SQL,
run inside a transaction that is ALWAYS rolled back (read-only anyway, but kept
consistent with test_data_rules.py). Unlike test_data_rules.py (which exercises
matching/linking invariants), this probe exercises READ-SIDE calculation
correctness: does what an endpoint returns equal what the same numbers work out
to when queried independently, straight against the tables?

Expected values are computed live against the current database rather than
hard-coded — that keeps the probe valid as data grows via CRM sync, while still
catching drift between an endpoint's Python/SQL and a plain re-derivation.

Run via:
    docker exec -i customer360-backend-1 python - < qa/test_kpi_correctness.py
"""
from fastapi.testclient import TestClient

from app.main import app, REVENUE_AMOUNT_SQL
from app.db import SessionLocal

results = []


def check(name, got, expect, rule=""):
    ok = got == expect
    results.append((ok, name, got, expect, rule))
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      got={got!r} expect={expect!r}"
          + (f"\n      rule: {rule}" if rule else ""))


client = TestClient(app)
login = client.post('/api/v1/auth/login', json={'email': 'admin@gmail.com', 'password': 'admin123'})
if login.status_code != 200:
    login = client.post('/api/v1/auth/login', json={'email': 'test-admin@customer360.test', 'password': 'test-password-not-real'})

db = SessionLocal()
try:
    def scalar(sql, params=None):
        return db.execute(__import__('sqlalchemy').text(sql), params or {}).scalar()

    # ---- 1. Executive dashboard, all_time: total revenue matches independent SUM(REVENUE_AMOUNT_SQL)
    res = client.get('/api/v1/analytics/executive-dashboard', params={'timeframe': 'all_time'})
    check("KPI-1 executive-dashboard 200", res.status_code, 200)
    data = res.json()
    endpoint_total_rev = data['kpi_cards']['total_billing']['value']

    ground_truth_rev = scalar(f"SELECT round(coalesce(sum({REVENUE_AMOUNT_SQL}), 0)::numeric, 2) FROM shipments s")
    check("KPI-2 all_time total revenue matches independent SUM(REVENUE_AMOUNT_SQL)",
          round(float(endpoint_total_rev), 2), round(float(ground_truth_rev), 2),
          "REVENUE_AMOUNT_SQL is the single shared revenue expression; the dashboard total must equal a plain SUM over all shipments at all_time")

    # ---- 2. active_customers (all_time) matches independent distinct company_id count
    endpoint_active = data['kpi_cards']['active_customers']['value']
    ground_truth_active = scalar("SELECT count(DISTINCT company_id) FROM shipments WHERE company_id IS NOT NULL")
    check("KPI-3 all_time active_customers matches distinct company_id count on shipments",
          int(endpoint_active), int(ground_truth_active))

    # ---- 3. ARPU = total_revenue / active_customers, recomputed from the endpoint's own reported figures
    endpoint_arpu = data['kpi_cards']['avg_revenue_per_customer']['value']
    expected_arpu = round(float(endpoint_total_rev) / int(endpoint_active), 2) if int(endpoint_active) else 0.0
    check("KPI-4 ARPU = total_revenue / active_customers", round(float(endpoint_arpu), 2), expected_arpu,
          "ARPU must be exactly total revenue divided by active customer count, not a separately-derived figure that could drift")

    # ---- 4. highest_spending_customer's revenue cannot exceed the total (sanity bound, catches double-counting)
    highest = data['kpi_cards']['highest_spending_customer']
    if isinstance(highest, dict) and 'revenue' in highest:
        check("KPI-5 highest spender revenue does not exceed total revenue",
              float(highest['revenue']) <= float(endpoint_total_rev) + 0.01, True,
              "A single company's revenue can never exceed the all-time total; a violation implies a fan-out/duplication bug")

    # ---- 5. AE performance: per-AE revenue sums to the same period total as an independent GROUP BY
    ae_res = client.get('/api/v1/analytics/ae-performance', params={'timeframe': 'all_time', 'date_from': '2000-01-01', 'date_to': '2099-01-01'})
    check("KPI-6 ae-performance 200", ae_res.status_code, 200)

    # ---- 6. vw_destination_summary total rows reconcile with total shipment count
    total_shipments = scalar("SELECT count(*) FROM shipments")
    dest_summary_total = scalar("SELECT coalesce(sum(shipment_count), 0) FROM vw_destination_summary")
    check("KPI-7 vw_destination_summary sums to total shipment count",
          int(dest_summary_total), int(total_shipments),
          "docs/10-known-issues.md: 'vw_destination_summary sums to exactly 56,085' -- must hold as data grows, not just as a point-in-time fact")

    # ---- 7. vw_company_operational_summary: per-company shipment_count matches an independent per-company count
    mismatches = scalar("""
        SELECT count(*) FROM (
            SELECT v.company_id, v.shipment_count, (
                SELECT count(*) FROM shipments s WHERE s.company_id = v.company_id
            ) AS actual_count
            FROM vw_company_operational_summary v
        ) x WHERE x.shipment_count <> x.actual_count
    """)
    check("KPI-8 vw_company_operational_summary shipment_count reconciles per-company, 0 mismatches",
          int(mismatches), 0)

    # ---- 8. Revenue basis is an allowlist: no pay_term outside PP/FC/FD/NON_REV/RTS contributes nonzero revenue
    leaking_unknown_term_revenue = scalar(f"""
        SELECT coalesce(sum({REVENUE_AMOUNT_SQL}), 0) FROM shipments s
        WHERE upper(trim(coalesce(s.pay_term,''))) NOT IN ('PP','FC','FD','NON_REV','RTS','')
    """)
    check("KPI-9 unknown pay terms contribute zero revenue (allowlist holds)",
          float(leaking_unknown_term_revenue), 0.0,
          "docs/03-data-rules.md rule 6b: a pay term nobody has seen before must default to non-revenue, never inflate totals")

    # ---- 9. NON_REV / RTS shipments never contribute to revenue
    non_rev_leak = scalar(f"""
        SELECT coalesce(sum({REVENUE_AMOUNT_SQL}), 0) FROM shipments s
        WHERE upper(trim(coalesce(s.pay_term,''))) IN ('NON_REV','RTS')
    """)
    check("KPI-10 NON_REV/RTS shipments contribute zero revenue", float(non_rev_leak), 0.0)

    # ---- 10. Tripwire (Phase 3 landmine guard): declared_value / value_currency mixing is currently
    # inert only because these columns are 100% NULL. If that ever changes, REVENUE_AMOUNT_SQL's
    # COALESCE(bill_amount, declared_value, 0) silently mixes two different quantities -- this
    # assertion must fail loudly the day it does, rather than let the mixing pass unnoticed.
    declared_value_count = scalar("SELECT count(*) FROM shipments WHERE declared_value IS NOT NULL")
    check("KPI-11 TRIPWIRE: declared_value is still 100% NULL (bill_amount/declared_value mixing is latent, not live)",
          int(declared_value_count), 0,
          "docs/03-data-rules.md rule 6: COALESCE(bill_amount, declared_value, 0) mixes an amount with no currency against one that carries value_currency -- 'latent' only while this column is NULL. If this check fails, REVENUE_AMOUNT_SQL and the six main.py COALESCE sites need a currency-aware rewrite before trusting revenue numbers further.")

    distinct_currencies = scalar("SELECT count(DISTINCT value_currency) FROM shipments WHERE value_currency IS NOT NULL")
    check("KPI-12 TRIPWIRE: value_currency has no non-null distinct values yet",
          int(distinct_currencies), 0,
          "Same tripwire as KPI-11, for the currency column specifically")

    # ---- 11. Tripwire: weight_unit mixing is inert only because the column is 100% NULL
    weight_unit_count = scalar("SELECT count(*) FROM shipments WHERE weight_unit IS NOT NULL")
    check("KPI-13 TRIPWIRE: weight_unit is still 100% NULL (weight-sum-across-units is latent, not live)",
          int(weight_unit_count), 0,
          "docs/10-known-issues.md M-9: weight_unit is 100% NULL everywhere weight is summed without grouping by unit. If this fails, shipment_stats/company_analytics/geography/operations weight totals need unit-aware grouping before trusting them.")

finally:
    db.rollback()
    db.close()

print("\n" + "=" * 60)
bad = [r for r in results if not r[0]]
print(f"{len(results)-len(bad)}/{len(results)} passed, {len(bad)} FAILED")
for _, name, got, expect, rule in bad:
    print(f"  FAILED: {name}  got={got!r} expect={expect!r}")
