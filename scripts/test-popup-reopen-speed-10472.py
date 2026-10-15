""".72 owner report: reopening the popup in Paid and Login keeps "loading".
Measures, on the real popup HTML and controllers, how long after reopening the
Paid model, the Login model and Account details become usable, with every API
round trip taking RTT ms and the API health check finishing after HEALTH ms.
Prints the timings; with --assert, enforces the .72 targets.
Offline fixtures only; no account, network or secret."""
import asyncio
import json
import os
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(os.getenv('TP_TEST_ROOT') or Path(__file__).resolve().parents[1]) / 'src'
RTT, HEALTH = 600, 900


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/popup/popup.html':
            body = re.sub(r'<script\b[^>]*>.*?</script>', '', (ROOT / 'popup/popup.html').read_text(encoding='utf-8'),
                          flags=re.S).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


INIT = """async ({saved=null,source='tp',rtt=0,health=0}={})=>{
 const {createPaidServiceController}=await import('/popup/controllers/paid-service-controller.js');
 const {els}=await import('/popup/dom.js');
 window.t0=performance.now();
 window.store=saved?.store||{customApiUrl:location.origin,aiServiceMode:'paid',paidTranslationSource:source,paidSessionToken:'fixture-customer',paidApiBase:location.origin,paidServiceApiBase:location.origin,paidModel:'tp-demo',loginProvider:'login_gemini',loginModel:'web-default'};
 window.auth=saved?.auth||{};const listeners=new Set();
 const get=(area,keys,fn)=>fn(keys==null?structuredClone(area):Object.fromEntries([].concat(keys).map(k=>[k,structuredClone(area[k])])));
 const set=(area,patch,fn,name)=>{const changes=Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,{oldValue:area[k],newValue:v}]));Object.assign(area,structuredClone(patch));fn?.();queueMicrotask(()=>listeners.forEach(listener=>listener(changes,name)));};
 window.chrome={storage:{local:{get:(k,fn)=>get(store,k,fn),set:(p,fn)=>set(store,p,fn,'local'),remove:(keys,fn)=>{for(const k of [].concat(keys))delete store[k];fn?.();}},session:{get:(k,fn)=>get(auth,k,fn),set:(p,fn)=>set(auth,p,fn,'session')},onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)}},runtime:{getManifest:()=>({version:'fixture'}),getURL:path=>location.origin+'/'+path}};
 const session={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider:'login_gemini',transport:'web_endpoint'};
 const model={id:'tp-demo',name:'TP demo',eligible_tp:'10000',max_output:8192,availability:{available:true}};
 window.account={email:'fixture@example.com',credits:{available:'10000',held:'0'},models:[model],price_quote_available:false,packages:[{id:'pkg',version:1,name:'Pack',price_satang:9900,credits:'1000000',months:12}],purchase:{ready:true},addons:{products:[],entitlements:[{code:'ai_login',status:'active',name:'Login'}],orders:[]},history:Object.fromEntries(['orders','payments','usage','lots','refunds','ledger'].map(k=>[k,{items:[],total:0}]))};
 window.calls=[];
 window.fetch=(url,opts={})=>{const at=Math.round(performance.now()-t0);calls.push([String(url).replace(location.origin,''),at]);
  const u=String(url);const data=u.endsWith('/paid/me')||u.endsWith('/paid/account')?account:u.endsWith('/login/providers')?{providers:[{id:'login_gemini',name:'Gemini',available:true,supported:true,session}]}:{models:[{id:'web-default',name:'Gemini website default',model_capabilities:{vision:{supported:false}}}]};
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(new Response(JSON.stringify(data),{status:200})),rtt);opts.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));});});};
 els.mode.replaceChildren(new Option('Lens text','lens_text'));els.mode.value='lens_text';els.sources.replaceChildren(new Option('AI','ai'));els.sources.value='ai';els.apiUrl.value=location.origin;
 document.querySelector('#panel-ai').classList.add('active');for(const e of document.querySelectorAll('#ai-group,.ai-group')){e.hidden=false;e.style.display='block';}for(const id of ['translate','tools'])document.querySelector('#panel-'+id).classList.remove('active');
 window.state={lastSavedApiUrl:location.origin};window.popup=createPaidServiceController({els,state,getStorage:async()=>structuredClone(store),setStorage:async patch=>set(store,patch,null,'local'),toggleUi:()=>popup.applyVisibility()});
 // The real popup learns API availability from the health check (HEALTH ms).
 // Real popup order: settings hydration awaits Paid initialize, then the
 // health check runs (HEALTH ms) and reports availability.
 const init=popup.initialize();
 init.then(()=>setTimeout(()=>popup.setAvailability(true,location.origin),health));
 await init;
}"""

