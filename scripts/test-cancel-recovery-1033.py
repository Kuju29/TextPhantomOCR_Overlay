"""Real shared view in Chromium; synthetic orders, no Stripe execution."""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
import os
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[2]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server = ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(root)))
Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path=chromium_executable(),args=['--no-sandbox','--single-process','--no-zygote','--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width':470,'height':560})
    page = context.new_page()
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(f'http://127.0.0.1:{server.server_port}/TextPhantom/README.md')
    page.evaluate('''async()=>{
      const {renderCustomerAccount}=await import('/TextPhantom/src/shared/customer-portal/view.js');
      window.render=renderCustomerAccount;
      window.account={credits:{available:0},purchase:{ready:true},packages:[{id:'starter',version:1,name:'Starter',price_satang:2900,credits:250000,months:6}],history:{orders:{items:[],total:0}}};
      window.order={id:'old',package_id:'starter',package_version:1,package_name:'Starter',amount_satang:2900,credits:250000,months:6,status:'review_required',method:'promptpay',cancel_pending:true,cancellation_failed:true,cancel_allowed:true,recheck_allowed:true,cancellation_error:{error_code:'STRIPE_PI_PERMISSION',provider_request_id:'req_CancelQA'}};
      window.actions=[];
      window.show=(tab='payment')=>{document.body.replaceChildren(render({...account,history:{orders:{items:[order],total:1}}},{tab,activeOrder:order,compact:true,onViewOrder:()=>show('payment'),onOrderAction:(o,a)=>actions.push(a)}))};
    }''')
    for method in ['promptpay','checkout']:
        page.evaluate("m=>{order.method=m;order.cancel_allowed=true;order.recheck_allowed=true;actions=[];show()}",method)
        assert page.get_by_role('button',name='Check payment status').is_visible()
        assert page.get_by_role('button',name='Retry cancellation').is_visible()
        assert 'req_CancelQA' in page.locator('body').inner_text()
        page.get_by_role('button',name='Check payment status').click()
        page.get_by_role('button',name='Retry cancellation').click()
        assert page.evaluate('actions') == ['refresh','cancel']
        page.evaluate("show('buy')")
        assert 'Needs attention' in page.locator('.tp-account-pending').inner_text()
        assert page.get_by_role('button',name='Resume payment',exact=True).is_visible()
        page.get_by_role('button',name='Resume payment',exact=True).click()
        assert page.locator('[data-account-view="payment"]').count() == 1
        assert page.get_by_role('button',name='Retry cancellation').is_visible()
        page.evaluate("()=>{order.cancel_allowed=false;order.recheck_allowed=false;show()}")
        assert page.get_by_role('button',name='Retry cancellation').count() == 0
        assert page.get_by_role('button',name='Check payment status').count() == 0
        assert 'operator must verify' in page.locator('body').inner_text()
    page.evaluate("()=>{Object.assign(order,{status:'waiting',method:'checkout',cancel_pending:false,cancellation_failed:false,checkout_url:'https://checkout.stripe.com/c/pay/cs_QA',checkout_expires_at:Date.now()+60000,cancel_allowed:true,recheck_allowed:true});show()}")
    assert page.get_by_role('link',name='Open Stripe checkout').get_attribute('href') == 'https://checkout.stripe.com/c/pay/cs_QA'
    assert page.get_by_role('button',name='Cancel this payment').is_visible()
    page.evaluate("()=>{Object.assign(order,{status:'creating',method:'checkout',checkout_url:null,cancel_allowed:true});show()}")
    assert page.get_by_role('button',name='Cancel this payment').is_visible()
    page.evaluate("()=>{Object.assign(order,{status:'cancelled',cancel_allowed:false});show('buy')}")
    assert page.get_by_role('button',name='Select package').is_visible()
    assert page.get_by_role('button',name='Resume payment').count() == 0
    assert not errors,errors
    browser.close()
server.shutdown()
print('5 native view cases passed: PI/Checkout recovery actions, open Checkout, unsent cancellation, closed package selection')
