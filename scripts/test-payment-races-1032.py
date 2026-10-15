"""Production controllers in Chromium; deferred synthetic account/order responses."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
import os, json
from playwright.sync_api import sync_playwright
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,*args):pass
srv=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(Path(__file__).resolve().parents[2])))
Thread(target=srv.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{srv.server_port}'
with sync_playwright() as pw:
 b=pw.chromium.launch(executable_path=os.environ.get('TP_QA_CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--single-process','--no-zygote'])
 context=b.new_context();checks=[]
 for surface in ['inline','account']:
  for race in ['old_account_after_cancel','fresh_account_before_poll']:
   page=context.new_page();errors=[];page.on('pageerror',lambda err:errors.append(str(err)))
   page.goto(base+'/TextPhantom/README.md?tab=buy')
   page.evaluate('''async surface=>{
    document.body.innerHTML='<div id="account"></div>';
    const id='ord_'+'a'.repeat(32);
    window.order={id,status:'waiting',method:'checkout',package_id:'qa',package_version:1,package_name:'QA',amount_satang:2900,credits:250000,months:6};
    window.fixture={email:'qa@example.com',credits:{available:0},purchase:{ready:true},packages:[{id:'qa',version:1,name:'QA',price_satang:2900,credits:250000,months:6}],history:{orders:{items:[order],total:1}}};
    window.cancelNow=false;window.deferNext=false;window.deferred=null;
    const store={paidSessionToken:'QA-customer-session',paidApiBase:location.origin,customApiUrl:location.origin};
    window.chrome={runtime:{getURL:path=>location.origin+'/TextPhantom/src/'+path},storage:{local:{get:(keys,cb)=>cb(Object.fromEntries(keys.map(k=>[k,store[k]]))),set:(patch,cb)=>{Object.assign(store,patch);cb?.()}},onChanged:{addListener(){},removeListener(){}}}};
    const nativeFetch=window.fetch.bind(window);
    const transport=async(url,opts)=>{
     const path=new URL(url).pathname;
     if(path==='/meta')return new Response('{}');
     if(path==='/paid/account'){
      const dto=structuredClone(fixture);if(cancelNow)dto.history.orders.items[0].status='cancelled';
      if(deferNext){deferNext=false;return new Promise(r=>deferred=()=>r(new Response(JSON.stringify(dto))))}
      return new Response(JSON.stringify(dto));
     }
     if(path.startsWith('/paid/orders/'))return new Response(JSON.stringify({...order,status:cancelNow?'cancelled':'waiting'}));
     return nativeFetch(url,opts);
    };
    window.fetch=transport;
    if(surface==='inline'){
     const {createInlineAccount}=await import('/TextPhantom/src/paid/inline.js');
     window.controller=createInlineAccount({mount:document.getElementById('account'),read:async()=>store,write:async patch=>Object.assign(store,patch),fetchFn:transport});
     controller.sync({active:true,base:location.origin,token:store.paidSessionToken});await controller.open('buy');
    }else await import('/TextPhantom/src/paid/account.js');
   }''',surface)
   page.get_by_role('button',name='Resume payment',exact=True).wait_for()
   if race=='old_account_after_cancel':
    page.evaluate('deferNext=true');page.get_by_role('button',name='Reload',exact=True).click()
    page.wait_for_function('deferred!==null');page.evaluate('cancelNow=true')
    page.get_by_role('button',name='Select package',exact=True).wait_for(timeout=7000)
    page.evaluate('deferred()')
   else:
    page.evaluate('cancelNow=true');page.get_by_role('button',name='Reload',exact=True).click()
   page.get_by_role('button',name='Select package',exact=True).wait_for()
   page.get_by_role('button',name='Reload',exact=True).click()
   page.get_by_role('button',name='Select package',exact=True).wait_for()
   assert page.get_by_role('button',name='Resume payment',exact=True).count()==0
   assert not errors,errors
   checks.append({'surface':surface,'race':race,'passed':True});page.close()
 page=context.new_page();page.goto(base+'/TextPhantom/README.md')
 checks.extend(page.evaluate('''async()=>{
  const {renderCustomerAccount}=await import('/TextPhantom/src/shared/customer-portal/view.js');
  const id='ord_'+'a'.repeat(32),base={id,package_id:'qa',package_version:1},result=[];
  for(const [historyStatus,activeStatus] of [['waiting','cancelled'],['cancelled','waiting']]){
   const data={purchase:{ready:true},packages:[{id:'qa',version:1}],history:{orders:{items:[{...base,status:historyStatus}]}}};
   const node=renderCustomerAccount(data,{tab:'buy',activeOrder:{...base,status:activeStatus}});
   if(node.textContent.includes('Resume payment')||!node.textContent.includes('Select package'))throw Error(node.textContent);
   result.push({historyStatus,activeStatus,passed:true});
  }return result;
 }'''));b.close()
srv.shutdown();print(json.dumps({'checks':checks,'passed':True}))
