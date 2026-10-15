"""Provider-budget codes need explicit Center evidence before claiming no AI dispatch.

No live requests. These codes can occur either at admission or after upstream402;
missing or contradictory details must preserve possible dispatch and one receipt.
"""
import os
from pathlib import Path
import sys
from unittest.mock import patch

import httpx
import pytest

_ancestor=Path(__file__).resolve().parents[1]
ROOT=Path(os.environ.get('TP_TEST_ROOT',str(_ancestor if (_ancestor/'api/backend').is_dir() else Path(__file__).resolve().parents[2]/'source/TextPhantom')))
sys.path.insert(0,str(ROOT/'api'))
from backend.ai import accounting
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.provider_contract import GenerationRequest
from backend.ai.providers import cloud_paid

EVIDENCE=[
    ('explicit_not_reserved',{'provider_dispatched':False,'credit_reserved':False,'credit_state':'not_reserved'},False),
    ('missing_details',None,True),
    ('only_provider_false',{'provider_dispatched':False},True),
    ('only_credit_false',{'credit_reserved':False},True),
    ('only_state',{'credit_state':'not_reserved'},True),
    ('contrary_upstream',{'provider_dispatched':False,'credit_reserved':False,'credit_state':'not_reserved','upstream_http_status':402},True),
    ('held',{'provider_dispatched':False,'credit_reserved':False,'credit_state':'held'},True),
    ('provider_true',{'provider_dispatched':True,'credit_reserved':False,'credit_state':'not_reserved'},True),
    ('credit_true',{'provider_dispatched':False,'credit_reserved':True,'credit_state':'not_reserved'},True),
]

@pytest.mark.parametrize('code,status',[('PAID_PROVIDER_KEY_LIMIT',503),('PAID_PROVIDER_CAPACITY',503),('PAID_PROVIDER_BALANCE',502)])
@pytest.mark.parametrize('evidence,details,possibly_dispatched',EVIDENCE,ids=[row[0] for row in EVIDENCE])
def test_provider_budget_admission_requires_explicit_negative_dispatch_evidence(code,status,evidence,details,possibly_dispatched):
    calls=[]
    class CenterClient:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):
            url = args[0]
            if url.endswith("/chat/receipt"): return httpx.Response(200, json={"found": False})
            if url.endswith("/price-quote"): return httpx.Response(200, json={"quote_token": "qa-fresh-quote"})
            assert url.endswith("/chat/completions")
            calls.append(True)
            error={'code':code}
            if details is not None:error['details']=details
            return httpx.Response(status,json={'error':error})
    request=GenerationRequest(provider='paid',model='qa/test',api_key='synthetic-wallet',
        system_text='Synthetic QA',user_parts=('Synthetic translation request',),cache_context={'operationId':'proof-'+evidence})
    with patch.object(cloud_paid,'center_base_url',lambda:'https://center.example'), \
         patch.object(cloud_paid,'center_origin',lambda:'https://center.example'), \
         patch.object(cloud_paid.httpx,'Client',CenterClient), \
         patch.object(cloud_paid.wire_trace,'provider_request'), \
         patch.object(cloud_paid.wire_trace,'write_json'), \
         patch.object(cloud_paid.diagnostics,'emit'):
        with accounting.receipt_scope('runsextension','proof-'+evidence):
            with pytest.raises(ProviderHttpError) as caught:
                accounting.generate_with_receipt(cloud_paid.ADAPTER,request)
            receipts=list(accounting._receipts.get())
    assert len(calls)==1
    assert caught.value.requestDispatched is possibly_dispatched
    assert len(receipts)==int(possibly_dispatched)
    if not possibly_dispatched:
        assert caught.value.providerAttempts==caught.value.generationAttempts==0
        assert caught.value.centerAdmissionRejected is True
    else:
        assert getattr(caught.value,'centerAdmissionRejected',False) is False
