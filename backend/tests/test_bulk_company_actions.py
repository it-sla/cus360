# NOTE: no isolated TEST_DATABASE_URL in this environment -- these tests run against
# the real database. Every row created here is deleted in a finally block regardless
# of whether a commit happened, matching the pattern in test_customer_segments.py.


def _mk_company(db, tag, customer_type=None):
    from app.models import Company
    from app.utils import normalize_name
    c = Company(icris_number=f'BULK-{tag}', company_name=f'Bulk Test {tag}',
                normalized_name=normalize_name(f'Bulk Test {tag}'), source='manual',
                customer_type=customer_type)
    db.add(c); db.flush()
    return c


def _cleanup(db, tag):
    from sqlalchemy import text
    db.rollback()
    db.execute(text("DELETE FROM companies WHERE icris_number LIKE :p"), {'p': f'BULK-{tag}%'})
    db.commit()
    db.close()


def test_bulk_set_category_updates_and_sets_manual_override(client):
    from app.db import SessionLocal
    db = SessionLocal()
    tag = 'CAT1'
    try:
        c1 = _mk_company(db, f'{tag}-1')
        c2 = _mk_company(db, f'{tag}-2', customer_type='SME')
        db.commit()

        resp = client.post('/api/v1/companies/bulk-set-category', json={
            'company_ids': [str(c1.id), str(c2.id)],
            'customer_type': 'SME',
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body['updated_count'] == 1
        assert body['unchanged_count'] == 1

        db.expire_all()
        db.refresh(c1); db.refresh(c2)
        assert c1.customer_type == 'SME'
        assert 'customer_type' in (c1.manual_override_fields or [])
        assert c2.customer_type == 'SME'
    finally:
        _cleanup(db, tag)


def test_bulk_set_category_rejects_unknown_value(client):
    from app.db import SessionLocal
    db = SessionLocal()
    tag = 'CAT2'
    try:
        c1 = _mk_company(db, tag)
        db.commit()

        resp = client.post('/api/v1/companies/bulk-set-category', json={
            'company_ids': [str(c1.id)],
            'customer_type': 'Not A Real Segment',
        })
        assert resp.status_code == 422

        db.expire_all(); db.refresh(c1)
        assert c1.customer_type is None
    finally:
        _cleanup(db, tag)


def test_bulk_set_category_null_clears_value(client):
    from app.db import SessionLocal
    db = SessionLocal()
    tag = 'CAT3'
    try:
        c1 = _mk_company(db, tag, customer_type='Reseller')
        db.commit()

        resp = client.post('/api/v1/companies/bulk-set-category', json={
            'company_ids': [str(c1.id)],
            'customer_type': None,
        })
        assert resp.status_code == 200, resp.text
        assert resp.json()['updated_count'] == 1

        db.expire_all(); db.refresh(c1)
        assert c1.customer_type is None
    finally:
        _cleanup(db, tag)
