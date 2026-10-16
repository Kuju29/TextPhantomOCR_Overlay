"""Installed MV3 QA. Uses real chrome APIs, worker, tabs and content scripts.
Only the local operator API is a fixture. Run with a full Chrome/Chromium binary,
not chrome-headless-shell; the latter does not support unpacked extensions.
"""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import argparse, asyncio, json, os, shutil, tempfile, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from playwright.async_api import async_playwright

TOKEN='a'*64
REQUESTS=[]
MESSAGES=[{'id':'msg_fixture','seq':1,'sender':'admin','created_at':int(time.time()*1000),'text':'Installed extension private fixture reply','attachments':[]}]
STATE={'enabled':True,'email':'installed-qa@example.invalid','max_file_mb':20,'admin_presence':{'online':False,'last_seen_at':1000000,'server_now':5000000,'timeout_seconds':120},'thread':{'state':'waiting_customer','unread':0,'read_seq':1,'last_seq':1,'last_admin_seq':1,'notification_muted':False,'closed_seq':0,'idle_since_at':int(time.time()*1000)}}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def respond(self,body,content_type='application/json',status=200,csp=''):
  payload=body if isinstance(body,bytes) else (json.dumps(body).encode() if content_type=='application/json' else body.encode())
  self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(payload)));self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Headers','Authorization,Content-Type,X-Command-ID,X-File-Name');self.send_header('Access-Control-Allow-Methods','GET,POST,OPTIONS')
  if csp:self.send_header('Content-Security-Policy',csp)
  self.end_headers();self.wfile.write(payload)
 def do_OPTIONS(self):self.respond({})
 def record(self):
  REQUESTS.append({'path':self.path,'method':self.command,'authenticated':self.headers.get('Authorization')=='Bearer '+TOKEN})
 def do_GET(self):
  path=urlparse(self.path).path
  if path=='/meta':self.record();return self.respond({'ok':True,'paid':{'configured':True}})
  if path.startswith('/paid/'):
   self.record()
   if self.headers.get('Authorization')!='Bearer '+TOKEN:return self.respond({'error':{'code':'SIGN_IN_REQUIRED','message':'Fixture requires authentication'}},status=401)
   if path in ['/paid/support','/paid/support/status']:return self.respond(STATE)
   if path=='/paid/support/messages':return self.respond({'items':MESSAGES,'has_more':False})
   if path=='/paid/auth/status':return self.respond({'ok':True,'authenticated':True,'email':STATE['email']})
   return self.respond({'ok':True})
  if path.endswith('.svg'):return self.respond(b'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect fill="#e7d9c3" width="600" height="800"/><text x="55" y="150" font-size="36">QA cover</text></svg>','image/svg+xml')
  restrictive=path.startswith('/csp');control=path.startswith('/admin')
  html='<!doctype html><html><head><meta charset="utf-8"><title>Installed Support QA</title>'+('<meta name="textphantom-surface" content="control-center">' if control else '')+'</head><body><main><h1>Ordinary publisher page</h1><p>Support remains in the bottom right.</p><img src="/cover.svg" width="300" height="400" alt="QA SVG image"></main></body></html>'
  return self.respond(html,'text/html',csp="default-src 'self'; script-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'" if restrictive else '')
 def do_POST(self):
  self.record();n=int(self.headers.get('Content-Length','0'));payload=self.rfile.read(n)
  if not self.path.startswith('/paid/support'):return self.respond({'error':{'message':'No external operation supported by fixture'}},status=403)
  if self.headers.get('Authorization')!='Bearer '+TOKEN:return self.respond({'error':{'message':'Fixture requires authentication'}},status=401)
  data=json.loads(payload or b'{}') if self.headers.get('Content-Type','').startswith('application/json') else {}
  if self.path=='/paid/support/messages':
   seq=len(MESSAGES)+1;message={'id':'msg_fixture_'+str(seq),'seq':seq,'sender':'customer','created_at':int(time.time()*1000),'text':data.get('text',''),'attachments':[]};MESSAGES.append(message);STATE['thread']['last_seq']=seq;return self.respond(message)
  if self.path=='/paid/support/action' and data.get('action')=='read':STATE['thread']['unread']=0
  return self.respond({'ok':True})

