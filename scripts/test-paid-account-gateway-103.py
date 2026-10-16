"""Explicit gateway routes and preservation of the real upstream status."""
import os, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
os.environ["TP_CENTER_URL"] = "http://127.0.0.1:8787"
# The busy-admission wait queue (≤90 s) is covered by test-paid-admission-wait-10466.py;
# here a busy answer must surface at once so its evidence can be checked.
os.environ["TP_PAID_ADMISSION_WAIT_SECONDS"] = "0"
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.routes.paid import router
from backend.ai.providers.cloud_paid import ADAPTER
from backend.ai.provider_contract import GenerationRequest
from backend.ai.clients.provider_error import ProviderHttpError
from backend.ai.failure_reason import provider_http_failure, is_rate_limited
import httpx
from paid_center_fake import HealthzClient, reset_protocol_cache
app=FastAPI();app.include_router(router);calls=[];checks=[]
def check(name,ok):
    checks.append({'name':name,'passed':bool(ok)});assert ok,name
async def proxy(path,**kwargs):
    calls.append((path,kwargs));return 200,{'ok':True,'path':path}
with patch('backend.api.routes.paid.center_base_url',return_value='http://127.0.0.1:8787'),patch('backend.api.routes.paid.customer_request',side_effect=proxy),TestClient(app) as c:
    auth={'Authorization':'Bearer customer-session'}
    r=c.get('/paid/account',headers=auth)
    check('Account gateway uses fixed Center path',r.status_code==200 and calls[-1][0]=='/api/customer/account' and calls[-1][1]['bearer']=='customer-session')
    refund_body={'payment_id':'pay_'+'b'*32,'request_key':'r'*32}
    check('Refund request uses fixed authenticated Center route',c.post('/paid/refunds',headers=auth,json=refund_body).status_code==200 and calls[-1][0]=='/api/customer/refunds' and calls[-1][1]['body']==refund_body and calls[-1][1]['bearer']=='customer-session')
    c.get('/paid/history?kind=refunds&offset=0&limit=25',headers=auth)
    check('Refund history is explicitly forwarded',calls[-1][0]=='/api/customer/history?kind=refunds&offset=0&limit=25')
    check('Account response is non-cacheable',r.headers['cache-control']=='no-store')
    r=c.get('/paid/history?kind=usage&offset=25&limit=25',headers=auth)
    check('History paging forwarded with bounded parameters',calls[-1][0]=='/api/customer/history?kind=usage&offset=25&limit=25')
    c.get('/paid/history?kind=ledger&offset=0&limit=25&ledger_filter=admin',headers=auth)
    check('Owned ledger filter forwarded explicitly',calls[-1][0]=='/api/customer/history?kind=ledger&offset=0&limit=25&ledger_filter=admin')
    n=len(calls);check('Unbounded history request is refused',c.get('/paid/history?kind=usage&limit=1001').status_code==422 and len(calls)==n)
    identifier='ord_'+'a'*32
    check('Order creation is explicit proxy',c.post('/paid/orders',headers=auth,json={'package_id':'pkg_qa','package_version':1,'request_key':'a'*16}).status_code==200 and calls[-1][0]=='/api/customer/orders')
    check('Order submit path fixed and ownership belongs to Center',c.post('/paid/orders/'+identifier+'/action',headers=auth,json={'action':'submit'}).status_code==200 and calls[-1][0]=='/api/customer/orders/'+identifier+'/action')
    n=len(calls);check('Unknown order identifier cannot select arbitrary Center path',c.post('/paid/orders/admin/action',json={'action':'submit'}).status_code==422 and len(calls)==n)
    check('No customer gateway endpoint can approve payment',c.post('/paid/orders/'+identifier+'/confirm',json={}).status_code==404)
# The synthetic Center also answers the Paid protocol health read.
reset_protocol_cache()
class Provider(HealthzClient):
    def post(self,url,**kwargs):return httpx.Response(502,json={'error':{'code':'PAID_PROVIDER_ROUTE','message':'No matching route','request_id':'center103','details':{'upstream_http_status':404,'provider_error_category':'price_filter','credit_state':'released','next_action':'inspect_model_route'}}})
with patch('backend.ai.providers.cloud_paid.httpx.Client',Provider):
    try:ADAPTER.generate(GenerationRequest(provider='paid',model='qa/test',api_key='customer-session',system_text='QA',user_parts=('hello',),cache_context={'operationId':'paid-account-103'}))
    except ProviderHttpError as e:
        f=provider_http_failure(e)
        check('Actual supplier 404 and Center 502 stay distinguishable',e.status==404 and e.center_http_status==502)
        check('Paid routing error never auto-retries generation',f.code=='paid_provider_route' and not f.retryable)
    else:raise AssertionError('Expected provider failure')
for code,status,expected in [('PAID_ACCOUNT_RESTRICTED',403,'paid_account_restricted'),
        ('PAID_CAPACITY_BUSY',429,'paid_capacity_busy'),
        ('PAID_PROVIDER_CAPACITY',503,'paid_provider_capacity'),
        ('PAID_PROVIDER_KEY_LIMIT',503,'paid_provider_key_limit')]:
    class CapacityProvider(Provider):
        def post(self,url,**kwargs):
            return httpx.Response(status,json={'error':{'code':code,'message':'Synthetic capacity refusal',
                'details':{'automatic_retry':False}}})
    with patch('backend.ai.providers.cloud_paid.httpx.Client',CapacityProvider):
        try:ADAPTER.generate(GenerationRequest(provider='paid',model='qa/test',api_key='customer-session',system_text='QA',user_parts=('hello',),cache_context={'operationId':'capacity-'+code}))
        except ProviderHttpError as e:
            f=provider_http_failure(e)
            check(code+' retains reason without provider rate gate or automatic retry',f.code==expected and not f.retryable and not is_rate_limited(e) and f.retry_after==0)
        else:raise AssertionError('Expected capacity refusal')
print(json.dumps({'scope':'Isolated FastAPI gateway and mocked Center errors; no external calls','checks':checks,'total':len(checks),'passed':True},indent=2))
