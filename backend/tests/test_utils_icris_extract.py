from app.utils import extract_icris_from_tracking

def test_extract_icris_from_ups_tracking():
    assert extract_icris_from_tracking('1ZR111490448804620')=='R11149'

def test_extract_icris_from_non_ups_tracking():
    assert extract_icris_from_tracking('NON_UPS_TRACKING') is None