async def main(args):
 out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True);report={'extension':str(Path(args.extension).resolve()),'chromeApiMocks':False,'realChromeApis':False,'cases':[],'runtimeErrors':[],'requests':REQUESTS}
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
 profile=tempfile.mkdtemp(prefix='installed-support-profile-',dir=out)
 env=dict(os.environ)
 if args.runtime_lib:env['LD_LIBRARY_PATH']=str(Path(args.runtime_lib).resolve())
 if args.font_config:env['FONTCONFIG_FILE']=str(Path(args.font_config).resolve())
 extension=Path(args.extension).resolve()
 try:
  async with async_playwright() as p:
   context=await p.chromium.launch_persistent_context(profile,executable_path=str(Path(args.browser).resolve()),headless=True,viewport={'width':1200,'height':850},ignore_default_args=['--disable-extensions'],args=['--no-sandbox','--disable-extensions-except='+str(extension),'--load-extension='+str(extension),'--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost'],env=env)
   async def watch(page):
    page.on('pageerror',lambda error:report['runtimeErrors'].append({'page':page.url,'description':str(error),'source':'pageerror'}))
    session=await context.new_cdp_session(page);await session.send('Runtime.enable')
    session.on('Runtime.exceptionThrown',lambda event:report['runtimeErrors'].append({'page':page.url,'source':'cdp','details':event['exceptionDetails']}))
   for page in context.pages:await watch(page)
   context.on('page',lambda page:asyncio.create_task(watch(page)))
   worker=context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker',timeout=15000)
   # The worker's extension bindings attach shortly after the worker starts (observed ~1 s on Chromium 141).
   for _ in range(150):
    if await worker.evaluate('typeof chrome?.runtime?.getManifest==="function"'):break
    await asyncio.sleep(0.1)
   extension_id=worker.url.split('/')[2];report['extensionId']=extension_id;report['manifest']=await worker.evaluate('chrome.runtime.getManifest()');report['realChromeApis']=True
   await worker.evaluate('(v)=>chrome.storage.local.set(v)',{'tpDataConsentV1':{'version':1,'granted':True,'at':int(time.time()*1000)},'customApiUrl':base,'apiUrlDefault':base,'paidApiBase':base,'paidSessionToken':TOKEN,'paidEmail':STATE['email'],'aiServiceMode':'manual','supportActivated':False,'supportDockHidden':False})
   publisher=await context.new_page();await publisher.goto(base+'/ordinary');await publisher.wait_for_timeout(400)
   # This is the shipped popup HTML/controller in an extension page. Activate
   # the publisher through the real tabs API before invoking its actual button.
   async def click_contact(target):
    nonlocal worker
    popup=await context.new_page();await popup.goto('chrome-extension://'+extension_id+'/popup/popup.html');await popup.locator('#tab-tools').click();await popup.locator('#contact-admin').wait_for(state='visible',timeout=10000)
    tabs=await worker.evaluate('()=>chrome.tabs.query({})');target_id=next(t['id'] for t in tabs if t.get('url')==target.url)
    await worker.evaluate('(id)=>chrome.tabs.update(id,{active:true})',target_id)
    before=await worker.evaluate('()=>chrome.tabs.query({})')
    await popup.evaluate('document.getElementById("contact-admin").click()')
    # Poll from Python: the popup's CSP (script-src 'self') blocks Playwright's string predicates.
    try:
     for _ in range(80):
      if popup.is_closed() or not await popup.evaluate('()=>document.getElementById("contact-admin").disabled'):break
      await asyncio.sleep(0.1)
     else:raise TimeoutError('Contact admin stayed busy')
    except Exception:
     if not popup.is_closed():raise
    await target.wait_for_timeout(150)
    after=await worker.evaluate('()=>chrome.tabs.query({})')
    new_support=[t for t in after if t.get('url','').startswith('chrome-extension://'+extension_id+'/support/chat.html') and not any(old['id']==t['id'] for old in before)]
    errors='' if popup.is_closed() else await popup.locator('#contact-admin-status').text_content() if await popup.locator('#contact-admin-status').count() else await popup.locator('#contact-admin').get_attribute('title')
    if not popup.is_closed():await popup.close()
    return {'tabCountBefore':len(before),'tabCountAfter':len(after),'newSupportTabs':len(new_support),'popupMessage':errors}
   async def snapshot(page,name):
    host=await page.evaluate('()=>{const h=document.getElementById("tp-support-dock");if(!h)return null;const r=h.getBoundingClientRect(),s=getComputedStyle(h);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,right:s.right,bottom:s.bottom,viewport:{width:innerWidth,height:innerHeight}}}')
    frames=[f for f in page.frames if f.url.startswith('chrome-extension://'+extension_id+'/support/chat.html')]
    frame=frames[0] if frames else None
    snap={'host':host,'frameUrl':frame.url if frame else None,'frameCount':len(frames)}
    if frame:
     try:snap.update(await frame.evaluate('()=>({view:document.body.dataset.view,conversation:!document.getElementById("conversation").hidden,error:document.getElementById("error").textContent,history:document.getElementById("history").textContent})'))
     except Exception as e:snap['frameError']=str(e)
    await page.screenshot(path=str(out/(name+'.png')));return snap
   async def case(name,page,click=True):
    start=len(report['runtimeErrors']);value={'name':name}
    try:
     if click:value.update(await click_contact(page))
     value.update(await snapshot(page,name));h=value.get('host');value['bottomRightGeometry']=bool(h and h['x']>=0 and h['y']>=0 and h['x']+h['width']<=h['viewport']['width'] and h['y']+h['height']<=h['viewport']['height'] and (
      # Phone widths (<=480 px) open the chat as a full-screen sheet; otherwise a bottom-right panel.
      (h['x']==0 and h['y']==0 and h['width']==h['viewport']['width'] and h['height']==h['viewport']['height']) if h['viewport']['width']<=480 else (h['right']=='18px' and h['bottom']=='18px')));value['passed']=bool(h and h['display']=='block' and h['width']>300 and value['bottomRightGeometry'] and value.get('view')=='expanded' and value.get('conversation') and not value.get('error') and 'Installed extension private fixture reply' in value.get('history','') and value.get('newSupportTabs',0)==0)
    except Exception as exc:value.update({'passed':False,'error':str(exc),'traceback':traceback.format_exc()})
    value['runtimeErrors']=report['runtimeErrors'][start:];report['cases'].append(value);print(json.dumps(value),flush=True)
   await case('ordinary-contact',publisher)
   await publisher.goto(base+'/navigation');await publisher.wait_for_timeout(500);await case('same-tab-navigation',publisher,False)
   await publisher.reload();await publisher.wait_for_timeout(500);await case('publisher-reload',publisher,False)
   other=await context.new_page();await other.goto(base+'/csp');await other.wait_for_timeout(500);await case('restrictive-csp-contact',other)
   narrow=await context.new_page();await narrow.set_viewport_size({'width':375,'height':700});await narrow.goto(base+'/narrow');await narrow.wait_for_timeout(300);await case('narrow-contact',narrow)
   # Actual installed-extension reload invalidates old isolated contexts. Keep
   # pages loaded; trigger the old focus/resize/mutation paths, then reopen.
   await publisher.bring_to_front();before_error=len(report['runtimeErrors']);old_worker=worker
   async with context.expect_event('serviceworker',predicate=lambda w:w.url.startswith('chrome-extension://'+extension_id+'/'),timeout=15000) as started:
    try:await old_worker.evaluate('chrome.runtime.reload()')
    except Exception:pass
   worker=await started.value
   await publisher.evaluate('()=>{window.dispatchEvent(new Event("resize"));window.dispatchEvent(new Event("focus"));document.dispatchEvent(new Event("visibilitychange"));const image=document.createElement("img");image.src="/after-reload.svg";image.width=600;image.height=800;document.body.append(image)}');await publisher.wait_for_timeout(1800)
   report['reloadInvalidationErrors']=report['runtimeErrors'][before_error:]
   await case('extension-reload-without-publisher-refresh',publisher)
   # A private frame runtime channel proves the sender has a genuine tab ID.
   frame=next((f for f in publisher.frames if '/support/chat.html' in f.url),None)
   if frame:report['realFrameChannel']=await frame.evaluate('()=>new Promise(resolve=>chrome.runtime.sendMessage({type:"TP_SUPPORT_CHANNEL"},value=>resolve({channelPresent:!!value?.channel,error:chrome.runtime.lastError?.message||""})))')
   report['authenticatedSupportCalls']=sum(r['authenticated'] and r['path'].startswith('/paid/support') for r in REQUESTS)
   report['passed']=all(c['passed'] for c in report['cases']) and bool(report.get('realFrameChannel',{}).get('channelPresent')) and not any('Extension context invalidated' in json.dumps(error) for error in report.get('reloadInvalidationErrors',[]))
   await context.close()
 except Exception as exc:report.update({'passed':False,'blocked':True,'error':str(exc),'traceback':traceback.format_exc()});print('BLOCKED',str(exc),flush=True)
 finally:server.shutdown();(out/'installed-support-report.json').write_text(json.dumps(report,indent=2));shutil.rmtree(profile,ignore_errors=True)
 return report['passed']

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--extension',required=True);parser.add_argument('--browser',default=chromium_executable(required=False));parser.add_argument('--out',required=True);parser.add_argument('--runtime-lib');parser.add_argument('--font-config');raise SystemExit(0 if asyncio.run(main(parser.parse_args())) else 1)
