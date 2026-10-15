"""Production popup controller/layout in Chromium with synthetic local account.

Starts at a collapsed 218px/320px viewport and checks the intrinsic 460px
action-popup request before simulating the host honoring it. This is explicitly
not an installed action-popup host test (the bundled headless shell cannot load
extensions). TP_CHROMIUM selects a Chromium executable.
"""
import argparse,json,os,re,shutil,tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,default=Path('/tmp/tp-popup-sizing-106'))
parser.add_argument('--baseline-css',type=Path)
args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
source=Path(__file__).resolve().parents[1]/'src'
checks=[];metrics=[]
def check(name,ok):
    checks.append({'name':name,'passed':bool(ok)});assert ok,name

hook=r'''
import {els} from './dom.js';
import {createPaidServiceController} from './controllers/paid-service-controller.js';
const store={aiServiceMode:'paid',paidSessionToken:'qa_session_only',paidApiBase:'http://localhost:7860',customApiUrl:'http://localhost:7860',paidEmail:'QA@example.com',paidModel:'qa/model'};
const data={email:'QA@example.com',credits:{available:'40000',held:'0',trial:'50000',granted:'10000'},models:[{id:'qa/model',name:'QA model',eligible_tp:'40000'}],packages:[],history:{orders:{items:[],total:0},payments:{items:[],total:0},lots:{items:[],total:0},usage:{items:[],total:0}}};
const listeners=[];
window.chrome={extension:{getViews:()=>window.qaSurface==='popup'?[window]:[]},storage:{onChanged:{addListener:fn=>listeners.push(fn),removeListener:fn=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}}}};
window.fetch=async()=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
document.querySelector('#panel-ai').classList.add('active');document.querySelector('#ai-group').style.display='';
for(const [el,value] of [[els.mode,'lens_text'],[els.sources,'ai']]){if(![...el.options].some(o=>o.value===value))el.add(new Option(value,value));el.value=value;}
els.apiUrl.value=store.customApiUrl;
let controller;
const state={lastSavedApiUrl:store.customApiUrl};
controller=createPaidServiceController({els,state,getStorage:async keys=>Object.fromEntries(keys.map(k=>[k,store[k]])),setStorage:async patch=>Object.assign(store,patch),toggleUi:()=>controller?.applyVisibility()});
await controller.initialize();controller.setAvailability(true,store.customApiUrl);
window.qa={controller,els,state,store,listeners};
'''
readmetrics='''()=>{const rect=n=>n.getBoundingClientRect().width;const root=document.documentElement,body=document.body;return {viewport:innerWidth,surface:root.dataset.paidSurface,root:rect(root),rootScroll:root.scrollWidth,body:rect(body),flowWidth:rect(document.querySelector('.app')),card:rect(document.querySelector('.paid-card')),rootMinWidth:getComputedStyle(root).minWidth,rootCssWidth:getComputedStyle(root).width,contentWidth:rect(document.querySelector('.tp-account-content')),contentScroll:document.querySelector('.tp-account-content').scrollWidth,header:document.querySelector('.tp-account-header').getBoundingClientRect().height,buttonMin:Math.min(...[...document.querySelectorAll('.tp-account-header button,.tp-account-tabs button')].map(n=>n.getBoundingClientRect().height))};}'''

with tempfile.TemporaryDirectory(prefix='tp-popup-106-') as temporary,sync_playwright() as pw:
    fixture=Path(temporary)/'src';shutil.copytree(source,fixture)
    htmlpath=fixture/'popup/popup.html';html=re.sub(r'<script\b[^>]*>.*?</script>','',htmlpath.read_text(),flags=re.S)
    htmlpath.write_text(html.replace('</body>','<script type="module" src="sizing-hook.js"></script></body>'))
    (fixture/'popup/sizing-hook.js').write_text(hook)
    browser=pw.chromium.launch(executable_path=os.getenv('TP_CHROMIUM') or None,headless=True,args=['--no-sandbox','--single-process','--no-zygote','--disable-dev-shm-usage','--allow-file-access-from-files'])
    context=browser.new_context();errors=[]
    def page(surface,width):
        p=context.new_page();p.set_viewport_size({'width':width,'height':600});p.on('pageerror',lambda e:errors.append(str(e)))
        p.add_init_script('window.qaSurface='+json.dumps(surface));p.goto(htmlpath.as_uri());p.wait_for_function('!!window.qa')
        p.locator('#ai-paid-details').click();p.wait_for_selector('[data-testid="customer-account"]');return p
    if args.baseline_css:
        css=fixture/'popup/popup.css';final=css.read_text();css.write_text(args.baseline_css.read_text())
        old=page('popup',218);oldmetrics=old.evaluate(readmetrics);metrics.append({'case':'baseline collapsed popup equivalent','values':oldmetrics})
        check('Baseline narrow fallback reproduces the 218px width lock',oldmetrics['root']==218 and oldmetrics['body']==218)
        old.screenshot(path=str(args.out/'popup-baseline-218.png'));old.close();css.write_text(final)
    for collapsed in [218,320]:
        p=page('popup',collapsed);m=p.evaluate(readmetrics);metrics.append({'case':f'action intrinsic request from {collapsed}px','values':m})
        check(f'Action surface requests 460px from a collapsed {collapsed}px viewport',m['surface']=='popup' and m['root']==460 and m['body']==460 and m['flowWidth']==460 and m['rootMinWidth']=='460px')
        p.set_viewport_size({'width':460,'height':600});m=p.evaluate(readmetrics);metrics.append({'case':'host-equivalent honored width','values':m})
        check(f'460px host equivalent renders a full-width account from {collapsed}px',m['card']==460 and m['contentWidth']>350 and m['buttonMin']>=44)
        p.locator('.tp-account-back').focus()
        confined=True
        for _ in range(10):
            p.keyboard.press('Tab')
            confined=confined and p.evaluate('document.activeElement===document.body || !!document.activeElement.closest("#ai-paid-inline")')
        check('Keyboard navigation does not reach covered settings controls',confined)
        p.screenshot(path=str(args.out/f'popup-fixed-from-{collapsed}.png'))
        p.locator('.tp-account-back').click();p.wait_for_function('!document.documentElement.classList.contains("paid-account-open")')
        check('Back releases the native width request',p.evaluate('getComputedStyle(document.documentElement).width')=='344px')
        check('Back restores normal settings visibility',p.evaluate('getComputedStyle(document.querySelector(".app")).visibility')=='visible')
        p.close()
    narrow=page('page',320);m=narrow.evaluate(readmetrics);metrics.append({'case':'responsive 320px page','values':m})
    check('Responsive page stays within 320px with no document or content horizontal overflow',m['surface']=='page' and m['root']==320 and m['rootScroll']==320 and m['card']==320 and m['contentScroll']<=m['contentWidth']+1)
    narrow.screenshot(path=str(args.out/'popup-responsive-320.png'))
    narrow.evaluate('qa.controller.dispose()');check('Dispose removes expanded viewport state',narrow.evaluate('!document.documentElement.classList.contains("paid-account-open")'))
    check('No JavaScript page errors',not errors);browser.close()
report={'scope':'Production popup HTML/CSS, paid controller and renderer; synthetic local account/browser extension view identity. Collapsed viewport intrinsic request plus simulated host response; NOT a native installed action popup.', 'native_popup_host_verified':False,'checks':checks,'metrics':metrics,'browser_errors':errors,'passed':True}
(args.out/'popup-sizing.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
