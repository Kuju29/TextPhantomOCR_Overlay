"""Independent .23 durable chat QA: actual Chromium/IndexedDB, offline APIs only."""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import asyncio, hashlib, json, os, shutil, tempfile, threading, time, traceback, uuid
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

PROJECT=Path(os.environ['TP_QA_EXTENSION_ROOT']) if os.environ.get('TP_QA_EXTENSION_ROOT') else Path(__file__).resolve().parents[1]
ROOT=PROJECT/'src'
OUT=Path(os.getenv('TP_QA_OUTPUT') or tempfile.mkdtemp(prefix='tp-support-durable-'))
OUT.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path.startswith('/support-host-fixture'):
            body=b'<html><body><main>Publisher page</main></body></html>'
            self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        else:super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://localhost:{server.server_port}'
INIT="""window.__storageHandlers=[];window.__runtimeHandlers=[];window.__runtimeRequests=[];
window.__emitStorage=(changes)=>__storageHandlers.forEach(fn=>fn(changes,'local'));
window.__emitRuntime=(msg)=>Promise.all(__runtimeHandlers.map(fn=>new Promise(resolve=>{const value=fn(msg,{id:'qa-support'},resolve);if(value!==true)resolve(value);})));
globalThis.chrome={runtime:{lastError:null,getManifest:()=>({version:'qa-support'}),getURL:path=>BASE+'/' +path,
onMessage:{addListener:fn=>__runtimeHandlers.push(fn),removeListener:fn=>window.__runtimeHandlers=__runtimeHandlers.filter(v=>v!==fn)},
sendMessage:(msg,cb)=>{__runtimeRequests.push(msg);_runtime(msg).then(result=>cb?.(result));}},
storage:{local:{get:(keys,cb)=>_storageGet(keys).then(cb),set:(patch,cb)=>_storageSet(patch).then(()=>cb?.()),remove:(keys,cb)=>_storageRemove(keys).then(()=>cb?.())},
onChanged:{addListener:fn=>__storageHandlers.push(fn),removeListener:fn=>window.__storageHandlers=__storageHandlers.filter(v=>v!==fn)}},
tabs:{query:(opts,cb)=>_tabsQuery(opts).then(cb),create:(opts,cb)=>{window.__createdTab=opts;cb?.({id:50});},update:(id,opts,cb)=>cb?.({id,...opts}),sendMessage:(id,msg,cb)=>_tabsSend(id,msg).then(result=>cb?.(result))}};"""

