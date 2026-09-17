import pytest
from unittest.mock import patch, MagicMock


def _mk_company(db, tag, ae_code=None, customer_type=None):
    from app.models import Company
    from app.utils import normalize_name
    c = Company(icris_number=f'TAE-{tag}', company_name=f'Tae Test {tag}',
                normalized_name=normalize_name(f'Tae Test {tag}'), source='manual',
                assigned_ae_code=ae_code, customer_type=customer_type)
    db.add(c); db.flush()
    return c


def _cleanup(db, tag):
    from sqlalchemy import text
    db.rollback()
    db.execute(text("DELETE FROM shipments WHERE shipment_number LIKE :p"), {'p': f'%{tag}%'})
    db.execute(text("DELETE FROM companies WHERE icris_number LIKE :p"), {'p': f'TAE-{tag}%'})
    db.execute(text("DELETE FROM users WHERE email LIKE :p"), {'p': f'%{tag}%'})
    db.commit()
    db.close()


def test_tier_alerts_matches_sla_table():
    from app.tier_alerts import TIER_SHIPPING_SLA_DAYS
    assert TIER_SHIPPING_SLA_DAYS == {'Key Account': 7, 'Reseller': 7, 'Large Account': 15, 'SME': 30, 'Small Customer': 30}


def test_get_tier_shipping_gap_breaches_excludes_never_shipped_and_untiered(client):
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment
    from app.tier_alerts import get_tier_shipping_gap_breaches
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        overdue = _mk_company(db, f'{tag}-OVERDUE', customer_type='Key Account')
        never_shipped = _mk_company(db, f'{tag}-NEVER', customer_type='Key Account')
        untiered = _mk_company(db, f'{tag}-SMALL', customer_type=None)
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-OVERDUE', source='crm', company_id=overdue.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=8)))
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-SMALL', source='crm', company_id=untiered.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=8)))
        db.commit()

        breaches = get_tier_shipping_gap_breaches(db)
        ids = {b['company_id'] for b in breaches}
        assert str(overdue.id) in ids
        assert str(never_shipped.id) not in ids  # no shipment at all -> excluded
        assert str(untiered.id) not in ids       # Small Customer has no SLA
    finally:
        _cleanup(db, tag)


def test_send_tier_alert_digests_is_noop_when_disabled(client):
    """tier_alert_email_enabled=False must never touch smtplib.SMTP -- forced False here
    rather than relying on the environment's default, because a real environment with
    real SMTP credentials configured (as this one now has) would otherwise make this
    test send real emails to real people on every test run. This is not hypothetical:
    an earlier version of this test relied on the default and did exactly that."""
    from app.db import SessionLocal
    import app.email_notifications as en
    db = SessionLocal()
    try:
        with patch.object(en.settings, 'tier_alert_email_enabled', False), \
             patch('app.email_notifications.smtplib.SMTP') as mock_smtp:
            result = en.send_tier_alert_digests(db)
            mock_smtp.assert_not_called()
        assert result['enabled'] is False
    finally:
        db.close()


def test_send_tier_alert_digests_groups_by_ae_and_covers_admin(client):
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment, User
    from app.auth import hash_password
    import app.email_notifications as en
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    try:
        ae_user = User(email=f'ae-{tag}@test.example', display_name='Test AE', role='ae',
                       password_hash=hash_password('x'), is_active=True, ae_code=f'Z{tag[:3]}')
        db.add(ae_user); db.flush()

        co = _mk_company(db, f'{tag}-CO', ae_code=ae_user.ae_code, customer_type='Key Account')
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-CO', source='crm', company_id=co.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=9)))
        db.commit()

        mock_server = MagicMock()
        mock_smtp_cm = MagicMock()
        mock_smtp_cm.__enter__.return_value = mock_server
        with patch.object(en.settings, 'tier_alert_email_enabled', True), \
             patch.object(en.settings, 'smtp_username', 'fake@gmail.com'), \
             patch.object(en.settings.smtp_password, 'get_secret_value', return_value='fake-app-password'), \
             patch('app.email_notifications.smtplib.SMTP', return_value=mock_smtp_cm) as mock_smtp:
            result = en.send_tier_alert_digests(db)

        assert result['enabled'] is True
        assert result['total_breaches'] >= 1
        assert result['ae_emails_sent'] >= 1
        assert result['admin_emails_sent'] >= 0  # depends on seeded admin users existing
        assert mock_smtp.called
        assert mock_server.login.called
        sent_to = [call.args[1] for call in mock_server.sendmail.call_args_list]
        assert [ae_user.email] in sent_to
    finally:
        _cleanup(db, tag)


