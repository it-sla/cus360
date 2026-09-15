from pathlib import Path
from app.imports import MANIFEST_HEADERS,preview_manifest
def test_exact_header_contract():
    assert len(MANIFEST_HEADERS)==26
    assert MANIFEST_HEADERS[0]=='Shipment Number' and MANIFEST_HEADERS[1]=='Package Id'
    assert 'Importer Adresse 1' in MANIFEST_HEADERS and MANIFEST_HEADERS[-1]=='TND'
def test_real_sample_shape_when_present():
    path=Path('/samples/NP Manifest_ (004).xls')
    if not path.exists(): path=Path(__file__).parents[2]/'samples'/'NP Manifest_ (004).xls'
    if not path.exists(): return
    p=preview_manifest(path.read_bytes(),path.name)
    assert p['worksheet_name']=='Query2';assert p['headers']==MANIFEST_HEADERS;assert p['estimated_row_count']==37
    import pandas as pd
    df=pd.read_excel(path,sheet_name='Query2',engine='xlrd',dtype=object)
    assert df['Shipment Number'].nunique()==23
    assert df['Package Id'].nunique()==37
    assert (df.groupby('Shipment Number')['Package Id'].nunique()>1).sum()==5