class Fixture:
    def __init__(self,name):
        self.name=name;self.profile=OUT/('profile-'+name)
        shutil.rmtree(self.profile,ignore_errors=True)
        self.token=hashlib.sha256(name.encode()).hexdigest()
        # 10494/10495: this customer allowed data use (the account gate reads the consent record).
        self.store={'tpDataConsentV1':{'version':1,'granted':True,'at':1},'customApiUrl':BASE,'paidApiBase':BASE,'paidSessionToken':self.token,'paidEmail':name+'@example.com','aiServiceMode':'manual','aiProvider':'ollama','aiModel':'gemma4:e2b','aiPrompt':'private prompt','supportActivated':True}
        self.emails={self.token:self.store['paidEmail']}
        self.uploads=[];self.send_requests=[];self.committed=[];self.upload_commands={};self.message_commands={};self.pages={};self.channels={};self.views={};self.active=None;self.context=None
        self.upload_failure=False;self.send_failure=False;self.hold_send=None
        self.state={'enabled':True,'email':self.store['paidEmail'],'max_file_mb':20,'admin_presence':{'online':True,'last_seen_at':int(time.time()*1000),'server_now':int(time.time()*1000),'timeout_seconds':120},'thread':{'id':'sup_'+self.token[:32],'user_id':'cus_'+self.token[32:],'state':'waiting_admin','unread':0,'read_seq':0,'last_seq':0,'last_admin_seq':0,'notification_muted':False,'closed_seq':0,'idle_since_at':int(time.time()*1000),'updated_at':int(time.time()*1000)}}
    def tab(self,page):
        if page not in self.pages:self.pages[page]=len(self.pages)+10
        return self.pages[page]
    async def emit(self,changes):
        if not self.context:return
        for page in list(self.context.pages):
            for frame in page.frames:
                try:await frame.evaluate('(changes)=>window.__emitStorage?.(changes)',changes)
                except Exception:pass
    async def read(self,_source,keys):
        if isinstance(keys,dict):return {k:self.store.get(k,v) for k,v in keys.items()}
        if isinstance(keys,str):return {keys:self.store.get(keys)}
        return {k:self.store.get(k) for k in keys}
    async def write(self,_source,patch):
        changes={k:{'oldValue':self.store.get(k),'newValue':v} for k,v in patch.items()};self.store.update(patch)
        # Browser storage events are asynchronous relative to the setter callback.
        asyncio.create_task(self.emit(changes))
    async def remove(self,_source,keys):
        keys=[keys] if isinstance(keys,str) else keys;changes={k:{'oldValue':self.store.pop(k,None)} for k in keys};asyncio.create_task(self.emit(changes))
    async def runtime(self,source,msg):
        tab=self.tab(source['page'])
        if msg['type']=='TP_SUPPORT_CONFIG':return {'configured':True}
        if msg['type']=='TP_SUPPORT_CHANNEL':return {'channel':self.channels.setdefault(tab,str(uuid.uuid4()))}
        if msg['type']=='TP_SUPPORT_TAB_VIEW':
            scope=hashlib.sha256((self.store['customApiUrl']+'\0'+self.store['paidSessionToken']).encode()).hexdigest()[:32]
            value=msg.get('view')
            if value in ['expanded','minimized'] and source['frame'].url.startswith(BASE+'/support/chat.html') and (not msg.get('scope') or msg['scope']==scope):self.views[tab]={'scope':scope,'view':value}
            saved=self.views.get(tab,{})
            return {'view':'expanded' if saved.get('scope')==scope and saved.get('view')=='expanded' else 'minimized'}
        return {'ok':True,'tabId':tab}
    async def tabs_query(self,_source,_options):return [{'id':self.tab(self.active)}] if self.active else []
    async def tabs_send(self,_source,tab,msg):
        page=next((p for p,t in self.pages.items() if t==tab),None)
        if not page:return {'ok':False}
        values=await page.evaluate('(msg)=>window.__emitRuntime(msg)',msg)
        return next((v for v in values if isinstance(v,dict)),{'ok':True})
    async def route(self,route):
        req=route.request;path=urlsplit(req.url).path
        if path.endswith('.js'):await route.continue_();return
        if req.method=='OPTIONS':
            await route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'*'});return
        if path=='/meta':body={'ok':True,'paid':{'configured':True}}
        elif path in ['/paid/support','/paid/support/status']:
            identity=req.headers.get('authorization','Bearer '+self.token).removeprefix('Bearer ')
            body=self.state|{'email':self.emails.get(identity,'account-b@example.com'),'thread':self.state['thread']|{'id':'sup_'+identity[:32],'user_id':'cus_'+identity[32:]}}
        elif path.startswith('/paid/support/messages') and req.method=='GET':body={'items':self.committed[-100:],'has_more':False}
        elif path=='/paid/support/messages' and req.method=='POST':
            payload=json.loads(req.post_data);self.send_requests.append(payload)
            if self.hold_send:await self.hold_send.wait()
            command=payload['command_id']
            if command not in self.message_commands:
                seq=len(self.committed)+1;self.committed.append({'id':'msg_'+str(seq),'seq':seq,'sender':'customer','created_at':int(time.time()*1000),'text':payload['text'],'attachments':[next(v for v in self.upload_commands.values() if v['id']==identifier) for identifier in payload['attachments']]})
                self.message_commands[command]={'ok':True,'id':'msg_'+str(seq),'seq':seq};self.state['thread']['last_seq']=seq
            body=self.message_commands[command]
            if self.send_failure:
                self.send_failure=False;await route.fulfill(status=503,content_type='application/json',body='{"error":{"message":"Lost response"}}');return
        elif path=='/paid/support/attachments' and req.method=='POST':
            command=req.headers['x-command-id'];raw=req.post_data_buffer or b'';self.uploads.append({'command':command,'bytes':hashlib.sha256(raw).hexdigest(),'size':len(raw),'name':req.headers['x-file-name']})
            if command not in self.upload_commands:
                self.upload_commands[command]={'id':'att_'+format(len(self.upload_commands)+1,'032x'),'name':req.headers['x-file-name'],'size':len(raw),'type':'application/zip'}
            body=self.upload_commands[command]
            if self.upload_failure:
                self.upload_failure=False;await route.fulfill(status=503,content_type='application/json',body='{"error":{"message":"Lost upload response"}}');return
        elif path=='/paid/support/action':
            payload=json.loads(req.post_data)
            if payload['action']=='close':self.state['thread']['state']='resolved'
            if payload['action']=='reopen':self.state['thread']['state']='waiting_admin'
            body={'ok':True,'state':self.state['thread']['state']}
        else:body={'ok':True}
        await route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps(body))
    async def start(self,playwright):
        options={'headless':True,'args':['--no-sandbox'],'viewport':{'width':390,'height':650}}
        options['executable_path']=chromium_executable()
        self.context=await playwright.chromium.launch_persistent_context(str(self.profile),**options)
        self.pages={};self.channels={};self.views={};self.active=None
        for name,handler in [('_storageGet',self.read),('_storageSet',self.write),('_storageRemove',self.remove),('_runtime',self.runtime),('_tabsQuery',self.tabs_query),('_tabsSend',self.tabs_send)]:await self.context.expose_binding(name,handler)
        await self.context.add_init_script('const BASE='+json.dumps(BASE)+';'+INIT)
        await self.context.route('**/paid/**',self.route);await self.context.route('**/meta',self.route)
        return self.context
    async def page(self):
        p=await self.context.new_page();self.tab(p);self.active=p;p.set_default_timeout(7000)
        p.on('pageerror',lambda error:print('BROWSER_ERROR',str(error),flush=True))
        await p.goto(BASE+'/support/chat.html');await p.locator('#conversation').wait_for(state='visible');await p.wait_for_timeout(250)
        return p
    async def close(self):
        if self.context:await self.context.close();self.context=None

