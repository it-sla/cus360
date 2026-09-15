import os
os.environ.setdefault('SEED_DEMO_DATA','false')
test_url=os.environ.get('TEST_DATABASE_URL')
if test_url:
    import psycopg
    from alembic import command
    from alembic.config import Config
    db_name=test_url.rsplit('/',1)[-1]
    admin_url=test_url.rsplit('/',1)[0]+'/postgres'
    with psycopg.connect(admin_url.replace('postgresql+psycopg://','postgresql://'),autocommit=True) as conn:
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(db_name,)).fetchone():
            conn.execute(f'CREATE DATABASE "{db_name}"')
    os.environ['DATABASE_URL']=test_url
    command.upgrade(Config('alembic.ini'),'head')
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.db import SessionLocal
from app.models import User
from app.auth import hash_password
from sqlalchemy import select

# Most existing tests exercise admin-only flows (CRM sync, matching review, data
# quality, etc.) and predate role enforcement on those routes entirely — they were
# implicitly "admin" because nothing was gated. Now that require_role() actually
# checks, the shared client fixture logs in as a seeded super_admin test user so
# those tests keep exercising the same flows rather than getting 403s that have
# nothing to do with what they're actually testing. super_admin (not admin) because
# those routes — CRM sync, matching review, data quality, user/AE administration —
# now require super_admin specifically; plain admin was demoted to everything
# outside Data & Integration / Administration. Tests that specifically want to
# verify permission boundaries should build their own unauthenticated/other-role client.
@pytest.fixture(scope='session')
def client():
    db = SessionLocal()
    email = 'test-admin@customer360.test'
    user = db.scalar(select(User).where(User.email == email))
    if not user:
        user = User(email=email, display_name='Test Admin', role='super_admin', password_hash=hash_password('test-password-not-real'), is_active=True)
        db.add(user)
        db.commit()
    elif user.role != 'super_admin':
        user.role = 'super_admin'
        db.commit()
    db.close()
    c = TestClient(app)
    resp = c.post('/api/v1/auth/login', json={'email': email, 'password': 'test-password-not-real'})
    assert resp.status_code == 200, resp.text
    return c