PROBE = """(name)=>{const el=document.querySelector(name);return el?{disabled:el.disabled,hidden:el.closest('[hidden]')!==null}:null;}"""


async def until(page, check, limit=15000):
    start = await page.evaluate('performance.now()-t0')
    while True:
        if await page.evaluate(check):
            return round(await page.evaluate('performance.now()-t0'))
        if await page.evaluate('performance.now()-t0') - start > limit:
            return None
        await page.wait_for_timeout(20)


async def scenario(browser, port, source):
    page = await browser.new_page(viewport={'width': 430, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(f'http://localhost:{port}/popup/popup.html')
    # First open: fills caches.
    await page.evaluate(INIT, {'source': source, 'rtt': 0, 'health': 0})
    ready = "document.querySelector('#ai-login-model') && !document.querySelector('#ai-login-model').disabled" if source == 'login' \
        else "!document.querySelector('#ai-paid-model').disabled"
    if await until(page, 'state.paidReady===true', 5000) is None:
        raise AssertionError(await page.evaluate('''({ready:state.paidReady,active:state.paidActive,status:document.querySelector('#ai-paid-status')?.textContent,
          note:document.querySelector('#ai-paid-unavailable')?.textContent,acct:document.querySelector('#ai-paid-account')?.hidden,calls})'''))
    hidden = await page.evaluate('''(()=>{let e=document.querySelector('#ai-paid-details');const out=[];while(e){const cs=getComputedStyle(e);if(e.hidden||cs.display==='none'||cs.visibility==='hidden')out.push((e.id||e.className||e.tagName)+':'+(e.hidden?'hidden':cs.display));e=e.parentElement;}return out;})()''')
    if hidden:
        raise AssertionError(hidden)
    await page.locator('#ai-paid-details').click()
    await page.locator('[data-testid="customer-account"]').wait_for()
    await page.wait_for_timeout(300)
    await page.evaluate('popup.dispose()')
    saved = await page.evaluate('({store,auth})')
    # Reopen with realistic latency.
    await page.goto('about:blank')
    await page.goto(f'http://localhost:{port}/popup/popup.html')
    await page.wait_for_load_state('load')
    await page.evaluate(INIT, {'saved': saved, 'source': source, 'rtt': RTT, 'health': HEALTH})
    probes = {'balance_painted_ms': "document.querySelector('#ai-paid-credits')?.textContent.includes('10,000')",
              'model_usable_ms': ready,
              'details_button_ms': "(()=>{const b=document.querySelector('#ai-paid-details');return b&&b.offsetParent!==null&&!b.disabled;})()"}
    seen = {}
    while len(seen) < len(probes) and await page.evaluate('performance.now()-t0') < 15000:
        for name, check in probes.items():
            if name not in seen and await page.evaluate(check):
                seen[name] = round(await page.evaluate('performance.now()-t0'))
        await page.wait_for_timeout(15)
    painted, usable, visible = (seen.get(k) for k in probes)
    # A person reads the popup for about a second before opening Account details.
    while await page.evaluate('performance.now()-t0') < 1000:
        await page.wait_for_timeout(20)
    await page.locator('#ai-paid-details').click()
    clicked = round(await page.evaluate('performance.now()-t0'))
    details = await until(page, "(()=>{const r=document.querySelector('[data-testid=\"customer-account\"]');return r&&!r.hasAttribute('data-account-refreshing');})()")
    calls = await page.evaluate('calls')
    await page.close()
    return {'source': source, 'balance_painted_ms': painted, 'model_usable_ms': usable, 'details_button_ms': visible,
            'account_details_ready_after_click_ms': None if details is None else details - clicked,
            'calls': calls, 'errors': errors}


async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        async with async_playwright() as p:
            executable = os.getenv('TP_BROWSER_EXECUTABLE')
            browser = await p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
            for source in ('tp', 'login'):
                results.append(await scenario(browser, server.server_port, source))
            await browser.close()
    finally:
        server.shutdown()
    print(json.dumps({'rtt_ms': RTT, 'health_ms': HEALTH, 'results': results}, indent=1))
    if '--assert' in sys.argv:
        for row in results:
            assert not row['errors'], row['errors']
            assert row['balance_painted_ms'] is not None and row['balance_painted_ms'] < 300, row
            # Usable from the remembered list immediately; validation continues in the background.
            assert row['model_usable_ms'] is not None and row['model_usable_ms'] < 300, row
            # Account details prepared in the background: ready when clicked (no extra round trip).
            assert row['account_details_ready_after_click_ms'] is not None and row['account_details_ready_after_click_ms'] < 200, row
            assert [c[0] for c in row['calls']].count('/paid/account') == 1, row['calls']
        print('PASS popup reopen: balance, model and Account details usable without waiting for the network')


if __name__ == '__main__':
    asyncio.run(main())
