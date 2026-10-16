"""Independent native DOM lifecycle QA with EXPLICIT simulated chrome boundaries.
This is NOT installed-extension evidence. It verifies the production dock script
against context invalidation and asynchronous/synchronous failure scenarios.
"""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import argparse, asyncio, hashlib, json, os, tempfile, threading, traceback
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

INIT=r'''(()=>{
 const originalSetInterval=window.setInterval.bind(window), originalClearInterval=window.clearInterval.bind(window);
 const state=window.__qa={id:'qa-current',version:'2026.10.4.24',config:true,authenticated:true,activated:true,hidden:false,view:'expanded',frameMode:'ready',throwNext:false,deferNext:false,lastError:null,requests:[],pending:[],runtime:new Set(),storage:new Set(),timers:new Set(),unhandled:[]};
 window.addEventListener('unhandledrejection',e=>state.unhandled.push(String(e.reason?.message||e.reason)));
 window.addEventListener('error',e=>state.unhandled.push(e.message));
 window.setInterval=(fn,ms,...args)=>{const id=originalSetInterval(fn,ms,...args);state.timers.add(id);return id};
 window.clearInterval=id=>{state.timers.delete(id);originalClearInterval(id)};
 const response=message=>message.type==='TP_SUPPORT_AUTH'?{authenticated:state.config&&state.authenticated}:message.type==='TP_SUPPORT_CONFIG'?{configured:state.config}:message.type==='TP_SUPPORT_TAB_VIEW'?{view:state.view}:message.type==='TP_SUPPORT_CHANNEL'?{channel:'private-qa-channel'}:{ok:true};
 const runtime={getURL:path=>location.origin+'/'+path,getManifest:()=>({version:state.version}),get id(){return state.id},get lastError(){return state.lastError},onMessage:{addListener:fn=>state.runtime.add(fn),removeListener:fn=>state.runtime.delete(fn)},sendMessage:(message,cb)=>{
  state.requests.push(message);
  if(state.throwNext){state.throwNext=false;throw new Error('Extension context invalidated.');}
  if(!state.id)throw new Error('Extension context invalidated.');
  if(state.deferNext){state.deferNext=false;const value=response(message);state.pending.push(()=>cb(value));return;}
  queueMicrotask(()=>cb(response(message)));
 }};
 globalThis.chrome={runtime,storage:{local:{get:(_keys,cb)=>queueMicrotask(()=>cb({supportActivated:state.activated,supportDockHidden:state.hidden}))},onChanged:{addListener:fn=>state.storage.add(fn),removeListener:fn=>state.storage.delete(fn)}}};
 window.__qaEmit=(message,sender={id:'qa-current',url:location.href,tab:{id:5},frameId:0})=>new Promise(resolve=>{
  let settled=false,pending=false;const done=value=>{if(!settled){settled=true;resolve(value)}};
  for(const fn of [...state.runtime]){if(fn(message,sender,done)===true)pending=true;}
  if(!pending&&!settled)done(null);setTimeout(()=>done({timeout:true}),6500);
 });
 window.__qaSnapshot=()=>{const h=document.getElementById('tp-support-dock'),r=h?.getBoundingClientRect();return {hostCount:document.querySelectorAll('#tp-support-dock').length,host:h?{x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(h).display,right:getComputedStyle(h).right,bottom:getComputedStyle(h).bottom}:null,runtimeListeners:state.runtime.size,storageListeners:state.storage.size,timers:state.timers.size,unhandled:[...state.unhandled],alive:typeof __tpSupportDock==='object'?__tpSupportDock.alive():null,requestTypes:state.requests.map(m=>m.type)}};
})();'''

