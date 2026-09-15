import asyncio
from app.db import SessionLocal
from app.main import executive_dashboard

def main():
    db = SessionLocal()
    try:
        res = executive_dashboard(timeframe='this_month', db=db)
        print(res)
    except Exception as e:
        import traceback
        traceback.print_exc()
    finally:
        db.close()

main()
