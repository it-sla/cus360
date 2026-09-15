import uuid
from sqlalchemy import select
from app.crm_sync import link_icris, rematch
from app.db import SessionLocal
from app.models import Company, DataQualityIssue, Shipment
from app.utils import normalize_name

def test_assign_company_fix_resolves_issue_and_survives_rematch(client):
    db = SessionLocal(); suffix = uuid.uuid4().hex[:8]
    try:
        company = Company(icris_number=f'FIX-{suffix}', company_name='Fix Target', normalized_name=normalize_name('Fix Target'), source='manual')
        shipment = Shipment(shipment_number=f'FIX-AWB-{suffix}', source='crm')
        db.add_all([company, shipment]); db.flush()
        assert link_icris(db, shipment, '', 'Some Shipper') == 'missing'
        db.commit()

        issue = db.scalar(select(DataQualityIssue).where(DataQualityIssue.shipment_id == shipment.id, DataQualityIssue.issue_type == 'crm_blank_icris', DataQualityIssue.status == 'open'))
        assert issue is not None

        resp = client.post(f'/api/v1/data-quality/issues/{issue.id}/fix', json={'action': 'assign_company', 'company_id': str(company.id)})
        assert resp.status_code == 200, resp.text

        db.expire_all()
        refreshed_shipment = db.get(Shipment, shipment.id)
        assert refreshed_shipment.company_id == company.id
        assert refreshed_shipment.manually_matched is True
        refreshed_issue = db.get(DataQualityIssue, issue.id)
        assert refreshed_issue.status == 'resolved'
        assert refreshed_issue.resolved_by

        # A manual link must be sync-proof: rematch() must not disturb it.
        refreshed_shipment.source_icris_number = f'FIX-{suffix}'
        db.commit()
        result = rematch(db)
        assert result['manual_preserved'] >= 1
        db.expire_all()
        assert db.get(Shipment, shipment.id).company_id == company.id
        assert db.get(DataQualityIssue, issue.id).status == 'resolved'
    finally:
        db.rollback(); db.close()

def test_fix_rejects_action_not_matching_issue_type(client):
    db = SessionLocal(); suffix = uuid.uuid4().hex[:8]
    try:
        shipment = Shipment(shipment_number=f'BADFIX-{suffix}', source='crm')
        db.add(shipment); db.flush()
        assert link_icris(db, shipment, '', 'Some Shipper') == 'missing'
        db.commit()
        issue = db.scalar(select(DataQualityIssue).where(DataQualityIssue.shipment_id == shipment.id, DataQualityIssue.issue_type == 'crm_blank_icris'))
        resp = client.post(f'/api/v1/data-quality/issues/{issue.id}/fix', json={'action': 'merge', 'target_id': str(uuid.uuid4())})
        assert resp.status_code == 422
    finally:
        db.rollback(); db.close()
