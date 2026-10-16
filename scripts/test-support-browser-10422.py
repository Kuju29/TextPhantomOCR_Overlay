"""Independent real-DOM chat checks with offline API/storage fixtures only."""
import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import asyncio, hashlib, json, threading, os, tempfile, traceback, uuid, time
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.async_api import async_playwright

PROJECT=Path(os.environ['TP_QA_EXTENSION_ROOT']) if os.environ.get('TP_QA_EXTENSION_ROOT') else Path(__file__).resolve().parents[1]
if not (PROJECT/'src').is_dir(): PROJECT=Path(__file__).resolve().parents[2]/'source/TextPhantom'
ROOT=PROJECT/'src'
OUT=Path(os.getenv('TP_QA_OUTPUT') or tempfile.mkdtemp(prefix='tp-support-ui-'))
OUT.mkdir(parents=True,exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path=='/support-host-fixture':
            body=b'<html><body><main>Publisher page</main></body></html>'
            self.send_response(200);self.send_header('Content-Type','text/html');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        else:super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://localhost:{server.server_port}'
TOKEN='a'*64; SECOND='b'*64; FILE='att_'+'c'*32
results=[]
INIT="""window.__handlers=[]; window.__runtimeHandlers=[];window.__runtimeRequests=[];window.__supportConfigured=true;
window.__emitStorage=(changes)=>__handlers.forEach(fn=>fn(changes,'local'));
window.__emitRuntime=(message)=>Promise.all(__runtimeHandlers.map(fn=>new Promise(resolve=>{const pending=fn(message,{id:'qa-support'},resolve);if(pending!==true)resolve();})));
globalThis.chrome={runtime:{id:'qa-support',lastError:null,getManifest:()=>({version:'qa-support'}),getURL:path=>location.origin+'/'+path,onMessage:{addListener:fn=>__runtimeHandlers.push(fn),removeListener:fn=>window.__runtimeHandlers=__runtimeHandlers.filter(item=>item!==fn)},sendMessage:(msg,cb)=>{__runtimeRequests.push(msg);if(msg.type==='TP_SUPPORT_CHANNEL'){_supportChannel().then(channel=>cb?.({channel}));return;}if(msg.type==='TP_SUPPORT_TAB_VIEW'){_supportTabView(msg).then(value=>cb?.(value));return;}if(msg.type==='TP_SUPPORT_AUTH'){_storageGet(['paidSessionToken','tpDataConsentV1']).then(saved=>cb?.({authenticated:__supportConfigured&&saved?.tpDataConsentV1?.granted===true&&Boolean(saved?.paidSessionToken)}));return;}cb?.(msg.type==='TP_SUPPORT_CONFIG'?{configured:__supportConfigured}:{ok:true});}},
storage:{local:{get:(keys,cb)=>_storageGet(keys).then(cb),set:(patch,cb)=>_storageSet(patch).then(()=>cb?.()),remove:(keys,cb)=>_storageRemove(keys).then(()=>cb?.())},onChanged:{addListener:fn=>__handlers.push(fn),removeListener:fn=>window.__handlers=__handlers.filter(item=>item!==fn)}},
tabs:{query:(_opts,cb)=>cb([{id:10}]),create:(opts,cb)=>{window.__createdTab=opts;cb?.({id:11});},update:(id,opts,cb)=>{window.__updatedTab={id,...opts};cb?.({id});},sendMessage:(_id,msg,cb)=>{window.__tabMessage=msg;cb?.({ok:true});}}};"""

async def fixture(browser,dock=False,disabled=False,extra=None,handler=None):
    ctx=await browser.new_context(viewport={'width':390,'height':650})
    # 10495: the customer already allowed data use (the account gate is tested in test-account-gate-10495.mjs).
    store={'tpDataConsentV1':{'version':1,'granted':True,'at':1},'customApiUrl':BASE,'paidApiBase':BASE,'paidSessionToken':TOKEN,'paidEmail':'customer@example.com',
        'aiServiceMode':'manual','aiProvider':'ollama','aiModel':'gemma4:e2b','aiPrompt':'private prompt',**(extra or {})}
    requests=[]
    async def get(_source,keys):
        if keys is None:return dict(store)
        if isinstance(keys,dict): return {k:store.get(k,v) for k,v in keys.items()}
        if isinstance(keys,str): return {keys:store[keys]} if keys in store else {}
        return {k:store[k] for k in keys if k in store}
    async def broadcast(changes):
        for page in list(ctx.pages):
            for frame in page.frames:
                try:await frame.evaluate('(changes)=>window.__emitStorage?.(changes)',changes)
                except Exception:pass
    async def set_(_source,patch):
        changes={k:{'oldValue':store.get(k),'newValue':v} for k,v in patch.items()};store.update(patch)
        if patch.get('supportDockHidden'):views.clear()
        asyncio.create_task(broadcast(changes))
    async def remove(_source,keys):
        for key in ([keys] if isinstance(keys,str) else keys):store.pop(key,None)
    channels={};views={} 
    def channel(source):
        page=source['page']
        if page not in channels:channels[page]=str(uuid.uuid4())
        return channels[page]
    def tab_view(source,msg):
        page=source['page'];current=hashlib.sha256((store['customApiUrl']+'\0'+store.get('paidSessionToken','')).encode()).hexdigest()[:32]
        if msg.get('view') in ['expanded','minimized'] and source['frame'].url.startswith(BASE+'/support/chat.html') and (not msg.get('scope') or msg['scope']==current):views[page]={'scope':current,'view':msg['view']}
        saved=views.get(page,{})
        return {'view':'expanded' if saved.get('scope')==current and saved.get('view')=='expanded' else 'minimized'}
    await ctx.expose_binding('_storageRemove',remove);await ctx.expose_binding('_storageGet',get); await ctx.expose_binding('_storageSet',set_);await ctx.expose_binding('_supportChannel',channel);await ctx.expose_binding('_supportTabView',tab_view)
    await ctx.add_init_script(INIT.replace("location.origin+'/'",json.dumps(BASE)+"+'/'"))
    state={'enabled':not disabled,'email':'customer@example.com','max_file_mb':20,'admin_presence':{'online':False,'last_seen_at':1000000,'server_now':1000000+65*60000,'timeout_seconds':120},
        'thread':{'state':'waiting_customer','unread':0,'read_seq':1,'last_seq':1,'last_admin_seq':1,'notification_muted':False,'closed_seq':0,'idle_since_at':int(time.time()*1000)}}
    items=[{'id':'msg_first','seq':1,'sender':'admin','created_at':int(time.time()*1000),'text':'Private reply','attachments':[]}]
    async def route(route):
        req=route.request
        if req.url.endswith('.js'): await route.continue_(); return
        requests.append({'url':req.url,'method':req.method,'headers':req.headers,'body':None if req.headers.get('content-type')=='application/octet-stream' else req.post_data})
        if handler and await handler(route,store,state,items,requests): return
        path=req.url.removeprefix(BASE)
        if path.startswith('/paid/support/messages') and req.method=='GET': body={'items':items[-50:],'has_more':len(items)>50}
        elif path in ['/paid/support','/paid/support/status']: body=state
        elif path=='/paid/support/attachments': body={'id':FILE,'name':'private.zip','size':8,'type':'application/zip'}
        elif path.startswith('/paid/support/attachments/'):
            await route.fulfill(status=200,content_type='application/zip',body=b'PKprivate');return
        else: body={'ok':True}
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
    await ctx.route('**/paid/**',route)
    async def translate(route):
        from urllib.parse import urlparse,parse_qs
        query=parse_qs(urlparse(route.request.url).query);text=query.get('q',[''])[0]
        store.setdefault('_translations',[]).append(text)
        translated='\n'.join('ทดสอบ '+line for line in text.split('\n'))
        await route.fulfill(status=200,content_type='application/json',body=json.dumps([[[translated,text]]]))
    await ctx.route('https://translate.googleapis.com/**',translate)
    page=await ctx.new_page(); page.set_default_timeout(6000)
    page.on('pageerror',lambda error: print('BROWSER_ERROR',str(error),flush=True))
    await page.goto(BASE+'/support/chat.html'+('?dock=1' if dock else ''))
    if not dock:
        try:
            if store.get('supportDockHidden'):await page.wait_for_function('document.body.dataset.view==="hidden"')
            else:await page.locator('#conversation' if store.get('paidSessionToken') else '#login').wait_for(state='visible')
        except Exception:
            print('FIXTURE_ERROR',await page.locator('#error').text_content(),'ROUTES',[(r['method'],r['url']) for r in requests],flush=True)
            raise
    await page.wait_for_timeout(100)
    return ctx,page,store,requests,state,items

async def dock_frame(page):
    for _ in range(60):
        matches=[f for f in page.frames if '/support/chat.html' in f.url]
        if matches:return matches[0]
        await page.wait_for_timeout(50)
    raise AssertionError('Private chat iframe did not finish mounting')

async def check(name,fn,timeout=15):
    if os.environ.get('CHAT_TEST_FILTER') and os.environ['CHAT_TEST_FILTER'] not in name:return
    print('RUN',name,flush=True)
    try: await asyncio.wait_for(fn(),timeout=timeout); results.append({'name':name,'passed':True})
    except Exception as exc:
        traceback.print_exc();results.append({'name':name,'passed':False,'error':str(exc)[:1000]})
    print('RESULT',json.dumps(results[-1]),flush=True)

async def run(browser):
    async def disabled():
        c,p,s,requests,_,_=await fixture(browser,disabled=True)
        assert await p.locator('#send').is_disabled(); assert await p.locator('#file').is_disabled()
        await p.locator('#compose').evaluate('(form)=>form.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))')
        assert not any(r['url'].endswith('/messages') and r['method']=='POST' for r in requests)
        await c.close()
    await check('Disabled support disables upload/send and sends no message',disabled)
    async def send_retry():
        attempts=[]
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/messages') and route.request.method=='POST':
                attempts.append(json.loads(route.request.post_data))
                await route.fulfill(status=503 if len(attempts)==1 else 200,content_type='application/json',body=json.dumps({'error':{'code':'RETRY','message':'Temporary failure'}} if len(attempts)==1 else {'ok':True}));return True
        c,p,*_=await fixture(browser,handler=handler)
        await p.locator('#text').fill('Keep this message')
        await p.locator('#send').click(); await p.get_by_role('button',name='Retry Send',exact=True).wait_for()
        await p.locator('#send').click(); await p.wait_for_timeout(100)
        assert len(attempts)==2 and attempts[0]==attempts[1],attempts
        await c.close()
    await check('Ambiguous send retry reuses original command and text',send_retry)
    async def upload_retry():
        attempts=[]
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/attachments'):
                attempts.append(route.request.headers.get('x-command-id'))
                await route.fulfill(status=503 if len(attempts)==1 else 200,content_type='application/json',body=json.dumps({'error':{'message':'Temporary upload failure'}} if len(attempts)==1 else {'id':FILE,'name':'private.zip','size':8,'type':'application/zip'}));return True
        c,p,*_=await fixture(browser,handler=handler)
        await p.locator('#file').set_input_files({'name':'private.zip','mimeType':'application/zip','buffer':b'PKprivate'})
        await p.get_by_role('button',name='Retry upload').click(); await p.wait_for_timeout(100)
        assert len(attempts)==2 and attempts[0]==attempts[1] and attempts[0]
        await c.close()
    await check('Upload retry uses original immutable command',upload_retry)
    async def paste_file(page,name,size):
        await page.evaluate('''({name,size})=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(size)],name,{type:'application/zip'}));document.getElementById('text').dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}''',{'name':name,'size':size})
    async def attachment_cap():
        uploads=[];sends=[]
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/attachments') and route.request.method=='POST':
                size=len(route.request.post_data_buffer or b'');name=route.request.headers['x-file-name'];uploads.append({'name':name,'size':size})
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'id':'att_'+str(len(uploads)).zfill(32),'name':name,'size':size,'type':'application/zip'}));return True
            if route.request.url.endswith('/messages') and route.request.method=='POST':
                sends.append(json.loads(route.request.post_data));await route.fulfill(status=200,content_type='application/json',body='{"ok":true}');return True
        c,p,s,req,*_=await fixture(browser,handler=handler)
        await p.locator('#text').fill('Keep my draft')
        for name in ['one.zip','two.zip']:
            await paste_file(p,name,20*1048576);await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        assert len(uploads)==2 and sum(x['size'] for x in uploads)==40*1048576,uploads
        await paste_file(p,'over.zip',1);await p.locator('#error').filter(has_text='40 MB').wait_for()
        assert len(uploads)==2 and await p.locator('#files .file').count()==2,'Over-cap file partially accepted or dispatched'
        assert await p.locator('#text').input_value()=='Keep my draft'
        await p.get_by_role('button',name='Remove attachment').first.click()
        await paste_file(p,'small.zip',1);await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        assert len(uploads)==3 and uploads[-1]['size']==1 and await p.locator('#files .file').count()==2
        await p.locator('#send').click();await p.wait_for_timeout(100)
        assert len(sends)==1 and sends[0]['text']=='Keep my draft' and len(sends[0]['attachments'])==2,sends
        assert sends[0]['attachments']==['att_'+str(n).zfill(32) for n in [2,3]],sends
        await c.close()
    await check('Exact40MiB accepted; next byte rejected before POST without partial draft; remove frees quota',attachment_cap,timeout=35)
    async def attachment_retry_cap_race():
        uploads=[];entered=asyncio.Event();release=asyncio.Event()
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/attachments') and route.request.method=='POST':
                size=len(route.request.post_data_buffer or b'');uploads.append({'command':route.request.headers['x-command-id'],'size':size,'name':route.request.headers['x-file-name']})
                if len(uploads)==1:
                    await route.fulfill(status=503,content_type='application/json',body='{"error":{"message":"Temporary failure"}}');return True
                if len(uploads)==2:entered.set();await release.wait()
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'id':'att_'+str(len(uploads)).zfill(32),'name':uploads[-1]['name'],'size':size,'type':'application/zip'}));return True
        c,p,s,req,*_=await fixture(browser,handler=handler)
        await paste_file(p,'retry.zip',20*1048576);await p.get_by_role('button',name='Retry upload').wait_for()
        await p.get_by_role('button',name='Retry upload').click();await entered.wait()
        assert await p.get_by_role('button',name='Remove attachment').is_disabled()
        # Programmatic event dispatch exercises handler guards beyond disabled UI.
        await p.get_by_role('button',name='Remove attachment').evaluate('(b)=>b.dispatchEvent(new MouseEvent("click",{bubbles:true}))')
        await paste_file(p,'racing.zip',1);await p.get_by_text('Wait for the current upload or send to finish.',exact=True).wait_for()
        assert len(uploads)==2 and await p.locator('#files .file').count()==1
        release.set();await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        await paste_file(p,'next.zip',20*1048576);await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        assert len(uploads)==3 and uploads[0]==uploads[1] and await p.locator('#files .file').count()==2,uploads
        await paste_file(p,'over.zip',1);await p.locator('#error').filter(has_text='40 MB').wait_for()
        assert len(uploads)==3 and await p.locator('#files .file').count()==2
        await c.close()
    await check('Retry counts original file once; paste/remove while upload pending cannot corrupt batch',attachment_retry_cap_race,timeout=35)
    async def attachment_count_send_guard():
        uploads=[];entered=asyncio.Event();release=asyncio.Event()
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/attachments') and route.request.method=='POST':
                uploads.append(route.request.headers['x-file-name'])
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'id':'att_'+str(len(uploads)).zfill(32),'name':uploads[-1],'size':1,'type':'application/zip'}));return True
            if route.request.url.endswith('/messages') and route.request.method=='POST':
                entered.set();await release.wait();await route.fulfill(status=200,content_type='application/json',body='{"ok":true}');return True
        c,p,s,req,*_=await fixture(browser,handler=handler)
        for n in range(6):
            await paste_file(p,f'{n}.zip',1);await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        await paste_file(p,'seventh.zip',1);await p.locator('#error').filter(has_text='Up to 6 files').wait_for()
        assert len(uploads)==6 and await p.locator('#files .file').count()==6
        await p.locator('#send').click();await entered.wait()
        assert await p.get_by_role('button',name='Remove attachment').first.is_disabled()
        await p.get_by_role('button',name='Remove attachment').first.evaluate('(b)=>b.dispatchEvent(new MouseEvent("click",{bubbles:true}))')
        await paste_file(p,'sending.zip',1);await p.get_by_text('Wait for the current upload or send to finish.',exact=True).wait_for()
        assert len(uploads)==6 and await p.locator('#files .file').count()==6
        release.set();await p.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
        assert await p.locator('#files .file').count()==0
        await c.close()
    await check('Six-file limit rejects before POST and in-flight send blocks paste/remove',attachment_count_send_guard)
    async def stale_upload():
        entered=asyncio.Event(); release=asyncio.Event()
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/attachments'):
                entered.set(); await release.wait()
                try: await route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':{'message':'Temporary upload failure'}}))
                except Exception: pass
                return True
        c,p,s,_,state,_=await fixture(browser,handler=handler)
        await p.locator('#file').set_input_files({'name':'private.zip','mimeType':'application/zip','buffer':b'PKprivate'})
        await entered.wait(); s['paidSessionToken']=SECOND; state['email']='other-customer@example.com'
        await p.evaluate('(token)=>__emitStorage({paidSessionToken:{oldValue:"a".repeat(64),newValue:token}})',SECOND)
        release.set(); await p.wait_for_timeout(250)
        assert await p.get_by_role('button',name='Retry upload').count()==0,'Old-account Retry upload remains after identity change'
        assert 'private.zip' not in await p.locator('#files').inner_text()
        await c.close()
    await check('Identity change removes old-file retry closures and filenames',stale_upload)
    async def reply_badge_only():
        scope=hashlib.sha256((BASE+'\0'+TOKEN).encode()).hexdigest()[:32]
        c,p,s,requests,state,_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'minimized','supportNotification':'open'})
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture');requests.clear()
        await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host);await frame.locator('#minimized').wait_for(state='visible')
        # The dock forwards a notice only once its frame reported ready; the first
        # private command (it asks for the channel) marks that point deterministically.
        await host.wait_for_function('__runtimeRequests.some(m=>m.type==="TP_SUPPORT_CHANNEL")')
        # ...and the launcher's first account read has stored its (older) unread state,
        # so that read cannot land after the notice below.
        for _ in range(50):
            if (s.get('supportUnread') or {}).get('scope')==scope:break
            await host.wait_for_timeout(100)
        assert (s.get('supportUnread') or {}).get('scope')==scope,'Launcher never synced its unread state'
        # The server and the stored hint agree (a launcher refresh re-renders the badge from /paid/support).
        state['thread'].update(unread=3,last_seq=4,last_admin_seq=4)
        s['supportUnread']={'scope':scope,'unread':3,'lastSeq':4};await host.evaluate('__emitRuntime({type:"TP_SUPPORT_NOTICE"})')
        await frame.wait_for_function('document.getElementById("unread").textContent==="3"')
        for _ in range(50):
            if s.get('supportNoticeSeen')==scope+':4':break
            await host.wait_for_timeout(100)
        assert s.get('supportNoticeSeen')==scope+':4','The reply notice was not handled by the private frame'
        assert not await frame.locator('#expanded').is_visible() and not await frame.locator('#preview').is_visible()
        assert not any('/messages' in r['url'] or '/action' in r['url'] for r in requests),'Unread reply fetched/read despite collapsed chat'
        color_scheme=await frame.evaluate('getComputedStyle(document.documentElement).colorScheme')
        assert color_scheme=='normal',f'Minimized iframe inherits opaque native dark canvas: {color_scheme}'
        await host.screenshot(path=str(OUT/'chat-10423-unread-bubble.png'))
        await c.close()
    await check('Unread reply shows circular badge only and ignores old automatic-open preference',reply_badge_only)
    async def pagination():
        from urllib.parse import urlparse, parse_qs
        async def handler(route,_s,state,items,_requests):
            if '/paid/support/messages' in route.request.url and route.request.method=='GET':
                allitems=[{'id':f'msg_{n}','seq':n,'sender':'customer','created_at':n,'text':str(n),'attachments':[]} for n in range(1,151)]
                query=parse_qs(urlparse(route.request.url).query); before=int(query.get('before',['0'])[0])
                available=[m for m in allitems if not before or m['seq']<before]
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'items':available[-50:],'has_more':len(available)>50}));return True
        c,p,s,req,state,items=await fixture(browser,handler=handler)
        await p.locator('#older').click();await p.wait_for_timeout(120)
        await p.evaluate('document.dispatchEvent(new Event("visibilitychange"))');await p.wait_for_timeout(120)
        assert await p.locator('#older').is_visible(),'Next background refresh hides earlier-messages control despite remaining pages'
        await c.close()
    await check('Older-history control remains visible while another page exists',pagination)
    async def private_markup():
        c,p,s,req,*_=await fixture(browser)
        assert await p.locator('#history .message').count()>0
        assert await p.locator('#history .message:not([data-tp-ui-private])').count()==0
        assert await p.locator('#identity').get_attribute('data-tp-ui-private') is not None
        assert await p.locator('#reply-preview').get_attribute('data-tp-ui-private') is not None
        assert s['aiServiceMode']=='manual' and s['aiProvider']=='ollama' and s['aiPrompt']=='private prompt'
        await c.close()
    await check('Actual chat DOM marks all conversational payload private and preserves Local settings',private_markup)
    async def ui_language():
        c,p,s,req,state,items=await fixture(browser,extra={'uiLanguageV1':'th'})
        for seq,event in [(2,'closed_idle'),(3,'closed_customer'),(4,'reopened_customer')]:items.append({'id':'event_'+str(seq),'seq':seq,'sender':'system','created_at':1234567890000+seq,'event':event,'text':'','attachments':[]})
        await p.evaluate('document.dispatchEvent(new Event("visibilitychange"))')
        for _ in range(35):
            if 'ทดสอบ' in await p.locator('#expanded header strong').text_content():break
            await p.wait_for_timeout(100)
        assert 'ทดสอบ' in await p.locator('#expanded header strong').text_content(),'Chat authored UI copy is missing from translationallowlist'
        wire='\n'.join(s.get('_translations',[]))
        assert wire and 'Private reply' not in wire and 'customer@example.com' not in wire
        assert await p.locator('#history .message p').text_content()=='Private reply'
        await p.wait_for_function('document.querySelectorAll(".chat-event").length===3 && [...document.querySelectorAll(".chat-event")].every(e=>e.innerText.includes("ทดสอบ"))')
        wire='\n'.join(s.get('_translations',[]));assert all(text in wire for text in ['Chat ended automatically','Chat ended','Chat reopened'])
        assert not await p.locator('#history').get_attribute('data-tp-ui-private') and await p.locator('.chat-event small:not([data-tp-ui-private])').count()==0
        assert 'Private reply' not in wire and 'customer@example.com' not in wire and '123456789000' not in wire
        await c.close()
    await check('UI language translates authored controls and lifecycle dividers without sending private conversation or dates',ui_language)
    async def otp_cooldown():
        attempts=[]
        async def handler(route,_s,_state,_items,_requests):
            if route.request.url.endswith('/paid/auth/request'):
                attempts.append(json.loads(route.request.post_data))
                await route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'request_status':'received','delivery_status':'queued','resend_after_seconds':180}));return True
        c,p,s,req,*_=await fixture(browser,handler=handler,extra={'paidSessionToken':'','paidApiBase':''})
        await p.clock.install();await p.locator('#email').fill('customer@example.com')
        await p.locator('#request-code').click();await p.wait_for_timeout(100)
        await p.clock.fast_forward(61000);await p.locator('#request-code').click();await p.wait_for_timeout(100)
        assert len(attempts)==1,'OTP repeats after60s while server requests180s cooldown'
        assert s['aiServiceMode']=='manual' and s['aiProvider']=='ollama' and s['aiPrompt']=='private prompt'
        await p.clock.fast_forward(120000);await p.locator('#request-code').click();await p.wait_for_timeout(100)
        assert len(attempts)==2,'OTP stillblocked afterconfiguredcooldown expires'
        await c.close()
    await check('Support OTP follows actual server resend_after_seconds without switching Local mode',otp_cooldown)
    async def dock_privacy():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'expanded'})
        host=await c.new_page()
        host.on('requestfailed',lambda req:print('DOCK_REQUEST_FAILED',req.url,req.failure,flush=True))
        await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        print('DOCK_RESOURCE_URL',await host.evaluate("chrome.runtime.getURL('support/chat.html?dock=1')"),flush=True)
        await host.evaluate('window.__observed=[];window.addEventListener("message",event=>__observed.push(event.data))')
        await host.add_script_tag(path=str(ROOT/'content/support-dock.js'))
        await host.locator('#tp-support-dock').wait_for()
        for _ in range(50):
            if any('/support/chat.html' in frame.url for frame in host.frames):break
            await host.wait_for_timeout(100)
        print('DOCK_FRAMES',[frame.url for frame in host.frames],flush=True)
        frame=next(frame for frame in host.frames if '/support/chat.html' in frame.url)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})')
        await frame.locator('#conversation').wait_for(state='visible')
        assert await host.locator('#tp-support-dock').evaluate('(host)=>host.shadowRoot===null')
        assert 'Private reply' not in await host.locator('body').inner_text()
        assert 'customer@example.com' not in await host.locator('body').inner_text()
        geometry=await host.evaluate('__observed')
        assert geometry and all(m=={'type':'TP_SUPPORT_READY'} or (set(m)=={'type','view'} and m['type']=='TP_SUPPORT_GEOMETRY') for m in geometry),geometry
        await frame.locator('#minimize').click();await host.wait_for_timeout(150)
        height=await host.locator('#tp-support-dock').evaluate('(host)=>host.getBoundingClientRect().height')
        assert height==60,height
        await frame.locator('#minimized').click();await host.wait_for_timeout(150)
        height=await host.locator('#tp-support-dock').evaluate('(host)=>host.getBoundingClientRect().height')
        assert height>300,height
        await host.screenshot(path=str(OUT/'dock-cross-origin-desktop.png'))
        await c.close()
    await check('Production dock confines private chat to cross-origin iframe and exposes only public geometry/readiness',dock_privacy)
    async def dock_small_download():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'expanded'})
        host=await c.new_page();await host.set_viewport_size({'width':320,'height':650})
        await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await host.evaluate('''window.__observed=[];window.addEventListener('message',e=>__observed.push(e.data));
          const host=document.createElement('div');host.id='tp-download-control';document.body.append(host);
          const root=host.attachShadow({mode:'open'});root.innerHTML='<button class="fab" aria-expanded="true">Download</button><section class="download-panel">Downloads</section>';
          root.querySelector('.fab').onclick=()=>{const b=root.querySelector('.fab'),p=root.querySelector('.download-panel');p.hidden=!p.hidden;b.setAttribute('aria-expanded',String(!p.hidden));};''')
        await host.add_script_tag(path=str(ROOT/'content/support-dock.js'))
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})')
        await frame.locator('#conversation').wait_for(state='visible')
        assert await host.evaluate("document.getElementById('tp-download-control').shadowRoot.querySelector('.download-panel').hidden"),'Explicit chat open must collapse narrow Download panel'
        box=await host.locator('#tp-support-dock').bounding_box();assert box['x']>=0 and box['x']+box['width']<=320,box
        assert await frame.evaluate('document.documentElement.scrollWidth<=innerWidth'),'Chat has horizontal overflow at320px'
        await host.screenshot(path=str(OUT/'dock-320px.png'))
        await host.evaluate("document.getElementById('tp-download-control').shadowRoot.querySelector('.fab').click()")
        await host.wait_for_timeout(1150)
        assert await frame.locator('#minimized').is_visible(),'Opening narrow Download must minimize chat'
        assert await host.locator('#tp-support-dock').evaluate('(h)=>h.getBoundingClientRect().height')==60
        assert await host.evaluate("!document.getElementById('tp-download-control').shadowRoot.querySelector('.download-panel').hidden"),'Download must remain open'
        geometry=await host.evaluate('__observed');assert geometry and all(m=={'type':'TP_SUPPORT_READY'} or (set(m)=={'type','view'} and m['type']=='TP_SUPPORT_GEOMETRY') for m in geometry),geometry
        assert 'Private reply' not in await host.locator('body').inner_text()
        assert s['aiServiceMode']=='manual' and s['aiProvider']=='ollama'
        assert not any('/action' in r['url'] and json.loads(r['body'] or '{}').get('action')=='end' for r in req)
        await c.close()
    await check('320px chat has no overflow and Download switches panels without ending or exposing chat',dock_small_download)
    async def dock_desktop_download():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'expanded'})
        host=await c.new_page();await host.set_viewport_size({'width':1280,'height':800})
        await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await host.evaluate('''window.__observed=[];window.addEventListener('message',e=>__observed.push(e.data));
          const host=document.createElement('div');host.id='tp-download-control';document.body.append(host);
          const root=host.attachShadow({mode:'open'});root.innerHTML='<button class="fab" aria-expanded="true">Download</button><section class="download-panel" style="position:fixed;right:18px;bottom:84px;width:390px;height:450px;background:#222">Downloads</section>';''')
        await host.add_script_tag(path=str(ROOT/'content/support-dock.js'))
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})')
        await frame.locator('#conversation').wait_for(state='visible');await host.wait_for_timeout(1100)
        box=await host.locator('#tp-support-dock').bounding_box()
        download=await host.evaluate("(()=>{const r=document.getElementById('tp-download-control').shadowRoot.querySelector('.download-panel').getBoundingClientRect();return {left:r.left,right:r.right}})()")
        assert box['x']>=0 and box['x']+box['width']<download['left'],(box,download)
        assert await frame.locator('#expanded').is_visible()
        assert await host.evaluate("!document.getElementById('tp-download-control').shadowRoot.querySelector('.download-panel').hidden")
        geometry=await host.evaluate('__observed');assert geometry and all(m=={'type':'TP_SUPPORT_READY'} or (set(m)=={'type','view'} and m['type']=='TP_SUPPORT_GEOMETRY') for m in geometry),geometry
        await host.screenshot(path=str(OUT/'dock-desktop-download.png'));await c.close()
    await check('Desktop Download and private chat remain expanded side by side without overlap',dock_desktop_download)
    async def support_popup_tools():
        # Contact admin is offered only to a signed-in Paid customer (popup-entry.js:
        # an authenticated /paid/support read), in any AI mode, with explicit configuration.
        c,p,s,req,*_=await fixture(browser,disabled=True,extra={'supportDockHidden':True,'supportChatMuted':{'scope':'old'},'aiServiceMode':'manual'})
        await c.route('**/popup/popup.js',lambda route:route.fulfill(status=200,content_type='application/javascript',body='// Other popup controllers are tested independently.'))
        popup=await c.new_page();await popup.set_viewport_size({'width':420,'height':900})
        await popup.goto(BASE+'/popup/popup.html');await popup.locator('#tab-tools').click()
        contact=popup.locator('#contact-admin');await contact.wait_for(state='visible')
        assert await contact.count()==1 and await contact.evaluate("e=>e.closest('#panel-tools')!==null")
        assert await popup.locator('#reset-defaults').evaluate("e=>Boolean(e.compareDocumentPosition(document.getElementById('contact-admin'))&Node.DOCUMENT_POSITION_FOLLOWING)")
        assert await contact.locator('.contact-admin-text strong').inner_text()=='Contact admin'
        assert not await popup.locator('.app-head').get_by_text('Contact admin',exact=True).count()
        await popup.screenshot(path=str(OUT/'tools-10423-contact.png'),full_page=True)
        await popup.evaluate('__supportConfigured=false;__emitStorage({supportConfiguration:{newValue:{configured:false}}})');await contact.wait_for(state='hidden')
        await popup.evaluate('__supportConfigured=true;__emitStorage({supportConfiguration:{newValue:{configured:true}}});window.close=()=>window.__closed=true');await contact.wait_for(state='visible')
        await contact.click();await popup.wait_for_timeout(100)
        assert s['supportActivated'] is True and s['supportDockHidden'] is False and s['supportChatMuted'] is None
        assert s['aiServiceMode']=='manual' and s['aiProvider']=='ollama' and s['aiPrompt']=='private prompt' and s['paidSessionToken']==TOKEN
        assert await popup.evaluate('__runtimeRequests.some(m=>m.type==="TP_SUPPORT_SHOW")')
        assert not await popup.evaluate('Boolean(window.__createdTab || window.__updatedTab)')
        # Signing out hides the entry again (configuration alone is not a customer sign-in).
        s['paidSessionToken']='';await popup.evaluate('__emitStorage({paidSessionToken:{oldValue:"a".repeat(64),newValue:""}})');await contact.wait_for(state='hidden')
        await c.close()
    await check('Tools has one plain Contact below Reset only explicit configuration; click preserves Manual/login',support_popup_tools)
    async def admin_unconfigured_exclusion():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'expanded'})
        admin=await c.new_page();await admin.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await admin.evaluate("document.head.insertAdjacentHTML('beforeend','<meta name=\"textphantom-surface\" content=\"control-center\">')")
        await admin.add_script_tag(path=str(ROOT/'content/support-dock.js'));await admin.wait_for_timeout(150)
        assert await admin.locator('#tp-support-dock').count()==0
        opened=await admin.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');assert opened[0]=={'ok':False},opened
        assert await admin.locator('#tp-support-dock').count()==0
        page=await c.new_page();await page.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await page.evaluate('__supportConfigured=false');await page.add_script_tag(path=str(ROOT/'content/support-dock.js'));await page.wait_for_timeout(150)
        assert await page.locator('#tp-support-dock').count()==0
        result=await page.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');assert result[0]=={'ok':False},result
        assert await page.locator('#tp-support-dock').count()==0
        await c.close()
    await check('Center admin and API without explicit Center configuration never mount customer dock',admin_unconfigured_exclusion)
    async def publisher_forged_commands():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True})
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await host.evaluate('window.__observed=[];window.__sources=[];window.addEventListener("message",e=>{__observed.push(e.data);__sources.push(e.source)})')
        await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host);await frame.locator('#minimized').wait_for(state='visible');await host.wait_for_timeout(120)
        for channel in [None,'forged-channel']:
            await host.evaluate('(channel)=>__sources[0]?.postMessage({type:"TP_SUPPORT_VIEW",view:"hidden",...(channel?{channel}:{})},"*")',channel)
            await host.wait_for_timeout(80)
            assert await frame.locator('#minimized').is_visible() and not s.get('supportDockHidden'),'Missing/wrong capability can hide chat'
        observed=await host.evaluate('__observed')
        exposed=[m.get('channel') for m in observed if isinstance(m,dict) and m.get('channel')]
        resources=await host.evaluate('performance.getEntriesByType("resource").map(e=>e.name)')
        urls=[url for url in resources if 'support/chat.html' in url and 'channel=' in url]
        print('PUBLISHER_CONTROL_CAPABILITY_OBSERVABLE',bool(exposed),'QUERY_VISIBLE_IN_RESOURCE_TIMING',bool(urls),flush=True)
        if exposed:
            await host.evaluate('(channel)=>__sources[0]?.postMessage({type:"TP_SUPPORT_VIEW",view:"hidden",channel},"*")',exposed[0]);await host.wait_for_timeout(120)
            assert not s.get('supportDockHidden'),'Publisher observed/replayed command capability and hid chat'
        assert not exposed and not urls,'Control capability is exposed to publisher window events or resource URLs'
        await c.close()
    await check('Publisher cannot spoof commands or observe/replay a private control capability',publisher_forged_commands)
    async def first_contact_mount():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':False})
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture');await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.wait_for_timeout(100)
        assert await host.locator('#tp-support-dock').count()==0
        answer=await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');assert answer[0]=={'ok':True},answer
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host);await frame.locator('#conversation').wait_for(state='visible');await host.wait_for_timeout(120)
        assert await frame.locator('#expanded').is_visible() and await host.locator('#tp-support-dock').evaluate('(h)=>h.getBoundingClientRect().height')>300
        await frame.locator('#minimize').click();await host.wait_for_timeout(80);assert await frame.locator('#minimized').is_visible()
        await frame.locator('#minimized').click();await frame.locator('#conversation').wait_for(state='visible')
        await c.close()
    await check('First Contact before frame loads retains requested view and bubble click expands',first_contact_mount)
    async def embedded_without_dock_guard():
        c,p,s,req,*_=await fixture(browser)
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
        await host.evaluate('(url)=>{const f=document.createElement("iframe");f.src=url;f.style.cssText="width:400px;height:600px";document.body.append(f)}',BASE+'/support/chat.html')
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host);await frame.wait_for_function('document.body.dataset.view==="hidden"')
        await host.evaluate('document.querySelector("iframe").contentWindow.postMessage({type:"TP_SUPPORT_VIEW",view:"hidden"},"*")');await host.wait_for_timeout(160)
        assert not s.get('supportDockHidden') and not await frame.locator('#expanded').is_visible(),'Embedding WAR without dock query bypasses capability and changes global hidden flag'
        await frame.evaluate('__emitStorage({supportDockHidden:{newValue:false}})');await host.wait_for_timeout(80)
        assert not await frame.locator('#expanded').is_visible(),'A legitimate global Contact click opens a publisher embedded no-dock frame'
        await c.close()
    await check('Publisher cannot bypass command auth by embedding chat without dock query',embedded_without_dock_guard)
    async def active_page_expansion():
        c,p,s,req,*_=await fixture(browser,extra={'supportActivated':True,'supportDockView':'expanded'})
        pages=[];frames=[]
        for _ in range(2):
            host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture');await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
            for _ in range(50):
                if any('/support/chat.html' in f.url for f in host.frames):break
                await host.wait_for_timeout(100)
            frame=await dock_frame(host);await frame.locator('#minimized').wait_for(state='visible');pages.append(host);frames.append(frame)
        await pages[0].bring_to_front();await pages[0].evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frames[0].locator('#expanded').wait_for(state='visible')
        await pages[1].evaluate('__emitStorage({supportDockView:{newValue:"expanded"},supportActivated:{newValue:true}})');await pages[1].wait_for_timeout(120)
        assert await frames[1].locator('#minimized').is_visible() and not await frames[1].locator('#expanded').is_visible()
        box=await pages[1].locator('#tp-support-dock').bounding_box()
        assert box['width']==60 and box['height']==60,box
        await c.close()
    await check('Saved expanded/global activation never expands other or newly opened pages',active_page_expansion)
    async def hide_end_unread():
        scope=hashlib.sha256((BASE+'\0'+TOKEN).encode()).hexdigest()[:32]
        actions=[]
        async def handler(route,_s,state,_items,_requests):
            if route.request.url.endswith('/action') and route.request.method=='POST':
                body=json.loads(route.request.post_data);actions.append(body)
                if body['action']=='close':
                    state['thread'].update(state='resolved',notification_muted=True,closed_seq=state['thread']['last_seq']+1,last_seq=state['thread']['last_seq']+1)
                elif body['action']=='reopen':state['thread'].update(state='open',notification_muted=False)
                await route.fulfill(status=200,content_type='application/json',body='{"ok":true}');return True
        c,p,s,req,*_=await fixture(browser,handler=handler,extra={'supportActivated':True})
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture');await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        for _ in range(50):
            if any('/support/chat.html' in f.url for f in host.frames):break
            await host.wait_for_timeout(100)
        frame=await dock_frame(host);await frame.locator('#minimized').wait_for(state='visible')
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frame.locator('#conversation').wait_for(state='visible')
        await frame.locator('#text').fill('Preserve this private draft')
        await frame.locator('#file').set_input_files({'name':'draft.zip','mimeType':'application/zip','buffer':b'PKprivate'});await frame.wait_for_function('!document.getElementById("send").disabled')
        # 10477: Hide is the header icon button; End chat moved to the thread status bar.
        assert await frame.locator('#end').inner_text()=='End chat' and await frame.locator('#hide').get_attribute('aria-label')=='Hide chat'
        await frame.locator('#hide').click();await host.wait_for_timeout(100)
        assert s['supportDockHidden'] is True and await host.locator('#tp-support-dock').is_hidden()
        assert not any(x['action']=='close' for x in actions)
        await host.evaluate('__emitStorage({supportDockHidden:{newValue:true}})')
        s['supportUnread']={'scope':scope,'unread':2,'lastSeq':4};await frame.evaluate('__emitStorage({supportUnread:{newValue:{scope:"'+scope+'",unread:2,lastSeq:4}}});document.dispatchEvent(new Event("visibilitychange"))')
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_NOTICE"})');await host.wait_for_timeout(120)
        assert await host.locator('#tp-support-dock').is_hidden(),'Unread resurrected hidden launcher'
        s['supportDockHidden']=False;await host.evaluate('__emitStorage({supportDockHidden:{newValue:false}});__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frame.locator('#conversation').wait_for(state='visible')
        assert await frame.locator('#text').input_value()=='Preserve this private draft' and await frame.locator('#files .file').count()==1
        host.on('dialog',lambda dialog:dialog.accept());await host.screenshot(path=str(OUT/'chat-10423-end-before.png'))
        await frame.locator('#end').click();await host.wait_for_timeout(200)
        assert sum(x['action']=='close' for x in actions)==1 and s['supportChatMuted']=={'scope':scope} and s['supportDockHidden'] is True
        await host.evaluate('__emitStorage({supportDockHidden:{newValue:true}})');await host.evaluate('__emitRuntime({type:"TP_SUPPORT_NOTICE"})');await host.wait_for_timeout(120)
        assert await host.locator('#tp-support-dock').is_hidden()
        await host.screenshot(path=str(OUT/'chat-10423-ended-hidden.png'))
        await c.close()
    await check('Hide preserves draft/files; End server state suppresses unread until explicit Contact',hide_end_unread)
    async def standalone_hidden_restore():
        c,p,s,req,*_=await fixture(browser)
        await p.locator('#hide').click();await p.wait_for_timeout(80);assert s['supportDockHidden'] is True
        await p.reload();await p.wait_for_function('document.body.dataset.view==="hidden"')
        assert not await p.locator('#expanded').is_visible() and not await p.locator('#minimized').is_visible()
        s['supportDockHidden']=False;s['supportChatMuted']=None
        await p.evaluate('__emitStorage({supportDockHidden:{newValue:false}})');await p.locator('#minimized').wait_for(state='visible')
        assert not await p.locator('#expanded').is_visible(),'Unhiding must not autoexpand'
        await p.locator('#minimized').click();await p.locator('#conversation').wait_for(state='visible')
        assert s['aiServiceMode']=='manual' and s['aiProvider']=='ollama'
        await c.close()
    await check('Restored standalone Hide stays private; unhide shows only bubble until user click',standalone_hidden_restore)
    async def hide_new_admin():
        scope=hashlib.sha256((BASE+'\0'+TOKEN).encode()).hexdigest()[:32]
        c,p,s,req,state,items=await fixture(browser,extra={'supportActivated':True})
        host=await c.new_page();await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture');await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        frame=await dock_frame(host)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frame.locator('#expanded').wait_for(state='visible')
        await frame.locator('#text').fill('Temporary hidden draft')
        await frame.locator('#hide').click();await host.locator('#tp-support-dock').wait_for(state='hidden')
        baseline=dict(s['supportHideUntil']);state['thread'].update(last_seq=2,unread=1)
        await p.evaluate("([data,scope])=>import('/support/visibility.js').then(m=>m.syncSupportVisibility(data,scope))",[state,scope])
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_NOTICE"})');await host.wait_for_timeout(100)
        assert s['supportHideUntil']==baseline and await host.locator('#tp-support-dock').is_hidden(),'Own/system sequence resurrected Hide'
        state['thread'].update(last_seq=3,last_admin_seq=3,unread=1)
        items.append({'id':'msg_new','seq':3,'sender':'admin','created_at':int(time.time()*1000),'text':'New private reply','attachments':[]})
        await p.evaluate("([data,scope])=>import('/support/visibility.js').then(m=>m.syncSupportVisibility(data,scope))",[state,scope])
        await host.locator('#tp-support-dock').wait_for(state='visible');await host.evaluate('__emitRuntime({type:"TP_SUPPORT_NOTICE"})')
        await frame.locator('#minimized').wait_for(state='visible');await frame.locator('#unread').wait_for(state='visible')
        assert await frame.locator('#unread').inner_text()=='1' and not await frame.locator('#expanded').is_visible()
        box=await host.locator('#tp-support-dock').bounding_box();assert box['width']==60 and box['height']==60
        await host.screenshot(path=str(OUT/'chat-10423-hide-new-admin-badge.png'))
        await frame.locator('#minimized').click();await frame.locator('#conversation').wait_for(state='visible')
        await frame.locator('#history').get_by_text('New private reply',exact=True).wait_for()
        assert await frame.locator('#text').input_value()=='Temporary hidden draft','Draft changed on Hide/new admin reply'
        await c.close()
    await check('Temporary Hide only a genuinely new admin reply resurfaces minimized bubble and unread',hide_new_admin)
    async def navigation_view_restore():
        c,p,s,req,state,items=await fixture(browser,extra={'supportActivated':True})
        host=await c.new_page();url=BASE.replace('localhost','127.0.0.1')+'/support-host-fixture';await host.goto(url);await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        frame=await dock_frame(host)
        await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frame.locator('#expanded').wait_for(state='visible')
        await frame.locator('#text').fill('Navigation retains this draft');await host.wait_for_timeout(120)
        await host.evaluate('history.pushState({},"","?spa=1")');assert await frame.locator('#expanded').is_visible()
        await host.goto(url+'?full-navigation=1');await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for()
        frame=await dock_frame(host);await frame.locator('#expanded').wait_for(state='visible')
        await frame.wait_for_function('document.getElementById("text").value==="Navigation retains this draft"');assert await frame.locator('#text').input_value()=='Navigation retains this draft'
        unrelated=await c.new_page();await unrelated.goto(url);await unrelated.add_script_tag(path=str(ROOT/'content/support-dock.js'));await unrelated.locator('#tp-support-dock').wait_for()
        other=await dock_frame(unrelated);await other.locator('#minimized').wait_for(state='visible');assert not await other.locator('#expanded').is_visible()
        await frame.locator('#minimize').click();await host.reload();await host.add_script_tag(path=str(ROOT/'content/support-dock.js'));await host.locator('#tp-support-dock').wait_for();frame=await dock_frame(host);await frame.locator('#minimized').wait_for(state='visible')
        await host.screenshot(path=str(OUT/'chat-10423-navigation-minimized.png'));await c.close()
    await check('Real full navigation and SPA preserve this tab view and draft while unrelated tabs remain minimized',navigation_view_restore)
    async def actual_popup_controller():
        c,p,s,req,*_=await fixture(browser,extra={'paidSessionToken':'','paidApiBase':'','mode':'lens_text','sources':'ai','lang':'en','aiServiceMode':'manual','aiProvider':'openrouter','aiModel':'qa/chat-translator','aiKey':'sk-or-v1-'+('0'*64),'aiCloudKey':'sk-or-v1-'+('0'*64),'aiThinking':'minimum','aiBaseUrl':'https://openrouter.ai/api/v1','apiUrlDefault':BASE,'apiUrlReset':BASE,'apiDefaultsFetchedAt':int(time.time()*1000)})
        api_requests=[]
        capability={'reasoning':{'supported':True,'mandatory':False,'control':'levels','supported_efforts':['none','low'],'can_disable':True,'dynamic':True,'source':'offline QA fixture'},'vision':{'supported':True,'source':'offline QA fixture'},'limits':{'contextTokens':65536,'outputHintTokens':8192,'source':'offline QA fixture'}}
        async def api_route(route):
            if route.request.url.endswith('.js'):await route.continue_();return
            from urllib.parse import urlparse
            path=urlparse(route.request.url).path;api_requests.append(path)
            if path=='/health':body={'ok':True}
            elif path=='/meta':body={'ok':True,'paid':{'configured':True},'languages':[{'code':'en','name':'English'},{'code':'th','name':'Thai'}],'sources':[{'id':'original','name':'Original text'},{'id':'translated','name':'Lens translation'},{'id':'ai','name':'AI translation'}]}
            elif path=='/ai/resolve':body={'provider':'openrouter','model':'qa/chat-translator','requested_model':'qa/chat-translator','model_status':'available','key_status':'valid','backend_supported':True,'models_verified':True,'models_source':'live','models':['qa/chat-translator'],'model_candidates':[{'id':'qa/chat-translator','eligibility':'usable','capabilities':capability}],'model_capabilities':capability,'provider_protocol':'openai_chat_completions'}
            elif path=='/ai/probe':body={'ok':True,'provider':'openrouter','model':'qa/chat-translator','status':'passed','cached':False,'model_capabilities':capability}
            elif path=='/ai/prompt/default':body={'ok':True,'prompt':'Translate the supplied text units into the target language.'}
            else:body={'ok':True}
            await route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
        for pattern in ['**/health','**/meta','**/ai/**']:await c.route(pattern,api_route)
        await c.route('https://raw.githubusercontent.com/**',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'defaultApiUrl':BASE,'resetApiUrl':BASE})))
        await c.route('https://api.frankfurter.dev/**',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps({'base':'USD','date':'2026-10-06','rates':{'THB':35}})))
        popup=await c.new_page();await popup.set_viewport_size({'width':420,'height':900});errors=[];popup.on('pageerror',lambda e:errors.append(str(e)));popup.on('console',lambda e:print('POPUP_CONSOLE',e.type,e.text,flush=True) if e.type=='error' else None);popup.on('requestfailed',lambda r:print('POPUP_REQUEST_FAILED',r.url,r.failure,flush=True))
        await popup.goto(BASE+'/popup/popup.html')
        try:await popup.wait_for_function('document.querySelector("#mode").options.length>0 && document.querySelector("#api-status-emoji").title.includes("Online")',timeout=6000)
        except Exception:
            print('POPUP_DIAGNOSTIC',await popup.evaluate('({title:document.querySelector("#api-status-emoji").title,mode:document.querySelector("#mode").value,requests:__runtimeRequests})'),'ERRORS',errors,'API',api_requests,flush=True)
            await popup.screenshot(path=str(OUT/'popup-failure.png'),full_page=True)
            raise
        assert not errors,errors
        # .91: selecting/restoring a Manual model sends no test request; the resolved catalogue makes it usable.
        try:await popup.wait_for_function('document.querySelector("#ai-model").value==="qa/chat-translator" && !document.querySelector("#ai-model").disabled',timeout=6000)
        except Exception:
            print('READY_DIAGNOSTIC',await popup.evaluate('({keyLength:document.querySelector("#ai-key").value.length,provider:document.querySelector("#ai-provider").value,model:document.querySelector("#ai-model").value,modelText:document.querySelector("#ai-model-wrap").innerText,title:document.querySelector("#api-status-emoji").title,requests:__runtimeRequests})'),'ERRORS',errors,'API',api_requests,flush=True)
            raise
        await popup.locator('#tab-tools').click();await popup.locator('#reset-defaults').wait_for(state='visible')
        # Signed out (Manual only): Contact admin is not offered; Tools stays usable.
        await popup.wait_for_timeout(200);assert await popup.locator('#contact-admin').is_hidden()
        assert not await popup.locator('#local-picker').is_disabled() if await popup.locator('#local-picker').count() else not await popup.locator('#reset-defaults').is_disabled()
        assert await popup.locator('#mode').input_value()=='lens_text' and await popup.locator('#sources').input_value()=='ai'
        await popup.wait_for_timeout(250);await popup.screenshot(path=str(OUT/'tools-10423-real-controller.png'),full_page=True)
        await popup.locator('#tab-ai').click();await popup.locator('#ai-key').wait_for(state='visible');assert await popup.locator('#ai-provider').input_value()=='openrouter'
        await popup.locator('#ai-thinking').wait_for(state='visible');assert await popup.locator('#ai-thinking').input_value()=='minimum' and not await popup.locator('#ai-thinking').is_disabled()
        assert await popup.locator('#ai-model').input_value()=='qa/chat-translator' and not await popup.locator('#ai-model').is_disabled()
        await popup.wait_for_timeout(300);await popup.screenshot(path=str(OUT/'ai-10423-real-controller.png'),full_page=True)
        await popup.locator('#ai-page-image').scroll_into_view_if_needed();await popup.screenshot(path=str(OUT/'ai-10423-memory-image.png'),full_page=True)
        assert '/health' in api_requests and '/meta' in api_requests and '/ai/probe' not in api_requests and not errors,{'requests':api_requests,'errors':errors}
        assert s['aiServiceMode']=='manual' and not s['paidSessionToken']
        await c.close()
    await check('Actual popup controller hydrates and operates Tools and AI fields with offline browser/API fixtures',actual_popup_controller,timeout=25)
    async def presence_status():
        c,p,s,req,state,*_=await fixture(browser)
        assert 'Admin offline for about' in await p.locator('#presence').inner_text()
        assert await p.locator('#presence [data-tp-ui-value="hours"]').inner_text()=='1'
        assert await p.locator('#presence [data-tp-ui-value="minutes"]').inner_text()=='3'
        state['admin_presence']['online']=True;await p.evaluate('document.dispatchEvent(new Event("visibilitychange"))');await p.wait_for_timeout(120)
        assert await p.locator('#presence').inner_text()=='Admin online' and 'online' in (await p.locator('#presence').get_attribute('class'))
        state['admin_presence']['last_seen_at']=None;state['admin_presence']['online']=False
        await p.evaluate('document.dispatchEvent(new Event("visibilitychange"))');await p.wait_for_timeout(120)
        assert await p.locator('#presence').inner_text()=='Admin activity unavailable'
        await c.close()
    await check('Actual admin presence displays approximate offline duration online and unknown states',presence_status)
    async def six_attachments_small_screen():
        for width,height in [(320,480),(390,640)]:
            uploads=[];sends=[]
            async def handler(route,_s,_state,_items,_requests):
                if route.request.url.endswith('/attachments') and route.request.method=='POST':
                    meta={'id':'att_'+str(len(uploads)+1).zfill(32),'name':route.request.headers['x-file-name'],'size':1,'type':'application/zip'}
                    uploads.append(meta)
                    await route.fulfill(status=200,content_type='application/json',body=json.dumps(meta));return True
                if route.request.url.endswith('/messages') and route.request.method=='POST':
                    sends.append(json.loads(route.request.post_data))
                    await route.fulfill(status=200,content_type='application/json',body='{"ok":true}');return True
            c,p,s,req,*_=await fixture(browser,handler=handler,extra={'supportActivated':True})
            host=await c.new_page();await host.set_viewport_size({'width':width,'height':height})
            await host.goto(BASE.replace('localhost','127.0.0.1')+'/support-host-fixture')
            await host.add_script_tag(path=str(ROOT/'content/support-dock.js'))
            for _ in range(50):
                if any('/support/chat.html' in f.url for f in host.frames):break
                await host.wait_for_timeout(100)
            frame=await dock_frame(host)
            await host.evaluate('__emitRuntime({type:"TP_SUPPORT_OPEN"})');await frame.locator('#conversation').wait_for(state='visible')
            await frame.locator('#text').fill('Send all six private attachments')
            for n in range(6):
                await paste_file(frame,f'pending-{n}.zip',1)
                await frame.wait_for_function('!document.getElementById("send").disabled',timeout=12000)
            assert len(uploads)==6 and await frame.locator('#files .file').count()==6
            assert await frame.locator('#text').input_value()=='Send all six private attachments'
            # On short pages the bounded composer scrolls independently, keeping the footer fixed.
            await frame.locator('#compose').evaluate('(element)=>{element.scrollTop=element.scrollHeight;}')
            await frame.locator('#text').click()
            assert await frame.locator('#text').evaluate('(element)=>document.activeElement===element')
            boxes=await frame.evaluate('''() => Object.fromEntries(['send','end','hide'].map(id=>{
              const element=document.getElementById(id),rect=element.getBoundingClientRect();
              const top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
              return [id,{x:rect.x,y:rect.y,width:rect.width,height:rect.height,visible:rect.y>=0&&rect.bottom<=innerHeight&&rect.x>=0&&rect.right<=innerWidth,clickable:element===top||element.contains(top),disabled:element.disabled}];
            }))''')
            assert all(box['visible'] and box['clickable'] and not box['disabled'] for box in boxes.values()),(width,height,boxes)
            assert await frame.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,height)
            files=await frame.locator('#files').evaluate('(e)=>({height:e.getBoundingClientRect().height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})')
            assert files['height']<=97 and files['scrollHeight']>files['clientHeight'],files
            await host.screenshot(path=str(OUT/f'chat-10423-six-files-{width}x{height}.png'))
            await frame.locator('#send').click();await frame.wait_for_function('document.querySelectorAll("#files .file").length===0')
            assert len(sends)==1 and sends[0]['text']=='Send all six private attachments',sends
            assert sends[0]['attachments']==[item['id'] for item in uploads],sends
            assert len(sends[0]['attachments'])==6 and s['aiServiceMode']=='manual'
            await c.close()
    await check('Six pending attachments keep Send End Hide reachable on320x480 and390x640; sends all six ids once',six_attachments_small_screen,timeout=40)

async def main():
    async with async_playwright() as p:
        browser_path=chromium_executable()
        browser=await p.chromium.launch(**({'executable_path':browser_path} if browser_path else {}),headless=True,args=['--no-sandbox'])
        await run(browser);await browser.close()
    server.shutdown(); OUT.mkdir(parents=True,exist_ok=True)
    summary={'checks':len(results),'passed':sum(x['passed'] for x in results),'results':results}
    (OUT/'browser-agent-final.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary,indent=2))
    if summary['passed']!=summary['checks']: raise SystemExit(1)
asyncio.run(main())