def test_send_tier_alert_digests_skips_empty(client):
    """With enabled=True but zero breaches, must not send anything (no empty-inbox spam)."""
    from app.db import SessionLocal
    import app.email_notifications as en
    db = SessionLocal()
    try:
        with patch.object(en.settings, 'tier_alert_email_enabled', True), \
             patch.object(en.settings, 'smtp_username', 'fake@gmail.com'), \
             patch.object(en.settings.smtp_password, 'get_secret_value', return_value='fake-app-password'), \
             patch('app.email_notifications.get_tier_shipping_gap_breaches', return_value=[]), \
             patch('app.email_notifications.smtplib.SMTP') as mock_smtp:
            result = en.send_tier_alert_digests(db)
        mock_smtp.assert_not_called()
        assert result['total_breaches'] == 0
    finally:
        db.close()


def test_send_tier_alert_emails_admin_endpoint_requires_admin():
    from fastapi.testclient import TestClient
    from app.main import app
    anon_client = TestClient(app)
    res = anon_client.post('/api/v1/admin/tier-alerts/send-emails')
    assert res.status_code in (401, 403)


def test_send_tier_alert_emails_admin_endpoint_returns_summary(client):
    """Mocks smtplib regardless of whether real SMTP credentials are configured in this
    environment -- hitting the real endpoint unmocked previously sent real emails to
    real AEs/admins on every test run once .env had working credentials in it. A test
    must never depend on the surrounding environment's config to stay safe."""
    with patch('app.email_notifications.smtplib.SMTP') as mock_smtp:
        res = client.post('/api/v1/admin/tier-alerts/send-emails')
    assert res.status_code == 200
    body = res.json()
    assert 'enabled' in body and 'total_breaches' in body
    if body['enabled']:
        assert mock_smtp.called
    else:
        mock_smtp.assert_not_called()


def _mk_breach(tag, ae_code, customer_type, days_since, sla_days):
    return {'company_id': f'id-{tag}', 'company_name': f'Company {tag}', 'customer_type': customer_type,
            'assigned_ae_code': ae_code, 'days_since': days_since, 'sla_days': sla_days,
            'days_overdue': days_since - sla_days}


def test_format_ae_digest_contains_html_table_and_company_names():
    from app.email_notifications import _format_ae_digest
    breaches = [_mk_breach('A', 'Z1', 'Key Account', 12, 7), _mk_breach('B', 'Z1', 'SME', 20, 15)]
    text_body, html_body = _format_ae_digest(breaches)
    assert '<table' in html_body
    assert 'Company A' in html_body and 'Company B' in html_body
    assert 'Company A' in text_body and 'Company B' in text_body


def test_format_admin_summary_is_aggregate_not_full_dump(client):
    from app.db import SessionLocal
    from app.email_notifications import _format_admin_summary, _WORST_OFFENDERS_LIMIT
    db = SessionLocal()
    try:
        breaches = [_mk_breach(str(i), 'Z1', 'Key Account', 30 - i, 7) for i in range(_WORST_OFFENDERS_LIMIT + 3)]
        text_body, html_body = _format_admin_summary(breaches, db)
        assert 'By AE' in html_body and 'By Tier' in html_body and 'Worst Offenders' in html_body
        assert 'Z1' in html_body
        # Worst-offenders section only lists the top N -- a company past that cutoff
        # (the lowest days_since, appended last) must not appear anywhere in the summary.
        tail_company = breaches[-1]['company_name']
        assert tail_company not in html_body
        assert tail_company not in text_body
    finally:
        db.close()


def _immediate_notified_state_query():
    from sqlalchemy import select
    from app.models import CrmSyncState
    return select(CrmSyncState).where(CrmSyncState.entity_type == 'tier_breach_immediate_notified')


def _snapshot_immediate_notified_state(db):
    """Immediate-breach notified state is a single shared CrmSyncState row (real DB, not
    per-test-isolated) -- snapshot/restore it around tests so a test run doesn't
    permanently mark real companies as already-notified or vice versa."""
    row = db.scalar(_immediate_notified_state_query())
    return dict(row.cursor_json) if row and row.cursor_json else None


def _restore_immediate_notified_state(db, snapshot):
    from app.models import CrmSyncState
    row = db.scalar(_immediate_notified_state_query())
    if row is None:
        if snapshot is not None:
            db.add(CrmSyncState(entity_type='tier_breach_immediate_notified', cursor_json=snapshot))
    else:
        row.cursor_json = snapshot
    db.commit()


