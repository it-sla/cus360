from app.database import SessionLocal
from sqlalchemy import text
db = SessionLocal()
sql = '''
    SELECT c1.normalized_name as prov, c2.normalized_name as mast, c1.is_provisional as p1, c2.is_provisional as p2,
           similarity(c1.normalized_name, c2.normalized_name) as sim,
           (c1.normalized_name LIKE c2.normalized_name || ' %') as like1,
           (c2.normalized_name LIKE c1.normalized_name || ' %') as like2
    FROM companies c1, companies c2
    WHERE c1.company_name ILIKE '%shree%' AND c2.company_name ILIKE '%shree%'
    AND c1.is_provisional = true AND c2.is_provisional = false
'''
rows = db.execute(text(sql)).mappings().all()
for r in rows:
    print(r)
