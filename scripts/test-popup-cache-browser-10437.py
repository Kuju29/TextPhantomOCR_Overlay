"""Production inline account + shared renderer in a real browser, offline fixtures."""
import asyncio
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1] / 'src'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/cache-fixture':
            body = b'<html><body><main id="account"></main></body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else: super().do_GET()

INIT = """async () => {
  const {createInlineAccount} = await import('/paid/inline.js');
  const {createPaidViewCache, accountViewScope} = await import('/paid/view-cache.js');
  const base = location.origin, token = 'offline-customer-fixture';
  window.store = {customApiUrl:base,paidApiBase:base,paidSessionToken:token};
  const read = async () => structuredClone(store);
  const write = async patch => Object.assign(store,structuredClone(patch));
  window.cached = {email:'customer@example.com',credits:{available:'12000',held:'0'},
    models:[{id:'demo/model',name:'Demo model',eligible_tp:'12000'}],
    packages:[{id:'pkg_demo',version:1,name:'Cached pack',price_satang:10000,credits:'10000',months:6}],
    purchase:{ready:true},addons:{products:[{code:'ai_login',version:1,name:'Login',price_satang:9000,ready:true}],entitlements:[],orders:[]},
    history:{orders:{items:[],total:0},payments:{items:[],total:0},usage:{items:[],total:0},ledger:{items:[],total:0},lots:{items:[],total:0}}};
  const cache = createPaidViewCache({read,write});
  await cache.remember(await accountViewScope(base,token),'account',cached);
  window.calls = []; window.releases = [];
  window.inline = createInlineAccount({mount:document.querySelector('#account'),read,write,
    fetchFn:(url,options)=>new Promise((resolve,reject)=>{
      calls.push({url,method:options.method});
      const release = value => resolve(new Response(JSON.stringify(value),{status:200}));
      releases.push(release);
      options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));
    })});
  inline.sync({active:true,base,token});
  window.opening = inline.open('details');
}"""

async def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    checks = []
    try:
        async with async_playwright() as p:
            browser_path = os.getenv('TP_BROWSER_EXECUTABLE')
            browser = await p.chromium.launch(**({'executable_path': browser_path} if browser_path else {}), headless=True)
            page = await browser.new_page(viewport={'width': 430, 'height': 800})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.goto(f'http://localhost:{server.server_port}/cache-fixture')
            await page.evaluate(INIT)
            root = page.locator('[data-testid="customer-account"]')
            await root.locator('.tp-account-balance strong').filter(has_text='12,000').wait_for()
            assert await root.get_attribute('data-account-refreshing') == 'true'
            assert await page.locator('#account').inner_text() != 'Loading your account…'
            assert await page.evaluate('calls.length') == 1
            checks.append('Cached balance is visible before the held account response')
            await root.locator('nav').get_by_role('button', name='Buy credits', exact=True).click()
            await root.get_by_text('Cached pack', exact=True).wait_for()
            assert await root.get_by_role('button', name='Select package', exact=True).is_disabled()
            assert await root.get_by_role('button', name='Buy add-on', exact=True).is_disabled()
            checks.append('Cached TP/add-on offers keep customer labels with actions disabled')
            await page.evaluate("releases.shift()({...cached,credits:{available:'9000',held:'0'},packages:[{...cached.packages[0],name:'Fresh pack',version:2}]})")
            await root.get_by_text('Fresh pack', exact=True).wait_for()
            assert await root.get_attribute('data-account-refreshing') is None
            assert await root.get_by_role('button', name='Select package', exact=True).is_enabled()
            checks.append('Fresh server response replaces the catalog and enables actions')
            await page.evaluate('inline.close()')
            await page.evaluate("() => { window.reopening=inline.open('buy'); }")
            await root.get_by_text('Fresh pack', exact=True).wait_for()
            assert await root.get_attribute('data-account-refreshing') == 'true'
            assert await root.get_by_role('button', name='Select package', exact=True).is_disabled()
            assert await page.evaluate('calls.length') == 2
            checks.append('Closing/reopening the account retains safe display and starts one fresh GET')
            await page.evaluate("() => { store.paidSessionToken='another-customer-fixture'; inline.sync({active:true,base:location.origin,token:store.paidSessionToken}); }")
            await page.wait_for_function('!inline.isOpen()')
            assert await page.locator('#account').is_hidden()
            await page.evaluate('releases.shift()({...cached,email:"previous-account@example.com"})')
            await page.wait_for_timeout(30)
            assert await page.locator('#account').is_hidden()
            assert 'previous-account@example.com' not in await page.locator('body').inner_text()
            checks.append('Account switch hides cached details and discards the old response')
            await page.evaluate('inline.dispose()')
            assert not errors, errors
            await browser.close()
    finally:
        server.shutdown()
    print(json.dumps({'passed': True, 'checks': checks, 'count': len(checks),
        'scope': 'Real Chromium DOM; production account/cache/renderer with held offline HTTP fixtures.'}, indent=2))

if __name__ == '__main__': asyncio.run(main())
