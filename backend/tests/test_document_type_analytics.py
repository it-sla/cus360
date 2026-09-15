import pytest


def test_document_type_endpoint_shape(client):
    res = client.get('/api/v1/analytics/document-type')
    assert res.status_code == 200
    data = res.json()
    assert 'timeframe' in data
    assert 'kpis' in data
    for bucket in ('doc', 'non_doc', 'unclassified'):
        assert bucket in data['kpis']
        for metric in ('shipments', 'revenue', 'weight', 'avg_revenue_per_shipment'):
            assert metric in data['kpis'][bucket]
    assert 'trend' in data
    assert 'by_customer' in data
    assert 'by_ae' in data
    assert 'by_destination' in data


def _seed_doc_type_shipments(db):
    """One shipment per bill_type case, each PP-billed 100 so revenue is unambiguous."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.models import Shipment
    tag = uuid.uuid4().hex[:8].upper()
    cases = {'DOCUMENT': 'Document', 'LETTER': 'Letter', 'NONDOC': 'Non-Doc', 'BLANK': '', 'NULL': None}
    for label, bt in cases.items():
        db.add(Shipment(shipment_number=f'DOCTYPE-{tag}-{label}', source='crm', pay_term='PP',
                        bill_type=bt, bill_amount=Decimal('100'), shipment_date=date.today()))
    db.flush()
    return tag


def test_document_letter_bucket_into_doc_non_doc_stays_separate_blank_is_unclassified(client):
    """Document + Letter -> doc, Non-Doc -> non_doc, blank/NULL -> unclassified.
    Verified classification rule per user decision 2026-09-03: Letter folds into DOC."""
    from app.main import _doc_type_bucket
    assert _doc_type_bucket('Document') == 'doc'
    assert _doc_type_bucket('Letter') == 'doc'
    assert _doc_type_bucket('Non-Doc') == 'non_doc'
    assert _doc_type_bucket('') == 'unclassified'
    assert _doc_type_bucket(None) == 'unclassified'
    assert _doc_type_bucket('SomethingElse') == 'unclassified'


def test_document_type_revenue_uses_shared_revenue_expression():
    """Revenue split must follow the same PP/FC/FD-only convention as every other
    analytics endpoint (REVENUE_AMOUNT_SQL) -- not a bespoke definition for this page."""
    from app.db import SessionLocal
    from app.main import REVENUE_AMOUNT_SQL, _doc_type_bucket
    from sqlalchemy import text
    db = SessionLocal()
    try:
        tag = _seed_doc_type_shipments(db)
        rows = db.execute(text(f"""
            SELECT bill_type, {REVENUE_AMOUNT_SQL}::float AS amount
            FROM shipments s WHERE s.shipment_number LIKE :p
        """), {'p': f'DOCTYPE-{tag}-%'}).mappings().all()
        assert len(rows) == 5
        buckets = {}
        for r in rows:
            b = _doc_type_bucket(r['bill_type'])
            buckets[b] = buckets.get(b, 0.0) + r['amount']
        assert buckets.get('doc') == 200.0  # Document + Letter, 100 each
        assert buckets.get('non_doc') == 100.0
        assert buckets.get('unclassified') == 200.0  # blank + NULL
        db.rollback()
    finally:
        db.close()


def test_document_type_timeframe_and_compare_mode_accepted(client):
    for tf in ['today', 'this_week', 'this_month', 'this_quarter', 'this_year', 'all_time']:
        res = client.get('/api/v1/analytics/document-type', params={'timeframe': tf})
        assert res.status_code == 200
        assert res.json()['timeframe'] == tf
    res = client.get('/api/v1/analytics/document-type', params={'timeframe': 'this_month', 'compare_mode': 'yoy'})
    assert res.status_code == 200


def test_document_type_by_destination_split(client):
    """Each destination row must carry its own doc/non_doc counts so 'which destination
    do DOC shipments go to most' can be answered without re-deriving buckets client-side."""
    import uuid
    from datetime import date
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment
    db = SessionLocal()
    try:
        tag = uuid.uuid4().hex[:8].upper()
        db.add(Shipment(shipment_number=f'DEST-{tag}-1', source='crm', pay_term='PP', bill_type='Document',
                        bill_amount=Decimal('50'), shipment_date=date.today(), import_country='TESTLAND'))
        db.add(Shipment(shipment_number=f'DEST-{tag}-2', source='crm', pay_term='PP', bill_type='Non-Doc',
                        bill_amount=Decimal('50'), shipment_date=date.today(), import_country='TESTLAND'))
        db.commit()
        res = client.get('/api/v1/analytics/document-type', params={'timeframe': 'today'})
        assert res.status_code == 200
        by_dest = {d['destination']: d for d in res.json()['by_destination']}
        assert 'TESTLAND' in by_dest
        assert by_dest['TESTLAND']['doc_count'] >= 1
        assert by_dest['TESTLAND']['non_doc_count'] >= 1
    finally:
        db.query(Shipment).filter(Shipment.shipment_number.like(f'DEST-{tag}-%')).delete(synchronize_session=False)
        db.commit()
        db.close()
