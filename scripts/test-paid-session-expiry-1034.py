import sys as _tp_sys
from pathlib import Path as _TpPath
_tp_sys.path.insert(0, str(_TpPath(__file__).resolve().parent / 'lib'))
from chromium_path import chromium_executable  # the one shared Chromium resolver
import os
import json, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def do_GET(self):
  if self.path=='/qa':
   self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(b'<html><body></body></html>');return
  path=urlsplit(self.path).path
  if not path.startswith('/src/') or not path.endswith(('.js','.css')):self.send_error(404);return
  super().do_GET()
 def log_message(self,*a):pass
s=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=s.serve_forever,daemon=True).start()
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=chromium_executable(),headless=True,args=['--no-sandbox','--single-process','--no-zygote','--disable-dev-shm-usage']);ctx=b.new_context();page=ctx.new_page();page.goto('http://127.0.0.1:'+str(s.server_port)+'/qa');print(json.dumps(page.evaluate('''async()=>{
 const {createPaidServiceController}=await import('/src/popup/controllers/paid-service-controller.js');
 const keys=['mode','sources','apiUrl','aiService','aiServiceWrap','aiPaidPanel','aiPaidUnavailable','aiPaidConnectionMessage','aiPaidLogin','aiPaidAccount','aiPaidModel','aiPaidBuy','aiPaidDetails','aiPaidRefresh','aiPaidLogout','aiPaidInline','aiPaidStatus','aiPaidTitle','aiPaidSubtitle','aiPaidCode','aiPaidEmail','aiPaidEmailLabel','aiPaidCredits','aiPaidAccountState'];
 const els=Object.fromEntries(keys.map(k=>{const el=document.createElement(k.includes('Inline')?'div':k.includes('Model')?'select':'button');document.body.append(el);return[k,el]}));
 els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value='http://127.0.0.1:7860';
 const store={tpDataConsentV1:{version:1,granted:true,at:1},customApiUrl:els.apiUrl.value,paidApiBase:els.apiUrl.value,paidSessionToken:'synthetic',paidModel:'qa/test',aiServiceMode:'paid'};
 const state={lastSavedApiUrl:els.apiUrl.value};let expired=false;
 const order={id:'ord_'+'a'.repeat(32),package_id:'pkg_qa',package_version:1,package_name:'QA',amount_satang:2900,credits:'250000',months:6,status:'waiting',method:'checkout',mode:'live',checkout_url:'https://checkout.stripe.com/c/pay/QA',checkout_expires_at:Date.now()+600000,cancel_allowed:true,recheck_allowed:true};
 const data={email:'qa@example.com',credits:{available:'10000',held:'0'},paid_paused:false,models:[{id:'qa/test',name:'QA',eligible_tp:'10000'}],packages:[{id:'pkg_qa',version:1,name:'QA',price_satang:2900,credits:'250000',months:6}],purchase:{ready:true},history:Object.fromEntries(['orders','payments','usage','lots'].map(k=>[k,{items:k==='orders'?[order]:[],total:k==='orders'?1:0,offset:0,limit:25,has_more:false}]))};
 const calls=[];globalThis.fetch=async(url,o)=>{calls.push(String(url));if(expired&&!String(url).endsWith('/status'))return new Response(JSON.stringify({error:{code:'AUTH_REQUIRED',message:'Sign in'}}),{status:401});return new Response(JSON.stringify(String(url).endsWith('/status')?{available:true}:String(url).includes('/orders/')?order:data));};
 const wait=async()=>{for(let n=0;n<20;n++)await new Promise(r=>setTimeout(r,0));};
 let controller;controller=createPaidServiceController({els,state,getStorage:async keys=>Object.fromEntries(keys.map(k=>[k,store[k]])),setStorage:async patch=>Object.assign(store,structuredClone(patch)),toggleUi:()=>controller?.applyVisibility()});
 await controller.initialize();controller.setAvailability(true,els.apiUrl.value);await wait();
 if(!state.paidReady)throw Error('Initial signed-in state missing');els.aiPaidBuy.click();await wait();if(!els.aiPaidInline.textContent.includes('Resume payment'))throw Error('Initial order missing');
 expired=true;const inlineButton=name=>[...els.aiPaidInline.querySelectorAll('button')].find(b=>b.textContent===name||b.getAttribute('aria-label')===name);if(!inlineButton('Reload'))throw Error('Signed-in inline account reload action missing');inlineButton('Reload').click();await wait();
 const after401={paidReady:state.paidReady,tokenSaved:!!store.paidSessionToken,inlineHasResume:els.aiPaidInline.textContent.includes('Resume payment'),inlineMessage:els.aiPaidInline.textContent.includes('Sign in')};
 if(after401.paidReady||after401.tokenSaved||after401.inlineHasResume)throw Error('Expired account must clear readiness/token and close old account');
 if(els.aiPaidLogin.style.display==='none')throw Error('Sign-in route must be visible immediately');
 if(!els.aiPaidStatus.textContent.includes('expired'))throw Error('Explain session expiry');
 controller.dispose();return {after401,loginVisible:true,scope:'Native production Paid controller + inline portal; synthetic token/network; no real provider'};
}'''),indent=2))
 page.goto('http://127.0.0.1:'+str(s.server_port)+'/qa')
 print(json.dumps(page.evaluate('''async()=>{
   document.body.innerHTML='<main id="account"></main>';
   const store={tpDataConsentV1:{version:1,granted:true,at:1},customApiUrl:'http://127.0.0.1:7860',paidApiBase:'http://127.0.0.1:7860',paidSessionToken:'synthetic',paidModel:'qa/test',paidPendingLogin:{email:'qa@example.com'}};
   const opened=[];globalThis.chrome={runtime:{getURL:path=>'http://extension.invalid/'+path},tabs:{create:(opts,callback)=>{opened.push(opts.url);callback?.({id:1});}},storage:{local:{get:(keys,cb)=>cb(Object.fromEntries(keys.map(k=>[k,store[k]]))),set:(patch,cb)=>{Object.assign(store,patch);cb?.();}},onChanged:{addListener(){},removeListener(){}}}};
   const row={id:'ord_'+'b'.repeat(32),status:'waiting',method:'checkout',package_id:'qa',package_version:1,package_name:'QA',amount_satang:2900,credits:'250000',months:6,cancel_allowed:true,recheck_allowed:true};
   const account={email:'qa@example.com',credits:{available:'0',held:'0'},models:[],packages:[],purchase:{ready:true},history:Object.fromEntries(['orders','payments','lots','usage'].map(k=>[k,{items:k==='orders'?[row]:[],total:k==='orders'?1:0}]))};
   let expired=false;
   const requests=[];
   globalThis.fetch=async(url)=>{requests.push(String(url));return String(url).endsWith('/meta')?new Response('{}'):expired?new Response('{"error":{"code":"AUTH_REQUIRED","message":"Sign in"}}',{status:401}):new Response(JSON.stringify(String(url).includes('/orders/')?row:account));};
   const wait=async()=>{for(let n=0;n<20;n++)await new Promise(r=>setTimeout(r,0));};
   await import('/src/paid/account.js');await wait();
   const find=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);
   if(!find('Reload')||!document.body.textContent.includes('qa@example.com'))throw Error('Initial standalone account not loaded');
   expired=true;find('Reload').click();await wait();
   if(!document.body.textContent.includes('session has expired')||!find('Back')||find('Resume payment'))throw Error('Standalone session expiry must replace stale controls with the extension return route');
   if(store.paidSessionToken!==''||store.paidApiBase!==''||store.paidModel!==''||store.paidPendingLogin!==null)throw Error('Standalone session expiry must clear only the expired saved identity');
   find('Back').click();await wait();
   if(opened.length!==1||!opened[0].endsWith('popup/popup.html'))throw Error('Standalone route must open extension sign-in');
   const accountReads=requests.filter(url=>url.endsWith('/paid/account')).length;
   await import('/src/paid/account.js?reopen-after-expiry');await wait();
   if(find('Resume payment')||!document.body.textContent.includes('sign in to Paid first')||requests.filter(url=>url.endsWith('/paid/account')).length!==accountReads)throw Error('Reopening must not reuse the expired session or request another account with it');
   if(requests.some(url=>url.endsWith('/paid/auth/logout')))throw Error('An expired identity must not trigger a network logout');
   return {standaloneExpired:true,staleControlsRemoved:true,signInRoute:true,savedIdentityCleared:true,reopeningCannotRestoreExpiredSession:true,noLogoutRequest:true,scope:'Native standalone account; synthetic network/storage/tab API'};
 }'''),indent=2))
 page.goto('http://127.0.0.1:'+str(s.server_port)+'/qa')
 print(json.dumps(page.evaluate('''async()=>{
   document.body.innerHTML='<main id="account"></main>';
   const store={tpDataConsentV1:{version:1,granted:true,at:1},customApiUrl:'http://127.0.0.1:7860',paidApiBase:'http://127.0.0.1:7860',paidSessionToken:'old-session',paidModel:'old/model',paidPendingLogin:null};
   let expired=false,holdExpiryRead=false;const patches=[],requests=[],listeners=new Set();const changed=(changes,area)=>{for(const listener of [...listeners])listener(changes,area);};
   window.releaseExpiryRead=null;
   const values=keys=>Object.fromEntries(keys.map(k=>[k,store[k]]));
   globalThis.chrome={runtime:{getURL:path=>'http://extension.invalid/'+path},storage:{local:{
     get:(keys,cb)=>{
       if(holdExpiryRead&&keys.includes('paidSessionToken')&&keys.includes('paidApiBase')&&!keys.includes('customApiUrl')){
         holdExpiryRead=false;window.releaseExpiryRead=()=>cb(values(keys));
       }else cb(values(keys));
     },
     set:(patch,cb)=>{patches.push(structuredClone(patch));Object.assign(store,patch);cb?.();},
   },onChanged:{addListener:listener=>{listeners.add(listener);},removeListener:listener=>{listeners.delete(listener);}}}};
   const row={id:'ord_'+'c'.repeat(32),status:'waiting',method:'checkout',package_id:'qa',package_version:1,package_name:'QA',amount_satang:2900,credits:'250000',months:6};
   const account={email:'old@example.com',credits:{available:'0'},models:[],packages:[],purchase:{ready:true},history:{orders:{items:[row],total:1}}};
   globalThis.fetch=async(url,options={})=>{
     requests.push({url:String(url),authorization:options.headers?.Authorization});
     if(String(url).endsWith('/meta'))return new Response('{}');
     if(expired&&options.headers?.Authorization==='Bearer old-session')return new Response('{"error":{"code":"AUTH_REQUIRED","message":"Sign in"}}',{status:401});
     return new Response(JSON.stringify({...account,email:store.paidSessionToken==='new-session'?'new@example.com':account.email}));
   };
   const wait=async()=>{for(let n=0;n<30;n++)await new Promise(r=>setTimeout(r,0));};
   const find=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text||b.getAttribute('aria-label')===text);
   await import('/src/paid/account.js');await wait();
   if(!find('Reload')||!document.body.textContent.includes('old@example.com'))throw Error('Initial account missing for scoped expiry race');
   expired=true;holdExpiryRead=true;find('Reload').click();
   for(let n=0;n<100&&!window.releaseExpiryRead;n++)await new Promise(r=>setTimeout(r,0));
   if(!window.releaseExpiryRead)throw Error('Expiry fresh-storage read was not reached');
   Object.assign(store,{paidSessionToken:'new-session',paidModel:'new/model',paidPendingLogin:{email:'new@example.com'}});
   changed({paidSessionToken:{oldValue:'old-session',newValue:'new-session'}},'local');
   window.releaseExpiryRead();await wait();
   if(store.paidSessionToken!=='new-session'||store.paidApiBase!=='http://127.0.0.1:7860'||store.paidModel!=='new/model'||store.paidPendingLogin?.email!=='new@example.com'||patches.some(p=>p.paidSessionToken===''))throw Error('Delayed old-session 401 cleared the replacement identity');
   if(document.body.textContent.includes('session has expired'))throw Error('Delayed old-session 401 replaced the newer account UI');
   find('Reload').click();await wait();
   if(!document.body.textContent.includes('new@example.com')||!requests.some(r=>r.url.endsWith('/paid/account')&&r.authorization==='Bearer new-session'))throw Error('Replacement account did not resume with its own identity');
   if(requests.some(r=>r.url.endsWith('/paid/auth/logout')))throw Error('Expiry race must not issue logout for either account');
   return {old401CannotClearReplacement:true,delayedFreshStorageGuard:true,replacementAccountResumes:true,noLogoutRequest:true,scope:'Native standalone account controller; synthetic storage/network with delayed expiry read'};
 }'''),indent=2))
 b.close()
s.shutdown()