async def file(page,name='durable.zip'):
    await page.evaluate('''name=>{const data=new DataTransfer();data.items.add(new File(['PKprivate-file'],name,{type:'application/zip'}));document.getElementById('text').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}''',name)
    await page.wait_for_function('!document.getElementById("send").disabled')

results=[]
async def check(name,fn):
    if os.getenv('CHAT_TEST_FILTER') and os.environ['CHAT_TEST_FILTER'] not in name:return
    print('RUN',name,flush=True)
    try:await asyncio.wait_for(fn(),timeout=45);result={'name':name,'passed':True}
    except Exception as error:traceback.print_exc();result={'name':name,'passed':False,'error':str(error)[:1200]}
    results.append(result);print('RESULT',json.dumps(result),flush=True)

async def tests(playwright):
    async def transactional_module():
        f=Fixture('transactional-module');await f.start(playwright);p=await f.context.new_page()
        await p.goto(BASE+'/support-host-fixture')
        result=await p.evaluate('''async base=>{
          const d=await import(base+'/support/drafts.js');
          const identity={base,token:'private'};
          const scope=await d.supportDraftScope(identity,'CUSTOMER@example.com');
          const same=await d.supportDraftScope(identity,' customer@example.com ');
          const other=await d.supportDraftScope(identity,'second@example.com');
          const otherApi=await d.supportDraftScope({base:base+'/other'},'customer@example.com');
          if(scope!==same||scope===other||scope===otherApi)throw new Error('Draft namespace collision');
          await d.setDraftText(scope,'Shared immutable text');
          const blob=new File(['PKprivate-bytes'],'private.zip',{type:'application/zip'});
          await d.addDraftFile(scope,blob,'upload-original');
          await d.updateDraftFile(scope,'upload-original',{id:'att_'+'a'.repeat(32),name:'private.zip',size:blob.size,type:blob.type});
          const before=await d.readDraft(scope),claimed=await d.claimDraft(scope,before.revision,'owner-a');
          const pending=structuredClone(claimed.pending.body);
          let busy='',edit='';
          try{await d.claimDraft(scope,before.revision,'owner-b')}catch(e){busy=e.code}
          try{await d.setDraftText(scope,'Must not replace pending text')}catch(e){edit=e.code}
          if(busy!=='DRAFT_BUSY'||edit!=='DRAFT_PENDING')throw new Error('Claim/edit lock missing');
          await d.settleDraft(scope,'wrong-message','owner-b',true);
          const preserved=await d.readDraft(scope);
          if(JSON.stringify(preserved.pending.body)!==JSON.stringify(pending))throw new Error('Wrong command cleared pending draft');
          await d.settleDraft(scope,pending.command_id,'owner-a',false);
          const retry=await d.claimDraft(scope,0,'owner-b');
          if(JSON.stringify(retry.pending.body)!==JSON.stringify(pending))throw new Error('Retry changed immutable body');
          const limits=scope+'-limits';
          const added=await Promise.allSettled(Array.from({length:7},(_,i)=>d.addDraftFile(limits,new File(['x'],'file'+i+'.zip'),'upload'+i)));
          const bounded=await d.readDraft(limits);
          if(added.filter(x=>x.status==='fulfilled').length!==6||bounded.files.length!==6)throw new Error('Parallel file quota lost');
          return {scope,pending,fileText:await retry.files[0].file.text(),revision:retry.revision};
        }''',BASE)
        assert result['fileText']=='PKprivate-bytes'
        await f.close();await f.start(playwright);p=await f.context.new_page();await p.goto(BASE+'/support-host-fixture')
        restored=await p.evaluate('''async ({base,scope})=>{const d=await import(base+'/support/drafts.js');const record=await d.readDraft(scope);return {text:record.text,body:record.pending.body,fileText:await record.files[0].file.text(),name:record.files[0].file.name};}''',{'base':BASE,'scope':result['scope']})
        assert restored=={'text':'Shared immutable text','body':result['pending'],'fileText':'PKprivate-bytes','name':'private.zip'},restored
        await f.close()
    await check('Module transactional quota claim lock immutable retry and structured File persist across actual restart',transactional_module)
    async def navigation_restart():
        f=Fixture('navigation-restart');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Private draft survives navigation and real browser restart');await file(p)
        await p.wait_for_timeout(500);await p.reload();await p.locator('#conversation').wait_for(state='visible')
        await p.wait_for_function('document.getElementById("text").value==="Private draft survives navigation and real browser restart" && document.querySelectorAll("#files .file").length===1')
        await f.close();await f.start(playwright);p=await f.page()
        await p.wait_for_function('document.getElementById("text").value==="Private draft survives navigation and real browser restart" && document.querySelectorAll("#files .file").length===1')
        await p.locator('#send').click();await p.wait_for_function('document.querySelectorAll("#files .file").length===0')
        assert len(f.committed)==1 and len(f.committed[0]['attachments'])==1 and len(f.upload_commands)==1
        await f.close()
    await check('Draft text uploaded metadata and file survive reload and actual browser-process restart',navigation_restart)
    async def upload_recovery():
        f=Fixture('upload-recovery');f.upload_failure=True;await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Keep failed-upload draft');await file(p);await p.get_by_role('button',name='Retry upload').wait_for();await p.wait_for_timeout(500)
        await f.close();await f.start(playwright);p=await f.page()
        await p.wait_for_function('document.querySelectorAll("#files .file").length===1')
        retry=p.get_by_role('button',name='Retry upload')
        if await retry.count():await retry.click()
        await p.wait_for_function('!document.getElementById("send").disabled');await p.locator('#send').click()
        await p.wait_for_function('document.querySelectorAll("#files .file").length===0')
        assert len(f.uploads)>=2 and len({u['command'] for u in f.uploads})==1 and len({u['bytes'] for u in f.uploads})==1,f.uploads
        assert len(f.upload_commands)==1 and len(f.committed)==1 and len(f.committed[0]['attachments'])==1
        await f.close()
    await check('Lost upload response restores original File and replays original upload command after restart',upload_recovery)
    async def send_recovery():
        f=Fixture('send-recovery');f.send_failure=True;await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Immutable retry across restart');await file(p);await p.locator('#send').click()
        await p.get_by_text('Lost response',exact=False).wait_for();await p.wait_for_timeout(500)
        assert len(f.committed)==1;await f.close();await f.start(playwright);p=await f.page()
        await p.wait_for_function('document.getElementById("text").value==="Immutable retry across restart"')
        await p.locator('#send').click();await p.wait_for_function('document.getElementById("text").value===""')
        assert len(f.send_requests)==2 and f.send_requests[0]==f.send_requests[1] and len(f.committed)==1,f.send_requests
        await f.close()
    await check('Lost send response keeps immutable shared command across browser restart without duplicate message',send_recovery)
    async def multitab_same_draft():
        f=Fixture('multitab-same-draft');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('One shared draft');await file(p);await p.wait_for_timeout(500);q=await f.page()
        await q.wait_for_function('document.getElementById("text").value==="One shared draft" && document.querySelectorAll("#files .file").length===1')
        assert not await p.locator('#send').is_disabled() and not await q.locator('#send').is_disabled()
        await asyncio.gather(p.locator('#compose').evaluate('(form)=>form.requestSubmit()'),q.locator('#compose').evaluate('(form)=>form.requestSubmit()'))
        await p.wait_for_function('document.getElementById("text").value===""');await q.wait_for_function('document.getElementById("text").value===""')
        assert len(f.committed)==1 and len({r['command_id'] for r in f.send_requests})==1,f.send_requests
        await f.close()
    await check('Two tabs restore one durable draft and simultaneous sends create only one immutable command/message',multitab_same_draft)
    async def account_isolation():
        f=Fixture('account-isolation');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Secret account A draft');await file(p);await p.wait_for_timeout(500)
        previous=f.token;original_email=f.store['paidEmail'];f.token='f'*64;await f.write({}, {'paidSessionToken':f.token,'paidEmail':'account-b@example.com'});await p.wait_for_timeout(400)
        assert 'Secret account A draft'!=await p.locator('#text').input_value() and await p.locator('#files .file').count()==0
        await f.write({}, {'paidSessionToken':previous,'paidEmail':original_email});await p.wait_for_function('document.getElementById("text").value==="Secret account A draft" && document.querySelectorAll("#files .file").length===1')
        publisher=await f.context.new_page();await publisher.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        assert not await publisher.evaluate('(origin)=>{try{return window.localStorage.getItem(origin)}catch{return false}}',BASE)
        assert 'Secret account A draft' not in await publisher.locator('body').inner_text()
        await f.close()
    await check('Durable draft is isolated by authenticated scope and absent from publisher DOM/storage',account_isolation)
    async def reauth_and_api_isolation():
        f=Fixture('reauth-api-isolation');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Same customer durable draft');await file(p);await p.wait_for_timeout(500)
        renewed='e'*64;f.emails[renewed]=f.store['paidEmail'];await f.write({}, {'paidSessionToken':renewed});await p.wait_for_timeout(400)
        await p.wait_for_function('document.getElementById("text").value==="Same customer durable draft" && document.querySelectorAll("#files .file").length===1')
        # normalizeUrl intentionally aliases127.0.0.1 tolocalhost; use a distinct port.
        other='http://localhost:'+str(server.server_port+1);await f.write({}, {'customApiUrl':other,'paidApiBase':other});await p.wait_for_timeout(400)
        assert await p.locator('#text').input_value()=='' and await p.locator('#files .file').count()==0,{'text':await p.locator('#text').input_value(),'error':await p.locator('#error').text_content()}
        await f.write({}, {'customApiUrl':BASE,'paidApiBase':BASE});await p.wait_for_function('document.getElementById("text").value==="Same customer durable draft" && document.querySelectorAll("#files .file").length===1')
        await f.close()
    await check('Same authenticated customer reauth restores draft but another API base cannot display it',reauth_and_api_isolation)
    async def immediate_text_navigation():
        f=Fixture('immediate-text-navigation');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Latest keystroke before immediate full reload');await p.reload();await p.locator('#conversation').wait_for(state='visible')
        await p.wait_for_function('document.getElementById("text").value==="Latest keystroke before immediate full reload"')
        await f.close()
    await check('Latest input survives immediate full reload without waiting for a debounce timer',immediate_text_navigation)
    async def later_edit_survives_send():
        f=Fixture('later-edit-send');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('First immutable send');await p.wait_for_timeout(500);q=await f.page()
        await q.wait_for_function('document.getElementById("text").value==="First immutable send"')
        f.hold_send=asyncio.Event();await p.locator('#send').click()
        for _ in range(50):
            if f.send_requests:break
            await p.wait_for_timeout(50)
        assert len(f.send_requests)==1
        await q.wait_for_timeout(150)
        locked=await q.locator('#text').is_disabled()
        if not locked:await q.locator('#text').fill('Newer unsent edit from second tab')
        f.hold_send.set();await p.wait_for_timeout(600)
        assert len(f.committed)==1 and f.committed[0]['text']=='First immutable send'
        if not locked:
            await q.reload();await q.locator('#conversation').wait_for(state='visible')
            await q.wait_for_function('document.getElementById("text").value==="Newer unsent edit from second tab"')
        else:await q.wait_for_function('document.getElementById("text").value===""')
        await f.close()
    await check('Pending send either locks cross-tab edits or preserves a newer revision after successful old send',later_edit_survives_send)
    async def account_switch_during_claim():
        f=Fixture('account-switch-claim');await f.start(playwright);p=await f.page()
        await p.locator('#text').fill('Private A message must never go to B');await p.wait_for_timeout(500)
        await p.evaluate('''()=>{
          const original=IDBObjectStore.prototype.get;
          window.__holdClaim=true;window.__claimEntered=false;
          IDBObjectStore.prototype.get=function(key){
            const store=this,request=original.call(store,key);
            if(store.name!=='drafts'||store.transaction.mode!=='readwrite'||!window.__holdClaim)return request;
            return new Proxy(request,{
              get:(target,property)=>Reflect.get(target,property,target),
              set(target,property,value){
                if(property!=='onsuccess'){target[property]=value;return true;}
                target.onsuccess=event=>{
                  window.__claimEntered=true;
                  const spin=()=>{if(!window.__holdClaim){value(event);return;}const keep=original.call(store,'__qa_keepalive');keep.onsuccess=spin;};spin();
                };return true;
              }
            });
          };
        }''')
        await p.locator('#send').click();await p.wait_for_function('window.__claimEntered===true')
        previous=f.token;email=f.store['paidEmail'];await f.write({}, {'paidSessionToken':'d'*64,'paidEmail':'account-b@example.com'});await p.wait_for_timeout(100)
        await p.evaluate('window.__holdClaim=false');await p.wait_for_timeout(650)
        assert not f.send_requests,'A draft was dispatched after account switched to B: '+str(f.send_requests)
        await f.write({}, {'paidSessionToken':previous,'paidEmail':email});await p.wait_for_function('document.getElementById("text").value==="Private A message must never go to B"')
        await f.close()
    await check('Account switch during actual IndexedDB claim cannot dispatch original private text under new token',account_switch_during_claim)

async def main():
    async with async_playwright() as playwright:await tests(playwright)
    server.shutdown();summary={'checks':len(results),'passed':sum(item['passed'] for item in results),'results':results,'limitations':'Actual Chromium persistent profile/IndexedDB with mocked Chrome runtime and offline API; not an installed-extension runtime test.'}
    (OUT/'draft-browser-report-10423.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
    if summary['checks']!=summary['passed']:raise SystemExit(1)
if __name__=='__main__':asyncio.run(main())
