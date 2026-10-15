"""Existing extension API gateway contract; Center responses are test DTOs.
This does not substitute for Center ownership, signature or Stripe tests.
"""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.routes.paid import router

app=FastAPI();app.include_router(router)
identifier='ord_'+'a'*32
calls=[];checks=[]
def check(name,ok):
    checks.append({'name':name,'passed':bool(ok)})
    assert ok,name
async def center(path,**options):
    calls.append((path,options))
    if options.get('bearer') != 'customer-own-session':
        return 403,{'error':{'code':'ORDER_NOT_FOUND','message':'Order is unavailable for this account'}}
    return 200,{'id':identifier,'status':'waiting','amount_satang':5000,'qr':{'image_url':'data:image/png;base64,AA==','expires_at':None}}
with patch('backend.api.routes.paid.center_base_url',return_value='http://127.0.0.1:8787'),patch('backend.api.routes.paid.customer_request',side_effect=center),TestClient(app) as client:
    auth={'Authorization':'Bearer customer-own-session'}
    response=client.post('/paid/orders',headers=auth,json={'package_id':'pkg_test','package_version':1,'request_key':'idempotency-key-105'})
    check('Purchase forwarded to fixed Center customer endpoint with customer identity',response.status_code==200 and calls[-1][0]=='/api/customer/orders' and calls[-1][1]['bearer']=='customer-own-session')
    check('Browser sends package intent, never a Stripe credential or credit approval',calls[-1][1]['body']=={'package_id':'pkg_test','package_version':1,'request_key':'idempotency-key-105'})
    response=client.get('/paid/orders/'+identifier,headers=auth)
    check('QR order status read preserves safe DTO and no-store',response.json()['qr']['image_url'].startswith('data:image/png;base64,') and response.headers.get('Cache-Control')=='no-store' and calls[-1][0]=='/api/customer/orders/'+identifier)
    response=client.get('/paid/orders/'+identifier,headers={'Authorization':'Bearer other-customer'})
    check('Center ownership rejection reaches browser unchanged',response.status_code==403 and response.json()['error']['code']=='ORDER_NOT_FOUND')
    response=client.get('/paid/orders/'+identifier)
    check('Missing identity remains unauthenticated instead of gaining operator identity',response.status_code==403 and calls[-1][1]['bearer']=='')
    count=len(calls)
    check('Malformed order ID cannot select arbitrary Center route',client.get('/paid/orders/admin',headers=auth).status_code==422 and len(calls)==count)
    for path in ['/paid/orders/'+identifier+'/confirm','/paid/stripe/webhook','/paid/payment-intents','/paid/admin/approve']:
        check('No extension gateway payment authority route: '+path,client.post(path,headers=auth,json={}).status_code==404)
print(json.dumps({'scope':'Actual FastAPI extension gateway with mocked safe Center DTOs; no credentials, upstream Stripe calls or charges. Center security tested independently.', 'checks':checks,'total':len(checks),'passed':True},indent=2))
