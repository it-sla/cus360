"""QA probe: CRM parser vs tests/fixtures/ and the 17-column source-spelling contract.
Read-only. Run: docker exec -i customer360-backend-1 python - < qa/test_parser.py
"""
import pathlib
from app.crm_parser import (ROW_HEADERS, PARSER_VERSION, parse_manifest_detail,
                            parse_manifest_list, CrmParseError, LoginRequired,
                            PartialManifestError, DuplicateTrackingConflict,
                            normalize_header)

FX = pathlib.Path("/app/tests/fixtures")

print("=== D1: 17-column contract ===")
print(f"  column count       : {len(ROW_HEADERS)}")
print(f"  parser version     : {PARSER_VERSION}")
print(f"  ROW_HEADERS        : {ROW_HEADERS}")
print(f"  'Icrisno' present  : {'Icrisno' in ROW_HEADERS}")
print(f"  'Tarriff Rate'     : {'Tarriff Rate' in ROW_HEADERS}")
print(f"  corrected spellings absent: "
      f"{'ICRIS No' not in ROW_HEADERS and 'Tariff Rate' not in ROW_HEADERS}")

print("\n=== D2: every fixture through the parser ===")
for f in sorted(FX.glob("*.html")):
    html = f.read_text(encoding="utf-8", errors="replace")
    label = f.name
    try:
        if "list" in label:
            rows = parse_manifest_list(html, "http://crm.example/")
            print(f"  {label:34} -> LIST ok, {len(rows)} rows, "
                  f"ids={[r['crm_manifest_id'] for r in rows][:3]}")
        else:
            d = parse_manifest_detail(html)
            print(f"  {label:34} -> DETAIL ok, rows={len(d.rows)} "
                  f"dupes={d.duplicate_row_count} warnings={len(d.warnings)} "
                  f"totals={ {k: str(v) for k, v in d.totals.items()} }")
            if d.rows:
                print(f"       raw keys of row0 == ROW_HEADERS: "
                      f"{list(d.rows[0]['raw'].keys()) == ROW_HEADERS}")
                print(f"       Icrisno value: {d.rows[0]['raw'].get('Icrisno')!r}  "
                      f"Tarriff Rate: {d.rows[0]['raw'].get('Tarriff Rate')!r}")
    except Exception as e:
        print(f"  {label:34} -> {type(e).__name__}({getattr(e,'code','-')}): {e}")

print("\n=== D3: header-contract enforcement (corrected spellings must be REJECTED) ===")
good = FX / "crm_manifest_detail.html"
html = good.read_text(encoding="utf-8", errors="replace")
for bad_from, bad_to, why in [
    ("Icrisno", "ICRIS No", "corrected Icrisno spelling"),
    ("Tarriff Rate", "Tariff Rate", "corrected Tarriff spelling"),
]:
    if bad_from not in html:
        print(f"  (skip {why}: token not in fixture)")
        continue
    try:
        parse_manifest_detail(html.replace(bad_from, bad_to))
        print(f"  ACCEPTED {why}  <-- contract NOT enforced")
    except CrmParseError as e:
        print(f"  rejected {why}: {type(e).__name__}({e.code})")

print("\n=== D4: normalize_header behaviour (what variance is tolerated) ===")
for probe in ["Icrisno", "ICRISNO", " icrisno ", "Icris no", "Tarriff Rate",
              "TARRIFF  RATE", "Tariff Rate", "Dest.", "Dest .", "Act wt"]:
    print(f"  {probe!r:18} -> {normalize_header(probe)!r}")

print("\n=== D5: structure-change must raise, never yield empty ===")
try:
    parse_manifest_detail("<html><body><table><tr><td>nothing</td></tr></table></body></html>")
    print("  ACCEPTED junk table  <-- would silently look like empty result")
except Exception as e:
    print(f"  rejected junk: {type(e).__name__}({getattr(e,'code','-')})")
