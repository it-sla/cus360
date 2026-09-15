import pytest


def test_geography_top_destinations_prefers_import_country_over_dirty_mawb_field(client):
    """Same fix as company analytics, applied to the Rankings page's 'Top Destinations'
    tab (backed by /analytics/geography's top_destinations). Verified live: Shangri La
    Tours - RI showed 'DXB'/'HKG' (transit airports, one row literally 'Exchange Rate:
    147.16') as its top destinations instead of the real consignee countries."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Company, MasterAirWaybill, Shipment
    from app.utils import normalize_name
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        company = Company(icris_number=f'GEODEST-{tag}', company_name='Geo Dest Test Co',
                          normalized_name=normalize_name('Geo Dest Test Co'), source='manual')
        db.add(company); db.flush()
        dirty_mawb = MasterAirWaybill(mawb_number=f'GMAWB-{tag}', manifest_date=date.today(),
                                       destination='Exchange Rate: 147.16')
        db.add(dirty_mawb); db.flush()
        db.add(Shipment(shipment_number=f'GSHIP-{tag}', source='crm', company_id=company.id,
                        pay_term='PP', bill_amount=Decimal('250'), shipment_date=date.today(),
                        import_country='US', mawb_id=dirty_mawb.id))
        db.commit()

        res = client.get('/api/v1/analytics/geography', params={'timeframe': 'all_time'})
        assert res.status_code == 200
        names = [d['destination'] for d in res.json()['top_destinations']]
        assert not any('Exchange Rate' in n for n in names)
    finally:
        db.rollback()
        db.close()


def test_company_destination_prefers_import_country_over_dirty_mawb_field(client):
    """The MAWB 'destination' field is the flight's transit airport and is dirty in real
    data (stray text like 'Exchange Rate: 147.16' leaks in from bad CRM rows) -- the
    shipment's own import_country is the real consignee destination and must win.
    Regression for the 'Destination Distribution' chart on the Customer 360 page."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Company, MasterAirWaybill, Shipment
    from app.utils import normalize_name
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        company = Company(icris_number=f'DEST-{tag}', company_name='Dest Test Co',
                          normalized_name=normalize_name('Dest Test Co'), source='manual')
        db.add(company); db.flush()

        dirty_mawb = MasterAirWaybill(mawb_number=f'MAWB-{tag}', manifest_date=date.today(),
                                       destination='Exchange Rate: 147.16')
        db.add(dirty_mawb); db.flush()

        db.add(Shipment(shipment_number=f'SHIP-{tag}', source='crm', company_id=company.id,
                        pay_term='PP', bill_amount=Decimal('100'), shipment_date=date.today(),
                        import_country='US', mawb_id=dirty_mawb.id))
        db.commit()

        res = client.get(f'/api/v1/companies/{company.id}/analytics', params={'timeframe': 'all_time'})
        assert res.status_code == 200
        destinations = res.json()['destinations']
        names = [d['import_country'] for d in destinations]
        assert 'US' in names
        assert not any('Exchange Rate' in n for n in names)
    finally:
        db.rollback()
        db.close()


def test_company_destination_options_stay_stable_when_filtering(client):
    """The dropdown's option list (destination_options) must not shrink or empty out just
    because a destination filter is already applied -- it's always built from the full
    unfiltered current-period set. Regression for the 'select one filter, the other
    disappears' bug: destination_options used to reuse the filtered 'destinations' list,
    so picking a destination with results could leave the dropdown with nothing else to
    pick from next."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Company, Shipment
    from app.utils import normalize_name
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        company = Company(icris_number=f'OPTS-{tag}', company_name='Opts Test Co',
                          normalized_name=normalize_name('Opts Test Co'), source='manual')
        db.add(company); db.flush()
        db.add(Shipment(shipment_number=f'SHIP-{tag}-US', source='crm', company_id=company.id,
                        pay_term='PP', bill_amount=Decimal('100'), shipment_date=date.today(), import_country='US'))
        db.add(Shipment(shipment_number=f'SHIP-{tag}-GB', source='crm', company_id=company.id,
                        pay_term='PP', bill_amount=Decimal('100'), shipment_date=date.today(), import_country='GB'))
        db.commit()

        unfiltered = client.get(f'/api/v1/companies/{company.id}/analytics', params={'timeframe': 'all_time'}).json()
        filtered = client.get(f'/api/v1/companies/{company.id}/analytics', params={'timeframe': 'all_time', 'destination': 'US'}).json()

        unfiltered_options = {d['import_country'] for d in unfiltered['destination_options']}
        filtered_options = {d['import_country'] for d in filtered['destination_options']}
        assert unfiltered_options == filtered_options
        assert {'US', 'GB'} <= filtered_options

        # The chart-facing 'destinations' field DOES reflect the active filter.
        filtered_dest_names = {d['import_country'] for d in filtered['destinations']}
        assert filtered_dest_names == {'US'}
        assert filtered['kpi_cards']['shipments']['value'] == 1
    finally:
        db.rollback()
        db.close()