def test_send_immediate_tier_breach_emails_sends_for_all_tiers(client):
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment, User
    from app.auth import hash_password
    import app.email_notifications as en
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    snapshot = _snapshot_immediate_notified_state(db)
    try:
        ae_user = User(email=f'ae-{tag}@test.example', display_name='Test AE', role='ae',
                       password_hash=hash_password('x'), is_active=True, ae_code=f'Z{tag[:3]}')
        db.add(ae_user); db.flush()

        key_acct = _mk_company(db, f'{tag}-KEY', ae_code=ae_user.ae_code, customer_type='Key Account')
        sme = _mk_company(db, f'{tag}-SME', ae_code=ae_user.ae_code, customer_type='SME')
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-KEY', source='crm', company_id=key_acct.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=9)))
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-SME', source='crm', company_id=sme.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=35)))
        db.commit()

        mock_server = MagicMock()
        mock_smtp_cm = MagicMock()
        mock_smtp_cm.__enter__.return_value = mock_server
        with patch.object(en.settings, 'tier_alert_email_enabled', True), \
             patch.object(en.settings, 'smtp_username', 'fake@gmail.com'), \
             patch.object(en.settings.smtp_password, 'get_secret_value', return_value='fake-app-password'), \
             patch('app.email_notifications.smtplib.SMTP', return_value=mock_smtp_cm) as mock_smtp:
            result = en.send_immediate_tier_breach_emails(db)

        assert result['enabled'] is True
        assert result['new_breaches'] >= 2  # both Key Account and SME must be included
        assert mock_smtp.called
        sent_to = [call.args[1] for call in mock_server.sendmail.call_args_list]
        assert [ae_user.email] in sent_to
        sent_bodies = [call.args[2] for call in mock_server.sendmail.call_args_list]
        assert any(sme.company_name in body for body in sent_bodies)
    finally:
        _restore_immediate_notified_state(db, snapshot)
        _cleanup(db, tag)


def test_send_immediate_tier_breach_emails_does_not_resend_same_breach(client):
    import uuid
    from datetime import date, timedelta
    from decimal import Decimal
    from app.db import SessionLocal
    from app.models import Shipment, User
    from app.auth import hash_password
    import app.email_notifications as en
    db = SessionLocal()
    tag = uuid.uuid4().hex[:8].upper()
    snapshot = _snapshot_immediate_notified_state(db)
    try:
        ae_user = User(email=f'ae-{tag}@test.example', display_name='Test AE', role='ae',
                       password_hash=hash_password('x'), is_active=True, ae_code=f'Z{tag[:3]}')
        db.add(ae_user); db.flush()
        co = _mk_company(db, f'{tag}-RESELLER', ae_code=ae_user.ae_code, customer_type='Reseller')
        db.add(Shipment(shipment_number=f'TAESHIP-{tag}-RESELLER', source='crm', company_id=co.id,
                        pay_term='PP', bill_amount=Decimal('10'), shipment_date=date.today() - timedelta(days=9)))
        db.commit()

        mock_server = MagicMock()
        mock_smtp_cm = MagicMock()
        mock_smtp_cm.__enter__.return_value = mock_server
        with patch.object(en.settings, 'tier_alert_email_enabled', True), \
             patch.object(en.settings, 'smtp_username', 'fake@gmail.com'), \
             patch.object(en.settings.smtp_password, 'get_secret_value', return_value='fake-app-password'), \
             patch('app.email_notifications.smtplib.SMTP', return_value=mock_smtp_cm):
            first = en.send_immediate_tier_breach_emails(db)
            second = en.send_immediate_tier_breach_emails(db)

        assert first['new_breaches'] >= 1
        assert second['new_breaches'] == 0
    finally:
        _restore_immediate_notified_state(db, snapshot)
        _cleanup(db, tag)


def test_send_email_builds_multipart_with_text_and_html_parts():
    from unittest.mock import patch, MagicMock
    import app.email_notifications as en
    mock_server = MagicMock()
    mock_smtp_cm = MagicMock()
    mock_smtp_cm.__enter__.return_value = mock_server
    with patch.object(en.settings, 'smtp_username', 'fake@gmail.com'), \
         patch.object(en.settings.smtp_password, 'get_secret_value', return_value='fake-app-password'), \
         patch('app.email_notifications.smtplib.SMTP', return_value=mock_smtp_cm):
        ok = en._send_email('to@test.example', 'Subject', 'plain text body', '<p>html body</p>')
    assert ok is True
    sent_msg = mock_server.sendmail.call_args.args[2]
    assert 'Content-Type: multipart/alternative' in sent_msg
    assert 'text/plain' in sent_msg and 'text/html' in sent_msg
