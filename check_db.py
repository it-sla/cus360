import os
import sys
import psycopg

db_url = "postgresql://customer360:customer360_dev_password@localhost:5432/customer360"
try:
    with psycopg.connect(db_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM companies;")
            print("Total companies:", cur.fetchone()[0])
            cur.execute("SELECT count(*) FROM shipments;")
            print("Total shipments:", cur.fetchone()[0])
except Exception as e:
    print(e)
