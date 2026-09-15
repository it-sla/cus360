@app.get('/api/v1/analytics/alerts')
def get_alerts(db: Session = Depends(get_db)):
    alerts = []
    import uuid
    from datetime import date, timedelta
    
    today = date.today()
    
    def add_alert(cat, type_, severity, title, desc, ent_type, ent_id=None, ent_name=None, metric=None):
        alerts.append({
            'id': str(uuid.uuid4()), 'category': cat, 'type': type_, 'severity': severity,
            'title': title, 'description': desc, 'entity_type': ent_type, 'entity_id': ent_id,
            'entity_name': ent_name, 'metric_value': metric, 'date': str(today)
        })

    # 1. CUSTOMER ALERTS
    comp_stats = db.execute(text("""
        SELECT c.id, c.company_name, c.customer_type, 
               MAX(s.shipment_date) as last_shipment,
               MIN(s.shipment_date) as first_shipment,
               COUNT(s.id) as total_shipments
        FROM companies c
        LEFT JOIN shipments s ON s.company_id = c.id
        GROUP BY c.id
    """)).fetchall()

    for c in comp_stats:
        if not c.last_shipment: continue
        days_since = (today - c.last_shipment).days
        
        # New Customer
        if c.first_shipment and (today - c.first_shipment).days <= 30:
            add_alert('Customer', 'New Customer', 'info', f"New Customer: {c.company_name}", f"First shipment was {(today - c.first_shipment).days} days ago.", 'company', str(c.id), c.company_name, c.total_shipments)
            
        # Dormant Customers
        if days_since > 180:
            add_alert('Customer', 'Dormant (180+ days)', 'high', f"Dormant 180+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since)
        elif days_since > 90:
            add_alert('Customer', 'Dormant (90+ days)', 'medium', f"Dormant 90+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since)
        elif days_since > 30:
            add_alert('Customer', 'Dormant (30+ days)', 'low', f"Dormant 30+ Days: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since)
            
        # Strategic Account Inactive
        if c.customer_type == 'Strategic Account' and days_since > 7:
            add_alert('Customer', 'Strategic Account Inactive', 'high', f"Inactive Strategic Account: {c.company_name}", f"No activity for {days_since} days.", 'company', str(c.id), c.company_name, days_since)

    # REVENUE GAINER/DECLINER (this month vs last month)
    rev_stats = db.execute(text("""
        WITH monthly AS (
            SELECT company_id, 
                   SUM(CASE WHEN shipment_date >= date_trunc('month', CURRENT_DATE) THEN coalesce(bill_amount, declared_value, 0) ELSE 0 END) as cur_rev,
                   SUM(CASE WHEN shipment_date >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND shipment_date < date_trunc('month', CURRENT_DATE) THEN coalesce(bill_amount, declared_value, 0) ELSE 0 END) as prev_rev
            FROM shipments
            GROUP BY company_id
        )
        SELECT m.company_id, c.company_name, m.cur_rev, m.prev_rev, (m.cur_rev - m.prev_rev) as diff
        FROM monthly m JOIN companies c ON c.id = m.company_id
        WHERE m.prev_rev > 0 OR m.cur_rev > 0
    """)).fetchall()

    for r in rev_stats:
        if r.diff > 5000 and r.cur_rev > float(r.prev_rev) * 1.5:
            add_alert('Customer', 'Revenue Gainer', 'info', f"Revenue Spike: {r.company_name}", f"Revenue grew by ${r.diff:,.2f} this month.", 'company', str(r.company_id), r.company_name, float(r.diff))
        elif r.diff < -5000 and r.cur_rev < float(r.prev_rev) * 0.5:
            add_alert('Customer', 'Revenue Decliner', 'high', f"Revenue Drop: {r.company_name}", f"Revenue dropped by ${abs(r.diff):,.2f} this month.", 'company', str(r.company_id), r.company_name, float(r.diff))

    # 2. AE ALERTS
    ae_stats = db.execute(text("""
        SELECT ae_code, 
               COUNT(DISTINCT CASE WHEN shipment_date < CURRENT_DATE - 30 THEN company_id END) as dormant_count,
               COUNT(DISTINCT CASE WHEN shipment_date >= CURRENT_DATE - 30 THEN company_id END) as active_count
        FROM shipments
        WHERE ae_code IS NOT NULL AND ae_code != ''
        GROUP BY ae_code
    """)).fetchall()

    for ae in ae_stats:
        if ae.dormant_count > 10:
            add_alert('AE', 'High Dormancy', 'medium', f"AE Portfolio Risk: {ae.ae_code}", f"{ae.dormant_count} dormant accounts.", 'ae', ae.ae_code, ae.ae_code, ae.dormant_count)
        if ae.active_count == 0 and ae.dormant_count > 0:
            add_alert('AE', 'Portfolio Inactive', 'high', f"AE Portfolio Inactive: {ae.ae_code}", f"0 active accounts in the last 30 days.", 'ae', ae.ae_code, ae.ae_code, ae.active_count)

    # 3. OPERATIONS ALERTS
    ops_shipments = db.execute(text("""
        SELECT id, shipment_number, bill_amount, declared_value, shipment_weight, shipment_date
        FROM shipments
        WHERE shipment_date >= CURRENT_DATE - 7
    """)).fetchall()

    for s in ops_shipments:
        val = float(s.bill_amount or s.declared_value or 0)
        if val > 10000:
            add_alert('Operations', 'High-Value Shipment', 'info', f"High Value: {s.shipment_number}", f"Value: ${val:,.2f}", 'shipment', str(s.id), s.shipment_number, val)
        if s.shipment_weight and s.shipment_weight > 500:
            add_alert('Operations', 'Heavy Shipment', 'info', f"Heavy Shipment: {s.shipment_number}", f"Weight: {s.shipment_weight:,.1f} kg", 'shipment', str(s.id), s.shipment_number, float(s.shipment_weight))

    # MAWB with highest volume
    mawb_stats = db.execute(text("""
        SELECT m.id, m.mawb_number, SUM(s.shipment_weight) as total_weight
        FROM master_air_waybills m
        JOIN shipments s ON s.mawb_id = m.id
        WHERE s.shipment_date >= CURRENT_DATE - 7
        GROUP BY m.id, m.mawb_number
        ORDER BY total_weight DESC NULLS LAST
        LIMIT 1
    """)).fetchall()

    if mawb_stats and mawb_stats[0].total_weight:
        add_alert('Operations', 'High Volume MAWB', 'info', f"Top MAWB: {mawb_stats[0].mawb_number}", f"Total weight: {mawb_stats[0].total_weight:,.1f} kg", 'mawb', str(mawb_stats[0].id), mawb_stats[0].mawb_number, float(mawb_stats[0].total_weight))

    # Sort alerts by severity (high > medium > low > info)
    severity_order = {'high': 0, 'medium': 1, 'low': 2, 'info': 3}
    alerts.sort(key=lambda x: severity_order.get(x['severity'], 4))
    
    return {"alerts": alerts[:100]}
