"""QA probe: exercises Key data rules against the live schema inside a transaction
that is ALWAYS rolled back. Nothing is committed. Run via:
    docker exec -i customer360-backend-1 python - < qa/test_data_rules.py
"""
import uuid
from datetime import date
from decimal import Decimal

from app.db import SessionLocal
from app.models import Company, Shipment, CrmSyncRun
from app.crm_sync import link_icris, exact_company, upsert_detail
from app.crm_parser import ManifestDetail

results = []


def check(name, got, expect, rule=""):
    ok = got == expect
    results.append((ok, name, got, expect, rule))
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      got={got!r} expect={expect!r}"
          + (f"\n      rule: {rule}" if rule else ""))


db = SessionLocal()
try:
    tag = uuid.uuid4().hex[:8].upper()
    ICRIS = f"QA{tag}"

    # ---- 1. provisional creation on new valid ICRIS
    s1 = Shipment(shipment_number=f"QA-TRK-1-{tag}", source="crm")
    db.add(s1); db.flush()
    r = link_icris(db, s1, ICRIS, "QA Test Shipper Ltd")
    db.flush()
    c1 = exact_company(db, ICRIS)
    check("C-1 new valid ICRIS -> matched", r, "matched", "Provisional companies created by CRM sync")
    check("C-2 provisional company created", bool(c1 and c1.is_provisional), True,
          "Provisional companies are created when a valid new ICRIS appears")

    # ---- 2. repeated ICRIS reuses same company
    s2 = Shipment(shipment_number=f"QA-TRK-2-{tag}", source="crm")
    db.add(s2); db.flush()
    link_icris(db, s2, ICRIS, "QA Test Shipper Ltd")
    db.flush()
    check("C-3 repeated ICRIS reuses company", s2.company_id, c1.id,
          "Repeated ICRIS values reuse the same company")

    # ---- 3. case-insensitive + trimmed ICRIS matching
    s3 = Shipment(shipment_number=f"QA-TRK-3-{tag}", source="crm")
    db.add(s3); db.flush()
    link_icris(db, s3, f"  {ICRIS.lower()}  ", "QA Test Shipper Ltd")
    db.flush()
    check("C-4 ICRIS match is case-insensitive+trimmed", s3.company_id, c1.id,
          "ICRIS matching is exact, case-insensitive, trimmed")

    # ---- 4. blank ICRIS -> icris_missing, stays unlinked
    s4 = Shipment(shipment_number=f"QA-TRK-4-{tag}", source="crm")
    db.add(s4); db.flush()
    r4 = link_icris(db, s4, "   ", "Some Shipper")
    check("C-5 blank ICRIS -> missing", r4, "missing", "Blank ICRIS remains valid but unlinked")
    check("C-6 blank ICRIS leaves company unset", s4.company_id, None)
    check("C-7 blank ICRIS status", s4.match_status, "icris_missing")

    # ---- 5. MANUAL LINK PROTECTION
    other = Company(icris_number=f"QAOTHER{tag}", company_name="QA Other Co",
                    normalized_name="qa other co", source="manual")
    db.add(other); db.flush()
    s5 = Shipment(shipment_number=f"QA-TRK-5-{tag}", source="crm",
                  company_id=other.id, manually_matched=True, is_manually_matched=True,
                  match_status="manually_linked")
    db.add(s5); db.flush()
    r5 = link_icris(db, s5, ICRIS, "QA Test Shipper Ltd")
    db.flush()
    check("C-8 manual link preserved (return)", r5, "manual",
          "Manual company links are never overwritten")
    check("C-9 manual link company unchanged", s5.company_id, other.id,
          "Manual company links are never overwritten")

    # ---- 6. FUZZY: confirm no fuzzy path can auto-apply a company link
    s6 = Shipment(shipment_number=f"QA-TRK-6-{tag}", source="crm")
    db.add(s6); db.flush()
    # name matches an existing company exactly, but ICRIS is blank
    r6 = link_icris(db, s6, "", "QA Other Co")
    check("C-10 exact NAME match with blank ICRIS does NOT link", s6.company_id, None,
          "Fuzzy name matching is suggestion-only and never auto-applied")

    # ---- 7. BLANK CELLS MUST NOT ERASE on CRM upsert
    run = CrmSyncRun(sync_type="qa", status="running", direction="export")
    db.add(run); db.flush()

    hdr = {"MAWB": f"QA{tag}", "Date": "07/16/2026", "manifest_date": date(2026, 7, 16),
           "Flight No": "QA100", "From": "KTM", "TO": "HKG",
           "Exchange Rate": "", "Fuel Surcharge": ""}

    def mkrow(track, icris, shipper, consignee, dest, actwt, pcs, billamt):
        raw = {"SN": "1", "Tracking No.": track, "Bill Type": "PP", "Icrisno": icris,
               "Shipper": shipper, "Consignee": consignee, "Dest.": dest,
               "Act wt": actwt, "Pcs": pcs, "Dim wt": "", "Pay Term": "",
               "Bill no.": "", "Bill amt": billamt, "Gross amt": "",
               "Tarriff Rate": "", "AE": "", "Delivery": ""}
        parsed = {"Act wt": Decimal(actwt) if actwt else None,
                  "Pcs": Decimal(pcs) if pcs else None,
                  "Dim wt": None, "Bill amt": Decimal(billamt) if billamt else None,
                  "Gross amt": None, "Tarriff Rate": None}
        return {"source_row_number": 1, "raw": raw, "parsed": parsed, "warnings": []}

    trk = f"QA-UPSERT-{tag}"
    d1 = ManifestDetail(hdr, {"pp_weight": Decimal("10"), "pp_pieces": Decimal("2")},
                        [mkrow(trk, ICRIS, "Original Shipper", "Original Consignee",
                               "HKG", "10", "2", "500")], [])
    d1.source_checksum = "qa-checksum-1"
    upsert_detail(db, run, d1, "http://qa/1", None, "export", f"QAM{tag}", False)
    db.flush()
    sh = db.scalar(Shipment.__table__.select().where(Shipment.shipment_number == trk))
    sh_obj = db.query(Shipment).filter(Shipment.shipment_number == trk).one()
    check("C-11 first upsert populated consignee", sh_obj.importer_name, "Original Consignee")
    check("C-12 first upsert populated bill_amount", sh_obj.bill_amount, Decimal("500.00"))

    # second manifest: blanks for consignee + bill amount
    d2 = ManifestDetail(hdr, {"pp_weight": Decimal("10"), "pp_pieces": Decimal("2")},
                        [mkrow(trk, ICRIS, "Updated Shipper", "", "HKG", "10", "2", "")], [])
    d2.source_checksum = "qa-checksum-2"
    upsert_detail(db, run, d2, "http://qa/2", None, "export", f"QAM{tag}", False)
    db.flush()
    db.refresh(sh_obj)
    check("C-13 blank consignee did NOT erase", sh_obj.importer_name, "Original Consignee",
          "Blank cells never erase existing values")
    check("C-14 blank bill amount did NOT erase", sh_obj.bill_amount, Decimal("500.00"),
          "Blank cells never erase existing values")
    check("C-15 non-blank shipper DID update", sh_obj.shipper_name, "Updated Shipper")

    # ---- 8. MANUAL FIELD OVERRIDE on shipment fields
    sh_obj.importer_name = "MANUALLY EDITED"
    sh_obj.shipment_date = date(2020, 1, 1)
    sh_obj.manual_override_fields = ["importer_name", "shipment_date"]
    db.flush()
    d3 = ManifestDetail(hdr, {"pp_weight": Decimal("10"), "pp_pieces": Decimal("2")},
                        [mkrow(trk, ICRIS, "Third Shipper", "CRM Consignee",
                               "HKG", "10", "2", "700")], [])
    d3.source_checksum = "qa-checksum-3"
    upsert_detail(db, run, d3, "http://qa/3", None, "export", f"QAM{tag}", False)
    db.flush()
    db.refresh(sh_obj)
    check("C-16 manual override on importer_name respected", sh_obj.importer_name,
          "MANUALLY EDITED", "Manual overrides are never overwritten")
    check("C-17 manual override on shipment_date respected", sh_obj.shipment_date,
          date(2020, 1, 1), "Manual overrides are never overwritten")

finally:
    db.rollback()
    db.close()

print("\n" + "=" * 60)
bad = [r for r in results if not r[0]]
print(f"{len(results)-len(bad)}/{len(results)} passed, {len(bad)} FAILED")
for _, name, got, expect, rule in bad:
    print(f"  FAILED: {name}  got={got!r} expect={expect!r}")
