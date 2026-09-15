import os

ENDPOINT_CODE = """
@app.get('/api/v1/analytics/geography')
def geography_analytics(
    timeframe:str=Query('this_month'),
    date_from:date|None=None,
    date_to:date|None=None,
    year_from:int|None=None,
    year_to:int|None=None,
    compare_mode:str=Query('pop'),
    country:str|None=None,
    origin:str|None=None,
    destination:str|None=None,
    ae_code:str|None=None,
    segment:str|None=None,
    export_only:bool=Query(False),
    db:Session=Depends(get_db)
):
    from datetime import date as _date,datetime as _datetime
    c_start,c_end,p_start,p_end=get_timeframe_bounds(timeframe,date_from,date_to,year_from,year_to,compare_mode)
    is_all_time=timeframe=='all_time'

    # Current period shipments
    sql_base = \"\"\"
        SELECT s.id, s.company_id, c.company_name, c.icris_number,
               s.shipment_date, coalesce(nullif(s.ae_code,''), 'UNASSIGNED') ae_code,
               coalesce(s.bill_amount, s.declared_value, 0)::float amount,
               coalesce(s.pieces, 1)::int pieces, coalesce(s.shipment_weight, 0)::float weight,
               coalesce(s.import_country, 'Unknown') import_country,
               coalesce(s.export_country, 'Unknown') export_country,
               m.origin as mawb_origin, m.destination as mawb_destination
        FROM shipments s
        LEFT JOIN companies c ON c.id=s.company_id
        LEFT JOIN master_air_waybills m ON m.id=s.mawb_id
        WHERE ((:is_all = true) OR (s.shipment_date >= :c_start AND s.shipment_date <= :c_end))
    \"\"\"
    params = {'is_all': is_all_time, 'c_start': c_start, 'c_end': c_end}
    cur_rows = rows(db, sql_base, params)

    prev_rows = []
    if not is_all_time:
        p_params = {'is_all': False, 'c_start': p_start, 'c_end': p_end}
        prev_rows = rows(db, sql_base, p_params)

    def apply_filters(rows_list):
        filtered = []
        for r in rows_list:
            if country:
                c_targets = {t.strip().lower() for t in country.split(',')}
                if not any(t in (r['import_country'] or '').lower() or t in (r['export_country'] or '').lower() for t in c_targets):
                    continue
            if origin:
                o_targets = {t.strip().lower() for t in origin.split(',')}
                if not any(t in (r['mawb_origin'] or '').lower() for t in o_targets):
                    continue
            if destination:
                d_targets = {t.strip().lower() for t in destination.split(',')}
                if not any(t in (r['mawb_destination'] or '').lower() for t in d_targets):
                    continue
            if ae_code:
                ae_targets = {a.strip().lower() for a in ae_code.split(',')}
                if not any(a in (r['ae_code'] or '').lower() for a in ae_targets):
                    continue
            if export_only and str(r['import_country']).lower() == 'nepal':
                continue
            filtered.append(r)
        return filtered

    cur_filtered = apply_filters(cur_rows)
    prev_filtered = apply_filters(prev_rows)

    def calc_metrics(data):
        total_rev = sum(r['amount'] for r in data)
        total_ship = len(data)
        total_wt = sum(r['weight'] for r in data)
        import_countries = {r['import_country'] for r in data if str(r['import_country']).lower() != 'nepal'}
        origins = {r['mawb_origin'] for r in data if r['mawb_origin']}
        destinations = {r['mawb_destination'] for r in data if r['mawb_destination']}
        return total_rev, total_ship, total_wt, import_countries, origins, destinations

    c_rev, c_ship, c_wt, c_ic, c_orig, c_dest = calc_metrics(cur_filtered)
    p_rev, p_ship, p_wt, p_ic, p_orig, p_dest = calc_metrics(prev_filtered)

    kpis = {
        'countries_served': {'value': len(c_ic), 'pop_pct': calc_pop(len(c_ic), len(p_ic))},
        'origins': {'value': len(c_orig), 'pop_pct': calc_pop(len(c_orig), len(p_orig))},
        'destinations': {'value': len(c_dest), 'pop_pct': calc_pop(len(c_dest), len(p_dest))},
        'international_revenue': {'value': c_rev, 'pop_pct': calc_pop(c_rev, p_rev)},
        'total_shipments': {'value': c_ship, 'pop_pct': calc_pop(c_ship, p_ship)},
        'total_weight': {'value': c_wt, 'pop_pct': calc_pop(c_wt, p_wt)},
        'avg_revenue_per_country': {'value': c_rev / max(1, len(c_ic)), 'pop_pct': calc_pop(c_rev / max(1, len(c_ic)), p_rev / max(1, len(p_ic)))},
        'avg_shipments_per_country': {'value': c_ship / max(1, len(c_ic)), 'pop_pct': calc_pop(c_ship / max(1, len(c_ic)), p_ship / max(1, len(p_ic)))}
    }

    country_map = {}
    for r in cur_filtered:
        cnt = r['import_country']
        if str(cnt).lower() == 'nepal':
            cnt = r['export_country'] # use export if import is nepal
        if not cnt or str(cnt).lower() == 'unknown':
            continue
        if cnt not in country_map:
            country_map[cnt] = {'name': cnt, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        country_map[cnt]['revenue'] += r['amount']
        country_map[cnt]['shipments'] += 1
        country_map[cnt]['weight'] += r['weight']
        country_map[cnt]['customers'].add(r['company_id'])

    revenue_by_country = sorted([{'name': v['name'], 'value': round(v['revenue'], 2)} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    shipments_by_country = sorted([{'name': v['name'], 'value': v['shipments']} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    weight_by_country = sorted([{'name': v['name'], 'value': round(v['weight'], 2)} for v in country_map.values()], key=lambda x: x['value'], reverse=True)
    country_distribution = revenue_by_country

    dest_map = {}
    for r in cur_filtered:
        dst = r['mawb_destination'] or r['import_country']
        if not dst or str(dst).lower() == 'unknown': continue
        if dst not in dest_map:
            dest_map[dst] = {'name': dst, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        dest_map[dst]['revenue'] += r['amount']
        dest_map[dst]['shipments'] += 1
        dest_map[dst]['weight'] += r['weight']
        dest_map[dst]['customers'].add(r['company_id'])
    
    top_destinations = sorted([
        {'destination': v['name'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 
         'weight': round(v['weight'], 2), 'customers': len(v['customers']), 'growth_pct': 0.0} 
        for v in dest_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    orig_map = {}
    for r in cur_filtered:
        org = r['mawb_origin'] or r['export_country']
        if not org or str(org).lower() == 'unknown': continue
        if org not in orig_map:
            orig_map[org] = {'name': org, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0, 'customers': set()}
        orig_map[org]['revenue'] += r['amount']
        orig_map[org]['shipments'] += 1
        orig_map[org]['weight'] += r['weight']
        orig_map[org]['customers'].add(r['company_id'])
    
    top_origins = sorted([
        {'origin': v['name'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 
         'weight': round(v['weight'], 2), 'customers': len(v['customers'])} 
        for v in orig_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    trade_lanes_map = {}
    for r in cur_filtered:
        org = r['mawb_origin'] or r['export_country'] or 'Unknown'
        dst = r['mawb_destination'] or r['import_country'] or 'Unknown'
        lane = f"{org} -> {dst}"
        if lane not in trade_lanes_map:
            trade_lanes_map[lane] = {'origin': org, 'destination': dst, 'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
        trade_lanes_map[lane]['revenue'] += r['amount']
        trade_lanes_map[lane]['shipments'] += 1
        trade_lanes_map[lane]['weight'] += r['weight']

    trade_lanes = sorted([
        {'origin': v['origin'], 'destination': v['destination'], 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2)}
        for v in trade_lanes_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    customers_by_country = []
    for cnt, data in country_map.items():
        customers_by_country.append({
            'country': cnt,
            'customers': len(data['customers']),
            'strategic': 0, 'large': 0, 'sme': 0, 'small': len(data['customers']),
            'revenue': round(data['revenue'], 2)
        })
    customers_by_country = sorted(customers_by_country, key=lambda x: x['revenue'], reverse=True)

    export_map = {}
    import_map = {}
    for r in cur_filtered:
        if str(r['export_country']).lower() != 'nepal':
            exp = r['export_country']
            if exp not in export_map: export_map[exp] = {'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
            export_map[exp]['revenue'] += r['amount']
            export_map[exp]['shipments'] += 1
            export_map[exp]['weight'] += r['weight']
        
        imp = r['import_country']
        if str(imp).lower() != 'nepal':
            if imp not in import_map: import_map[imp] = {'revenue': 0.0, 'shipments': 0, 'weight': 0.0}
            import_map[imp]['revenue'] += r['amount']
            import_map[imp]['shipments'] += 1
            import_map[imp]['weight'] += r['weight']

    top_export_countries = sorted([
        {'country': k, 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2), 'avg_shipment_value': round(v['revenue']/max(1, v['shipments']), 2)}
        for k, v in export_map.items()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    top_import_countries = sorted([
        {'country': k, 'revenue': round(v['revenue'], 2), 'shipments': v['shipments'], 'weight': round(v['weight'], 2), 'avg_shipment_value': round(v['revenue']/max(1, v['shipments']), 2)}
        for k, v in import_map.items()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    country_performance = sorted([
        {'country': v['name'], 'revenue': round(v['revenue'], 2), 'growth_pct': 0.0, 'shipment_growth': 0.0, 'weight_growth': 0.0, 'customer_growth': 0.0}
        for v in country_map.values()
    ], key=lambda x: x['revenue'], reverse=True)[:20]

    return {
        'timeframe': timeframe,
        'kpi_cards': kpis,
        'revenue_by_country': revenue_by_country,
        'shipments_by_country': shipments_by_country,
        'weight_by_country': weight_by_country,
        'top_destinations': top_destinations,
        'top_origins': top_origins,
        'trade_lanes': trade_lanes,
        'country_distribution': country_distribution,
        'customers_by_country': customers_by_country,
        'top_export_countries': top_export_countries,
        'top_import_countries': top_import_countries,
        'country_performance': country_performance,
        'geographic_growth': []
    }
"""

with open('c:/Projects/customer360/backend/app/main.py', 'a', encoding='utf-8') as f:
    f.write("\n")
    f.write(ENDPOINT_CODE)
    f.write("\n")

print("Geography endpoint added.")
