-- Reconcile Customer 360's revenue basis against the source CRM's own manifest footers.
--
-- The CRM totals revenue into three pay-term buckets per manifest (pp/fc/fd_bill_amount).
-- Customer 360 sums individual shipment rows. On the agreed basis (PP/FC/FD only) these
-- should match to the cent. Any non-zero `gap` is a genuine ingestion or classification
-- problem worth investigating -- see docs/03-data-rules.md section 6b.
--
--   docker exec -i customer360-db-1 psql -U customer360 -d customer360 < qa/reconcile_revenue_vs_crm.sql
--
-- `gap` > 0  -> C360 reports MORE than the CRM (over-counting)
-- `gap` < 0  -> C360 reports LESS than the CRM (rows never imported)

\echo '=== Month-by-month reconciliation (last 18 months) ==='
WITH crm AS (
  SELECT date_trunc('month', manifest_date)::date AS mth,
         sum(coalesce(pp_bill_amount,0) + coalesce(fc_bill_amount,0) + coalesce(fd_bill_amount,0)) AS crm_total
  FROM master_air_waybills
  GROUP BY 1),
c360 AS (
  SELECT date_trunc('month', shipment_date)::date AS mth,
         sum(CASE WHEN upper(trim(coalesce(pay_term,''))) IN ('PP','FC','FD')
                  THEN coalesce(bill_amount, declared_value, 0) ELSE 0 END) AS c360_total,
         sum(CASE WHEN upper(trim(coalesce(pay_term,''))) NOT IN ('PP','FC','FD')
                  THEN coalesce(bill_amount, declared_value, 0) ELSE 0 END) AS excluded_non_billable
  FROM shipments
  WHERE shipment_date IS NOT NULL
  GROUP BY 1)
SELECT to_char(mth,'YYYY-MM')                                   AS month,
       round(coalesce(crm_total,0)::numeric,2)                  AS crm_footer,
       round(coalesce(c360_total,0)::numeric,2)                 AS c360_revenue,
       round((coalesce(c360_total,0)-coalesce(crm_total,0))::numeric,2) AS gap,
       round(coalesce(excluded_non_billable,0)::numeric,2)      AS excluded_non_billable
FROM crm FULL OUTER JOIN c360 USING (mth)
WHERE mth >= (date_trunc('month', CURRENT_DATE) - INTERVAL '18 months')
ORDER BY 1;

\echo ''
\echo '=== Whole-history summary ==='
WITH crm AS (
  SELECT date_trunc('month', manifest_date)::date AS mth,
         sum(coalesce(pp_bill_amount,0) + coalesce(fc_bill_amount,0) + coalesce(fd_bill_amount,0)) AS crm_total
  FROM master_air_waybills GROUP BY 1),
c360 AS (
  SELECT date_trunc('month', shipment_date)::date AS mth,
         sum(CASE WHEN upper(trim(coalesce(pay_term,''))) IN ('PP','FC','FD')
                  THEN coalesce(bill_amount, declared_value, 0) ELSE 0 END) AS c360_total
  FROM shipments WHERE shipment_date IS NOT NULL GROUP BY 1)
SELECT count(*) FILTER (WHERE round((coalesce(c360_total,0)-coalesce(crm_total,0))::numeric,2) = 0) AS months_matching_exactly,
       count(*)                                                                                    AS months_total,
       round(sum(coalesce(c360_total,0)-coalesce(crm_total,0))::numeric,2)                         AS total_gap
FROM crm FULL OUTER JOIN c360 USING (mth);

\echo ''
\echo '=== Manifests with a CRM footer total but ZERO imported rows (uningested revenue) ==='
SELECT mawb_number,
       manifest_date,
       round((coalesce(pp_bill_amount,0)+coalesce(fc_bill_amount,0)+coalesce(fd_bill_amount,0))::numeric,2) AS orphaned_revenue
FROM master_air_waybills m
WHERE NOT EXISTS (SELECT 1 FROM shipments s WHERE s.mawb_id = m.id)
  AND (coalesce(pp_bill_amount,0)+coalesce(fc_bill_amount,0)+coalesce(fd_bill_amount,0)) > 0
ORDER BY 3 DESC;
