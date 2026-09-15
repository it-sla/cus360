import uuid

def test_company_dossier_pdf(client):
    suffix = uuid.uuid4().hex[:8]
    create_res = client.post('/api/v1/companies', json={'icris_number': f'DOSSIER-{suffix}', 'company_name': f'PDF Dossier Test Co {suffix}'})
    assert create_res.status_code == 201
    company_id = create_res.json()['id']
    
    res = client.get(f"/api/v1/companies/{company_id}/dossier-pdf")
    assert res.status_code == 200
    assert res.headers.get("content-type") == "application/pdf"
    assert len(res.content) > 1000
    assert res.content.startswith(b"%PDF")
