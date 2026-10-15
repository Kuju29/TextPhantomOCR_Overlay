"""Real Paid controllers in Chromium; existing-order recovery with fake HTTP."""
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(Path(__file__).resolve().parents[2])))
Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
checks = []
scenarios = ['cancelled', 'expired', 'failed', 'poll_cancelled', 'account_failed', 'check_failed',
             'back_before_reply', 'terminal_before_reply', 'check_terminal_before_reply',
             'switch_order_before_reply', 'blocked', 'receipt', 'error']
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('TP_QA_CHROMIUM', '/usr/bin/chromium'), headless=True,
                                     args=['--no-sandbox', '--single-process', '--no-zygote', '--disable-dev-shm-usage'])
        context = browser.new_context()
        for surface in ['inline', 'account']:
            for scenario in scenarios:
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(base + '/TextPhantom/README.md?tab=buy')
                page.evaluate('''async ({surface,scenario})=>{
                  document.body.innerHTML='<div id="account"></div>';
                  window.calls=[];window.releaseReply=null;
                  window.order={id:'ord_'+'a'.repeat(32),status:scenario==='receipt'?'credited':'review_required',
                    recheck_allowed:scenario!=='blocked'&&scenario!=='receipt',method:'checkout',package_id:'qa',
                    package_version:1,package_name:'QA',amount_satang:2900,credits:250000,months:6};
                  window.fixture={email:'qa@example.com',credits:{available:0},purchase:{ready:true},
                    packages:[{id:'qa',version:1,name:'QA',price_satang:2900,credits:250000,months:6}],
                    history:{orders:{items:[order],total:1}}};
                  if(scenario==='switch_order_before_reply'){
                    fixture.history.orders.items.push({...order,id:'ord_'+'b'.repeat(32),package_name:'Other order',
                      package_id:'other',status:'waiting',recheck_allowed:false});
                    fixture.history.orders.total=2;
                  }
                  const store={paidSessionToken:'QA-customer-session',paidApiBase:location.origin,customApiUrl:location.origin};
                  window.chrome={runtime:{getURL:p=>location.origin+'/TextPhantom/src/'+p},storage:{local:{
                    get:(keys,cb)=>cb(Object.fromEntries(keys.map(k=>[k,store[k]]))),
                    set:(patch,cb)=>{Object.assign(store,patch);cb?.()}},onChanged:{addListener(){},removeListener(){}}}};
                  const nativeFetch=fetch.bind(window),respond=value=>new Response(JSON.stringify(value));
                  const transport=async(url,opts={})=>{
                    const path=new URL(url).pathname;
                    if(path==='/meta')return respond({});
                    if(path==='/paid/account')return respond(fixture);
                    if(path==='/paid/orders'){calls.push({path,body:opts.body});throw Error('Resume must not create an order');}
                    if(path.endsWith('/action')){
                      calls.push({path,body:JSON.parse(opts.body)});
                      if(scenario==='error')return new Response(JSON.stringify({error:{code:'QA_UNAVAILABLE',message:'QA recovery unavailable'}}),{status:503});
                      if(['back_before_reply','terminal_before_reply'].includes(scenario)||
                        ['check_terminal_before_reply','switch_order_before_reply'].includes(scenario)&&calls.length>1){
                        const pending={...order,status:scenario==='switch_order_before_reply'?'failed':'processing'};
                        return new Promise(resolve=>releaseReply=()=>resolve(respond(pending)));
                      }
                      order.status=['cancelled','expired','failed'].includes(scenario)?scenario:scenario==='check_failed'&&calls.length>1?'failed':'processing';
                      return respond(order);
                    }
                    if(path.startsWith('/paid/orders/'))return respond(fixture.history.orders.items.find(row=>path.endsWith(row.id)));
                    return nativeFetch(url,opts);
                  };
                  window.fetch=transport;
                  if(surface==='inline'){
                    const {createInlineAccount}=await import('/TextPhantom/src/paid/inline.js');
                    window.controller=createInlineAccount({mount:document.getElementById('account'),read:async()=>store,
                      write:async patch=>Object.assign(store,patch),fetchFn:transport});
                    controller.sync({active:true,base:location.origin,token:store.paidSessionToken});await controller.open('buy');
                  }else await import('/TextPhantom/src/paid/account.js');
                }''', {'surface': surface, 'scenario': scenario})
                if scenario == 'receipt':
                    page.get_by_role('button', name='Orders', exact=True).click()
                    page.get_by_role('button', name='View receipt', exact=True).click()
                else:
                    page.get_by_role('button', name='Resume payment', exact=True).first.click()
                if scenario in {'cancelled', 'expired', 'failed'}:
                    page.get_by_role('button', name='Select package', exact=True).wait_for()
                    assert page.locator('[data-account-view="buy"]').count() == 1
                    assert page.get_by_role('button', name='Resume payment', exact=True).count() == 0
                elif scenario == 'poll_cancelled':
                    page.locator('[data-account-view="payment"]').wait_for()
                    page.evaluate("order.status='cancelled'")
                    page.get_by_role('button', name='Select package', exact=True).wait_for(timeout=7000)
                elif scenario == 'account_failed':
                    page.locator('[data-account-view="payment"]').wait_for()
                    page.evaluate("order.status='failed'")
                    page.get_by_role('button', name='Reload', exact=True).click()
                    page.get_by_role('button', name='Select package', exact=True).wait_for()
                elif scenario == 'check_failed':
                    page.locator('[data-account-view="payment"]').wait_for()
                    page.get_by_role('button', name='Check payment status', exact=True).click()
                    page.get_by_role('button', name='Select package', exact=True).wait_for()
                elif scenario == 'back_before_reply':
                    page.wait_for_function('releaseReply!==null')
                    page.get_by_role('button', name='Back to packages', exact=True).click()
                    page.evaluate('releaseReply()')
                    page.wait_for_timeout(100)
                    assert page.locator('[data-account-view="buy"]').count() == 1
                elif scenario in {'terminal_before_reply', 'check_terminal_before_reply'}:
                    if scenario == 'check_terminal_before_reply':
                        page.locator('[data-account-view="payment"]').wait_for()
                        page.get_by_role('button', name='Check payment status', exact=True).click()
                    page.wait_for_function('releaseReply!==null')
                    page.evaluate("order.status='cancelled'")
                    page.get_by_role('button', name='Select package', exact=True).wait_for(timeout=7000)
                    page.evaluate('releaseReply()')
                    page.wait_for_timeout(100)
                    assert page.locator('[data-account-view="buy"]').count() == 1
                    assert page.get_by_role('button', name='Resume payment', exact=True).count() == 0
                elif scenario == 'switch_order_before_reply':
                    page.locator('[data-account-view="payment"]').wait_for()
                    page.get_by_role('button', name='Check payment status', exact=True).click()
                    page.wait_for_function('releaseReply!==null')
                    page.get_by_role('button', name='Back to packages', exact=True).click()
                    page.get_by_role('button', name='Orders', exact=True).click()
                    page.get_by_role('button', name='View payment', exact=True).nth(1).click()
                    selected = page.locator('[data-order-id="ord_' + 'b' * 32 + '"]')
                    selected.wait_for()
                    page.evaluate('releaseReply()')
                    page.wait_for_timeout(100)
                    assert selected.count() == 1 and page.locator('[data-account-view="payment"]').count() == 1
                elif scenario == 'error':
                    page.locator('.tp-account-note.warning').filter(has_text='QA recovery unavailable').wait_for(timeout=5000)
                    assert page.locator('[data-account-view="payment"]').count() == 1
                    assert page.get_by_role('button', name='Back to packages', exact=True).is_enabled()
                else:
                    page.locator('[data-account-view="payment"]').wait_for()
                calls = page.evaluate('calls')
                expected = 0 if scenario in {'blocked', 'receipt'} else 2 if scenario in {'check_failed', 'check_terminal_before_reply', 'switch_order_before_reply'} else 1
                assert len(calls) == expected, (surface, scenario, calls)
                assert all(call['path'].endswith('/action') and call['body'] == {'action': 'refresh'} for call in calls)
                assert not errors, (surface, scenario, errors)
                checks.append({'surface': surface, 'scenario': scenario, 'passed': True})
                print('PASS',surface,scenario,flush=True)
                page.close()
        browser.close()
finally:
    server.shutdown()
print(json.dumps({'checks': checks, 'passed': True}))
