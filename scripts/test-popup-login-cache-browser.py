"""Actual popup HTML and Paid/Login/inline controllers; held offline responses."""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import asyncio
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]/'src'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path=='/popup/popup.html':
            body=re.sub(r'<script\b[^>]*>.*?</script>','',(ROOT/'popup/popup.html').read_text(encoding='utf-8'),flags=re.S).encode()
            self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        else:super().do_GET()
INIT="""async ({saved=null,held=false}={})=>{
 const {createPaidServiceController}=await import('/popup/controllers/paid-service-controller.js');
 const {els,toggleUi:toggleDom}=await import('/popup/dom.js');
 window.store=saved?.store||{tpDataConsentV1:{version:1,granted:true,at:1},customApiUrl:location.origin,aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'fixture-customer',paidApiBase:location.origin,paidServiceApiBase:location.origin,paidModel:'tp-demo',loginProvider:'login_gemini',loginModel:'web-default'};
 window.auth=saved?.auth||{};const listeners=new Set();
 const get=(area,keys,fn)=>fn(keys==null?structuredClone(area):Object.fromEntries([].concat(keys).map(k=>[k,structuredClone(area[k])])));
 const set=(area,patch,fn,name)=>{const changes=Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,{oldValue:area[k],newValue:v}]));Object.assign(area,structuredClone(patch));fn?.();queueMicrotask(()=>listeners.forEach(listener=>listener(changes,name)));};
 window.chrome={storage:{local:{get:(k,fn)=>get(store,k,fn),set:(p,fn)=>set(store,p,fn,'local'),remove:(keys,fn)=>{for(const k of [].concat(keys))delete store[k];fn?.();}},session:{get:(k,fn)=>get(auth,k,fn),set:(p,fn)=>set(auth,p,fn,'session')},onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},runtime:{getManifest:()=>({version:'fixture'}),getURL:path=>location.origin+'/'+path}};
 const session={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider:'login_gemini',transport:'web_endpoint'};
 window.account={email:'fixture@example.com',credits:{available:'10000',held:'0'},models:[{id:'tp-demo',name:'TP demo',eligible_tp:'10000'}],packages:[],purchase:{ready:false},addons:{products:[],entitlements:[{code:'ai_login',status:'active',name:'Login'}],orders:[]},history:Object.fromEntries(['orders','payments','usage','lots','refunds','ledger'].map(k=>[k,{items:[],total:0}]))};
 window.calls=[];window.releases=[];window.release=match=>{const i=releases.findIndex(r=>match(new URL(r.url).pathname));if(i<0)throw Error('no held request to release: '+releases.map(r=>r.url));releases.splice(i,1)[0].fn();};
 window.fetch=(url,opts={})=>{calls.push(String(url));const data=String(url).endsWith('/paid/me')||String(url).endsWith('/paid/account')?account:String(url).endsWith('/login/providers')?{providers:[{id:'login_gemini',name:'Gemini',available:true,supported:true,session}]}:{models:[{id:'web-default',name:'Gemini website default',model_capabilities:{vision:{supported:false}}}]};
  const response=()=>new Response(JSON.stringify(data),{status:200});return held?new Promise((resolve,reject)=>{releases.push({url:String(url),fn:()=>resolve(response())});opts.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));}):Promise.resolve(response());};
 els.mode.replaceChildren(new Option('Lens text','lens_text'));els.mode.value='lens_text';els.sources.replaceChildren(new Option('AI','ai'));els.sources.value='ai';els.apiUrl.value=location.origin;
 document.querySelector('#panel-ai').classList.add('active');for(const id of ['translate','tools'])document.querySelector('#panel-'+id).classList.remove('active');
 window.state={lastSavedApiUrl:location.origin};window.popup=createPaidServiceController({els,state,getStorage:async()=>structuredClone(store),setStorage:async patch=>set(store,patch,null,'local'),toggleUi:()=>{toggleDom();popup.applyVisibility();}});
 await popup.initialize();popup.setAvailability(true,location.origin);
}"""
async def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();checks=[]
    try:
        async with async_playwright() as p:
            executable=chromium_executable();browser=await p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}));page=await browser.new_page(viewport={'width':430,'height':900});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            await page.goto(f'http://localhost:{server.server_port}/popup/popup.html');await page.evaluate(INIT,{})
            await page.wait_for_function('state.paidReady===true');await page.locator('#ai-paid-details').click();await page.locator('[data-testid="customer-account"]').wait_for();
            await page.wait_for_function("store.paidInlineStateV1?.tab==='details'")
            await page.evaluate("()=>{store.paidInlineStateV1.intent={request_key:'fixture_purchase_123456',package_id:'pack_fixture',package_version:1};store.paidInlineStateV1.activeOrderId='ord_'+'c'.repeat(32);}")
            saved=await page.evaluate('({store,auth})');await page.evaluate('popup.dispose()');await page.reload();await page.evaluate(INIT,{'saved':saved,'held':True})
            assert await page.locator('#ai-login-provider option:checked').inner_text()=='Gemini'
            assert await page.locator('#ai-login-model option:checked').inner_text()=='Gemini website default'
            assert await page.locator('#ai-paid-account-state').inner_text()=='Signed in'
            status=await page.locator('#ai-login-status').inner_text();assert not re.search('checking|verifying',status,re.I),status
            assert await page.evaluate('state.paidReady') is False
            # .73: the remembered Login model is selectable at once; it becomes display-only only when the API reports a problem.
            assert await page.locator('#ai-login-model').is_enabled()
            assert await page.locator('#ai-paid-inline').is_hidden()
            assert await page.locator('#ai-paid-account').is_visible()
            assert await page.evaluate('store.paidInlineStateV1.intent.request_key')=='fixture_purchase_123456'
            # .72: one /paid/me read plus the one Account details read-ahead per popup open (held, reads only).
            assert await page.evaluate('calls.map(u=>new URL(u).pathname)')==['/paid/me','/paid/account']
            checks.append('Reopened popup paints Gemini/model/access immediately; account subpage resets; purchase replay preserved')
            await page.evaluate("()=>{window.statusChanges=[];window.observer=new MutationObserver(()=>statusChanges.push(document.querySelector('#ai-login-status').textContent));observer.observe(document.querySelector('#ai-login-status'),{subtree:true,childList:true,characterData:true});}")
            await page.evaluate("release(p=>p==='/paid/me')");await page.wait_for_function('calls.length===3')
            await page.evaluate("release(p=>p==='/login/providers')");await page.wait_for_function('calls.length===4')
            await page.evaluate("release(p=>!p.startsWith('/paid/'))");await page.wait_for_function('state.paidReady===true');assert not any(re.search('checking|verifying',text,re.I) for text in await page.evaluate('statusChanges'))
            checks.append('Held account/provider/model requests refresh silently and only fresh responses enable translation')
            await page.locator('#ai-login-refresh').click();await page.wait_for_function('calls.length===5');assert await page.evaluate('state.paidReady') is False;assert await page.locator('#ai-login-provider option:checked').inner_text()=='Gemini';assert not re.search('checking|verifying',await page.locator('#ai-login-status').inner_text(),re.I)
            checks.append('Manual refresh invalidates authority/cache without replacing the matching display with loading')
            await page.evaluate("()=>{store.paidSessionToken='new-customer';chrome.storage.local.set({paidSessionToken:store.paidSessionToken},()=>{});}")
            await page.wait_for_function('!state.loginConnected');assert await page.locator('#ai-login-model').locator('option').count()==0;assert 'Connected' not in await page.locator('#ai-login-account').inner_text()
            checks.append('Account switch synchronously removes prior provider/model display and fences delayed responses')
            await page.evaluate('popup.dispose()');assert not errors,errors;await browser.close()
    finally:server.shutdown()
    print(json.dumps({'passed':True,'checks':checks,'count':len(checks),'scope':'Real Chromium popup HTML + production Paid/Login/inline controllers, offline held HTTP fixtures'},indent=2))
if __name__=='__main__':asyncio.run(main())