class Handler(BaseHTTPRequestHandler):
 source=None
 def log_message(self,*a):pass
 def do_GET(self):
  if self.path.startswith('/content/support-dock.js'):body=self.source.read_bytes();typ='text/javascript'
  elif self.path.startswith('/support/chat.html'):
   body=b'<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#151b29;color:white;font:16px sans-serif">Native DOM support frame fixture<script>window.addEventListener("message",event=>{if(event.data?.channel!=="private-qa-channel")return;document.body.dataset.view=event.data.view;parent.postMessage({type:"TP_SUPPORT_GEOMETRY",view:event.data.view},location.origin)});if(parent.__qa.frameMode==="ready")parent.postMessage({type:"TP_SUPPORT_READY"},location.origin)</script></body></html>';typ='text/html'
  else:body=b'<!doctype html><html><head><meta charset="utf-8"><title>Native dock lifecycle QA</title></head><body><main><h1>Publisher page</h1><p>Independent native DOM fixture with simulated extension boundaries.</p></main></body></html>';typ='text/html'
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)

async def main(args):
 out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True);Handler.source=Path(args.source).resolve();server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
 results=[];report={'installedExtension':False,'chromeBoundaries':'explicitly simulated','nativeDom':True,'productionSource':str(Handler.source),'sourceSha256':hashlib.sha256(Handler.source.read_bytes()).hexdigest(),'checks':results}
 # Optional: a private runtime library folder / fontconfig for minimal hosts; by default the system's.
 env=dict(os.environ)
 if args.runtime_lib:env['LD_LIBRARY_PATH']=str(Path(args.runtime_lib).resolve())
 if args.font_config:env['FONTCONFIG_FILE']=str(Path(args.font_config).resolve())
 async with async_playwright() as p:
  browser=await p.chromium.launch(executable_path=str(Path(args.browser).resolve()),headless=True,args=['--no-sandbox'],env=env)
  async def fixture(activated=True,setup=''):
   context=await browser.new_context(viewport={'width':1200,'height':850});await context.add_init_script(INIT);page=await context.new_page();await page.goto(base+'/host');await page.evaluate('(active)=>__qa.activated=active',activated)
   if setup:await page.evaluate(setup)
   await page.add_script_tag(url=base+'/content/support-dock.js');await page.wait_for_timeout(80);return context,page
  async def inject(page):await page.add_script_tag(url=base+'/content/support-dock.js');await page.wait_for_timeout(80)
  async def snapshot(page):return await page.evaluate('__qaSnapshot()')
  async def check(name,fn):
   try:value=await fn();results.append({'name':name,'passed':True,**(value or {})})
   except Exception as exc:results.append({'name':name,'passed':False,'error':str(exc),'traceback':traceback.format_exc()})
   print(json.dumps(results[-1]),flush=True)
  def mounted(v):
   assert v['hostCount']==1 and v['host']['display']=='block',v
   # .90 change-driven sync: the dock keeps no interval timers (layout follows events).
   assert v['runtimeListeners']==1 and v['storageListeners']==1 and v['timers']==0,v
   assert not v['unhandled'],v
  def disposed(v):
   assert v['hostCount']==0 and v['runtimeListeners']==0 and v['storageListeners']==0 and v['timers']==0 and not v['alive'],v
   assert not v['unhandled'],v
  async def ordinary():
   c,page=await fixture();v=await snapshot(page);mounted(v);assert v['host']['width']==390 and v['host']['height']==640 and v['host']['right']=='18px' and v['host']['bottom']=='18px',v
   await page.screenshot(path=str(out/'ordinary-native-dock.png'));await c.close();return {'snapshot':v}
  await check('Native DOM mounts one expanded bottom-right dock',ordinary)
  async def unauthenticated():
   c,page=await fixture(setup='__qa.authenticated=false');v=await snapshot(page);assert v['hostCount']==0 and not v['unhandled'],v
   opened=await page.evaluate('__qaEmit({type:"TP_SUPPORT_OPEN"})');assert opened=={'ok':False},opened
   assert (await snapshot(page))['hostCount']==0;await c.close();return {'snapshot':v,'opened':opened}
  await check('Remembered Contact activation cannot mount or open before Paid authentication',unauthenticated)
  async def auth_change(key):
   c,page=await fixture();mounted(await snapshot(page))
   value=await page.evaluate('''key=>{__qa.authenticated=false;for(const fn of [...__qa.storage])fn({[key]:{newValue:key==='paidSessionToken'?'':'https://other.example'}},'local');return __qaSnapshot()}''',key)
   assert value['host']['display']=='none',value
   await page.wait_for_timeout(80);v=await snapshot(page);assert v['host']['display']=='none' and not v['unhandled'],v
   await page.screenshot(path=str(out/('hidden-after-'+key+'.png')));await c.close();return {'snapshot':v}
  await check('Paid logout hides the existing dock synchronously',lambda:auth_change('paidSessionToken'))
  await check('Changing the selected API hides the previous account dock synchronously',lambda:auth_change('customApiUrl'))
  async def stale_auth():
   c,page=await fixture();mounted(await snapshot(page))
   # The check reads the consent mirror before it asks, so wait until the (successful) auth request is in flight.
   await page.evaluate('''async()=>{__qa.deferNext=true;for(const fn of [...__qa.storage])fn({supportConfiguration:{newValue:{configured:true}}},'local');await new Promise(r=>{const t=()=>__qa.pending.length?r():setTimeout(t,0);t();});__qa.authenticated=false;for(const fn of [...__qa.storage])fn({paidSessionToken:{newValue:''}},'local');__qa.pending.shift()()}''')
   await page.wait_for_timeout(80);v=await snapshot(page);assert v['host']['display']=='none' and not v['unhandled'],v;await c.close();return {'snapshot':v}
  await check('Delayed successful authentication cannot restore the dock after logout',stale_auth)
  # .90: a confirmed dock follows storage/account changes (covered above), not focus.
  # Focus re-checks only a page whose first check did not confirm chat yet.
  async def auth_expired():
   c,page=await fixture(setup='__qa.authenticated=false');v=await snapshot(page);assert v['hostCount']==0 and not v['unhandled'],v
   before=len(v['requestTypes']);await page.evaluate('__qa.authenticated=true;window.dispatchEvent(new Event("focus"))');await page.wait_for_timeout(80)
   v=await snapshot(page);assert v['requestTypes'][before:].count('TP_SUPPORT_AUTH')==1,v;mounted(v)
   after=len(v['requestTypes']);await page.evaluate('window.dispatchEvent(new Event("focus"))');await page.wait_for_timeout(80)
   v=await snapshot(page);assert 'TP_SUPPORT_AUTH' not in v['requestTypes'][after:],v;await c.close();return {'snapshot':v}
  await check('Returning to a page re-checks only an unconfirmed dock (confirmed docks follow changes)',auth_expired)
  async def reinject():
   c,page=await fixture();before=await page.evaluate('__tpSupportDock');await page.evaluate('window.__qaOriginal=__tpSupportDock');
   for _ in range(5):await inject(page)
   v=await snapshot(page);mounted(v);assert await page.evaluate('__qaOriginal===__tpSupportDock');await c.close();return {'reinjects':5,'snapshot':v}
  await check('Repeated same-runtime injection retains one controller, host and timer set',reinject)
  async def stale_sentinel():
   c,page=await fixture(setup="globalThis.__tpSupportDock=true;const old=document.createElement('div');old.id='tp-support-dock';old.textContent='stale .23';document.body.append(old)")
   v=await snapshot(page);mounted(v);assert await page.evaluate('!document.getElementById("tp-support-dock").textContent.includes("stale .23")');await c.close();return {'snapshot':v}
  await check('Stale .23 boolean sentinel and host are replaced',stale_sentinel)
  async def id_invalid():
   c,page=await fixture();await page.evaluate('__qa.id=undefined;window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("resize"));document.dispatchEvent(new Event("visibilitychange"))');await page.wait_for_timeout(1150);v=await snapshot(page);disposed(v);await c.close();return {'snapshot':v}
  await check('Missing runtime.id disposes listeners, host and intervals without unhandled work',id_invalid)
  async def throw_race():
   c,page=await fixture();await page.evaluate('__qa.throwNext=true;for(const fn of [...__qa.storage])fn({paidSessionToken:{newValue:"next"}},"local")');await page.wait_for_timeout(80);v=await snapshot(page);disposed(v);await c.close();return {'snapshot':v}
  await check('Synchronous sendMessage invalidation race disposes without unhandled rejection',throw_race)
  async def storage_throw():
   c,page=await fixture(False);await page.evaluate('__qa.throwNext=true;for(const fn of [...__qa.storage])fn({supportConfiguration:{newValue:{configured:true}}},"local")');await page.wait_for_timeout(80);v=await snapshot(page);disposed(v);await c.close();return {'snapshot':v}
  await check('Storage-triggered configuration request handles synchronous invalidation',storage_throw)
  async def deferred_invalid():
   c,page=await fixture();await page.evaluate('async()=>{__qa.deferNext=true;for(const fn of [...__qa.storage])fn({paidSessionToken:{newValue:"next"}},"local");await new Promise(r=>{const t=()=>__qa.pending.length?r():setTimeout(t,0);t();});__qa.id=undefined;__qa.pending.shift()()}');await page.wait_for_timeout(80);v=await snapshot(page);disposed(v);await c.close();return {'snapshot':v}
  await check('Context becomes invalid between send and callback without unhandled rejection',deferred_invalid)
  async def current_sender():
   c,page=await fixture(False);ping=await page.evaluate('__qaEmit({type:"TP_SUPPORT_PING"})');assert ping=={'ready':True,'version':'2026.10.4.24'},ping;opened=await page.evaluate('__qaEmit({type:"TP_SUPPORT_OPEN"},{id:"qa-current",url:location.href,tab:{id:5},frameId:0})');assert opened=={'ok':True},opened;v=await snapshot(page);mounted(v);await c.close();return {'ping':ping,'opened':opened,'snapshot':v}
  await check('Current receiver responds to ping and explicit open',current_sender)
  async def missing_sender():
   c,page=await fixture(False);opened=await page.evaluate('__qaEmit({type:"TP_SUPPORT_OPEN"},{})');assert opened=={'ok':True},opened;v=await snapshot(page);mounted(v);await c.close();return {'opened':opened,'snapshot':v}
  await check('Receiver open tolerates absent sender metadata without throwing',missing_sender)
  async def stale_then_reinject():
   c,page=await fixture();await page.evaluate('__qa.id=undefined;window.dispatchEvent(new Event("resize"))');disposed(await snapshot(page));await page.evaluate('__qa.id="qa-new-context"');await inject(page);v=await snapshot(page);mounted(v);ping=await page.evaluate('__qaEmit({type:"TP_SUPPORT_PING"})');assert ping['ready'];await c.close();return {'snapshot':v,'ping':ping}
  await check('A current injected controller recovers after old context is disposed',stale_then_reinject)
  async def remote_removed():
   c,page=await fixture();await page.evaluate('document.getElementById("tp-support-dock").remove()');opened=await page.evaluate('__qaEmit({type:"TP_SUPPORT_OPEN"})');assert opened=={'ok':True};v=await snapshot(page);mounted(v);await c.close();return {'snapshot':v}
  await check('Explicit open reattaches externally removed host without duplicates',remote_removed)
  async def narrow():
   c,page=await fixture();await page.set_viewport_size({'width':375,'height':700});await page.wait_for_timeout(100);v=await snapshot(page);mounted(v);h=v['host'];assert h['x']==0 and h['y']==0 and h['width']==375 and h['height']==700,v;await page.screenshot(path=str(out/'narrow-native-dock.png'));await c.close();return {'snapshot':v}
  await check('Phone-width viewport opens the expanded dock as a full-screen sheet within bounds',narrow)
  async def missing_ready():
   c,page=await fixture(False,setup='__qa.frameMode="missing"');started=asyncio.get_running_loop().time();opened=await page.evaluate('__qaEmit({type:"TP_SUPPORT_OPEN"})');elapsed=asyncio.get_running_loop().time()-started;assert opened=={'ok':False},opened;assert elapsed>=4.5,elapsed;v=await snapshot(page);assert 'TP_SUPPORT_CHANNEL' not in v['requestTypes'],v;assert not v['unhandled'],v;await c.close();return {'opened':opened,'elapsedSeconds':round(elapsed,3),'snapshot':v}
  await check('A loaded private iframe without READY returns OPEN false after bounded wait',missing_ready)
  async def unsolicited_ready():
   c,page=await fixture(False,setup='__qa.frameMode="missing"');value=await page.evaluate('''async()=>{const start=performance.now(),pending=__qaEmit({type:"TP_SUPPORT_OPEN"});await new Promise(resolve=>setTimeout(resolve,80));window.postMessage({type:"TP_SUPPORT_READY"},location.origin);window.dispatchEvent(new MessageEvent("message",{source:window,origin:location.origin,data:{type:"TP_SUPPORT_READY"}}));const opened=await pending;return {opened,elapsedSeconds:(performance.now()-start)/1000}}''');assert value['opened']=={'ok':False},value;assert value['elapsedSeconds']>=4.5,value;v=await snapshot(page);assert 'TP_SUPPORT_CHANNEL' not in v['requestTypes'],v;assert not v['unhandled'],v;await c.close();return {**value,'snapshot':v}
  await check('Publisher-origin unsolicited READY cannot authenticate the private frame',unsolicited_ready)
  async def forged_exact_ready():
   c,page=await fixture(False,setup='__qa.frameMode="missing"');await page.evaluate('window.__qaOpenStarted=performance.now();window.__qaPendingOpen=__qaEmit({type:"TP_SUPPORT_OPEN"})');await page.wait_for_timeout(100);frame=next(f for f in page.frames if '/support/chat.html' in f.url)
   # Capture the real WindowProxy through the QA frame handle. This models a
   # publisher that has learned the proxy from an earlier public frame event.
   await frame.evaluate('parent.__qaActualFrameWindow=window');value=await page.evaluate('''async()=>{window.dispatchEvent(new MessageEvent("message",{source:__qaActualFrameWindow,origin:location.origin,data:{type:"TP_SUPPORT_READY"}}));return {opened:await __qaPendingOpen,elapsedSeconds:(performance.now()-__qaOpenStarted)/1000}}''');assert value['opened']=={'ok':False},value;assert value['elapsedSeconds']>=4.5,value;v=await snapshot(page);assert 'TP_SUPPORT_CHANNEL' not in v['requestTypes'],v;assert not v['unhandled'],v;await c.close();return {**value,'snapshot':v}
  await check('Synthetic READY with exact private WindowProxy and origin cannot authenticate iframe',forged_exact_ready)
  async def disposed_waiter():
   c,page=await fixture(False,setup='__qa.frameMode="missing"');value=await page.evaluate('''async()=>{const start=performance.now(),pending=__qaEmit({type:"TP_SUPPORT_OPEN"});await new Promise(resolve=>setTimeout(resolve,80));__qa.id=undefined;window.dispatchEvent(new Event("resize"));return {opened:await pending,elapsedSeconds:(performance.now()-start)/1000}}''');assert value['opened']=={'ok':False},value;assert value['elapsedSeconds']<1,value;v=await snapshot(page);disposed(v);await c.close();return {**value,'snapshot':v}
  await check('Disposal immediately resolves pending private-frame READY wait as false',disposed_waiter)
  await browser.close()
 server.shutdown();report['passed']=sum(r['passed'] for r in results);report['total']=len(results);report['allPassed']=report['passed']==report['total'];(out/'native-dock-lifecycle-report.json').write_text(json.dumps(report,indent=2));print(json.dumps({'passed':report['passed'],'total':report['total'],'allPassed':report['allPassed']}));return report['allPassed']

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--source',default=str(Path(__file__).resolve().parents[1]/'src/content/support-dock.js'));p.add_argument('--browser',default=chromium_executable(required=False));p.add_argument('--runtime-lib');p.add_argument('--font-config');p.add_argument('--out',default=str(Path(tempfile.gettempdir())/'tp-dock-lifecycle'));raise SystemExit(0 if asyncio.run(main(p.parse_args())) else 1)
