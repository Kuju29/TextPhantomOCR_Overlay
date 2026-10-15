import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
globalThis.crypto ??= webcrypto;
const adjacent=fileURLToPath(new URL('..',import.meta.url));
const root=process.env.TP_QA_EXTENSION_ROOT||(existsSync(join(adjacent,'src'))?adjacent:fileURLToPath(new URL('../../source/TextPhantom',import.meta.url)));
const saved={supportActivated:true,paidSessionToken:'a'.repeat(64),paidApiBase:'http://localhost:7860',customApiUrl:'http://localhost:7860'};
const session={},listeners=[],runtimeListeners=[],tabRemoved=[],startup=[],requests=[],notices=[];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const response=thread=>new Response(JSON.stringify({email:'customer@example.invalid',enabled:true,thread:{unread:1,last_seq:4,last_admin_seq:4,closed_seq:0,notification_muted:false,...thread}}));
let next=async()=>response({});
const select=(store,keys)=>typeof keys==='string'?{[keys]:structuredClone(store[keys])}:Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys)).map(key=>[key,structuredClone(store[key]??(Array.isArray(keys)?undefined:keys[key]))]));
const area=store=>({get:(keys,cb)=>queueMicrotask(()=>cb(select(store,keys))),set:(patch,cb)=>queueMicrotask(()=>{Object.assign(store,structuredClone(patch));cb?.();})});
globalThis.chrome={runtime:{getManifest:()=>({version:'qa'}),getURL:path=>'chrome-extension://qa/'+path,sendMessage:()=>{},lastError:null,onMessage:{addListener:fn=>runtimeListeners.push(fn)},onStartup:{addListener:fn=>startup.push(fn)}},storage:{local:area(saved),session:area(session),onChanged:{addListener:fn=>listeners.push(fn)}},tabs:{get:(id,cb)=>cb({id,url:'https://publisher.example/page'}),query:(_options,cb)=>cb([{id:5}]),sendMessage:(id,msg,opts,cb)=>{if(msg.type==='TP_SUPPORT_PING'){cb?.({ready:true,version:'qa'});return;}notices.push({id,msg});cb?.({ok:true});},onRemoved:{addListener:fn=>tabRemoved.push(fn)}}};
globalThis.fetch=async(url,options)=>{if(url.endsWith('/meta'))return new Response(JSON.stringify({ok:true,paid:{configured:true}}));requests.push({url,options});return next(url,options);};
const {supportScopeId}=await import(pathToFileURL(join(root,'src/support/client.js')));
const scope=()=>supportScopeId({base:saved.customApiUrl,token:saved.paidSessionToken});
let {pollSupport}=await import(pathToFileURL(join(root,'src/background/support.js')));
const results=[];
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){assert(Date.now()<deadline,'Queued support work did not complete');await new Promise(resolve=>setTimeout(resolve,5));}}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
const emit=changes=>listeners.forEach(fn=>fn(changes,'local'));
const runtime=(message,sender={tab:{id:5},url:'https://publisher.example'})=>new Promise(resolve=>{let handled=false;for(const fn of runtimeListeners){const asynchronous=fn(message,sender,value=>{handled=true;resolve(value)});if(asynchronous===true)handled=true;}if(!handled)resolve(undefined);});
await test('Concurrent unread triggers never overlap upstream requests',async()=>{requests.length=0;let active=0,maximum=0;next=async()=>{maximum=Math.max(maximum,++active);await tick();active--;return response({});};await Promise.all([pollSupport(),pollSupport()]);for(let i=0;i<12;i++)await tick();assert.equal(maximum,1);});
await test('Identity change during unread fetch queues fresh account with correct bearer',async()=>{
  requests.length=0;let entered,release;const started=new Promise(resolve=>entered=resolve);
  next=(_url,options)=>new Promise((resolve,reject)=>{release=()=>resolve(response({unread:0,last_seq:8}));options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})));entered();});
  const pending=pollSupport();await started;saved.paidSessionToken='b'.repeat(64);next=async()=>response({unread:0,last_seq:9});emit({paidSessionToken:{newValue:saved.paidSessionToken}});release();await pending;
  await until(()=>requests.length===2&&saved.supportUnread?.lastSeq===9);assert.equal(requests[1].options.headers.Authorization,'Bearer '+saved.paidSessionToken);
});
await test('Hide keeps old unread suppressed when only overall message cursor advances',async()=>{
  notices.length=0;const current=await scope();Object.assign(saved,{supportDockHidden:true,supportChatMuted:null,supportHideUntil:{scope:current,lastAdminSeq:5}});
  next=async()=>response({unread:3,last_seq:12,last_admin_seq:5});await pollSupport();assert.equal(saved.supportUnread.unread,3);assert.equal(saved.supportDockHidden,true);assert.equal(notices.length,0);
});
await test('A genuinely new admin reply after Hide restores only a notice/badge command',async()=>{
  notices.length=0;next=async()=>response({unread:4,last_seq:13,last_admin_seq:6});await pollSupport();assert.equal(saved.supportDockHidden,false);assert.equal(saved.supportHideUntil,null);assert.deepEqual(notices,[{id:5,msg:{type:'TP_SUPPORT_NOTICE'}}]);
});
await test('Durable server End or12h closure suppresses unread on a fresh device without local mute',async()=>{
  notices.length=0;Object.assign(saved,{supportDockHidden:false,supportChatMuted:null,supportClosedSeen:null,supportHideUntil:null});next=async()=>response({unread:3,last_seq:18,last_admin_seq:17,closed_seq:14,notification_muted:true});await pollSupport();
  assert.equal(saved.supportDockHidden,true);assert.equal(saved.supportChatMuted.scope,await scope());assert.equal(saved.supportClosedSeen.seq,14);assert.equal(saved.supportUnread.unread,3);assert.equal(notices.length,0);
});
await test('Late admin replies after End preserve suppression without resurrecting customer launcher',async()=>{
  notices.length=0;next=async()=>response({unread:4,last_seq:20,last_admin_seq:20,closed_seq:14,notification_muted:true});await pollSupport();assert.equal(saved.supportDockHidden,true);assert.equal(notices.length,0);
});
await test('Explicit server reopen from another customer device clears old local End suppression',async()=>{
  notices.length=0;next=async()=>response({unread:2,last_seq:22,last_admin_seq:20,closed_seq:14,notification_muted:false});await pollSupport();assert.equal(saved.supportDockHidden,false);assert.equal(saved.supportChatMuted,null);assert.equal(notices.length,1);
});
await test('Ended previous identity cannot mute a different verified customer',async()=>{
  const previous=await scope();Object.assign(saved,{supportDockHidden:true,supportChatMuted:{scope:previous},supportHideUntil:null});notices.length=0;saved.paidSessionToken='c'.repeat(64);next=async()=>response({unread:2,last_seq:24,last_admin_seq:24});emit({paidSessionToken:{newValue:saved.paidSessionToken}});
  await until(()=>saved.supportUnread?.lastSeq===24);assert.equal(saved.supportChatMuted,null);assert.equal(saved.supportDockHidden,false);assert.equal(notices.length,1);
});
await test('Inactive publisher page cannot assert customer activity',async()=>{requests.length=0;await runtime({type:'TP_SUPPORT_ACTIVITY'},{tab:{id:99}});for(let i=0;i<20;i++)await tick();assert.equal(requests.filter(item=>item.url.endsWith('/presence')).length,0);});
await test('Concurrent expanded-chat events issue one customer heartbeat (10490: chat frame only)',async()=>{
  const frame={tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'};
  requests.length=0;await runtime({type:'TP_SUPPORT_ACTIVITY'},{tab:{id:5}});await runtime({type:'TP_SUPPORT_ACTIVITY',reason:'minimized'},frame);for(let i=0;i<20;i++)await tick();
  assert.equal(requests.filter(item=>item.url.endsWith('/presence')).length,0,'a page or a minimized launcher never reports presence');
  requests.length=0;let active=0,maximum=0;next=async()=>{maximum=Math.max(maximum,++active);for(let i=0;i<5;i++)await tick();active--;return new Response('{"ok":true}');};await Promise.all(Array.from({length:3},()=>runtime({type:'TP_SUPPORT_ACTIVITY',reason:'expanded'},frame)));for(let i=0;i<35;i++)await tick();assert.equal(maximum,1);assert.equal(requests.filter(item=>item.url.endsWith('/presence')).length,1);
});
await test('Private frame and content script share capability only within their containing tab',async()=>{
  const a=await runtime({type:'TP_SUPPORT_CHANNEL'},{tab:{id:5},frameId:0}),b=await runtime({type:'TP_SUPPORT_CHANNEL'},{tab:{id:5},frameId:2}),other=await runtime({type:'TP_SUPPORT_CHANNEL'},{tab:{id:8}});assert.match(a.channel,/^[a-f0-9-]{36}$/);assert.equal(a.channel,b.channel);assert.notEqual(a.channel,other.channel);assert.equal((await runtime({type:'TP_SUPPORT_CHANNEL'},{})).channel,'');
});
await test('Private-frame view persists for its own navigating tab while publisher cannot change another tab',async()=>{
  const current=await scope(),privateSender={tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'};
  assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:current},privateSender)).view,'expanded');
  assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW'},{tab:{id:5},url:'https://publisher.example/new-page'})).view,'expanded');
  assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:current},{tab:{id:8},url:'https://publisher.example'})).view,'minimized');assert.equal(session.supportTabViews[8],undefined);
});
await test('Stale identity scope cannot overwrite current tab view preference',async()=>{
  const old=await scope();saved.paidSessionToken='d'.repeat(64);const current=await scope(),sender={tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'};
  await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'minimized',scope:current},sender);await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:old},sender);assert.equal(session.supportTabViews[5].scope,current);assert.equal(session.supportTabViews[5].view,'minimized');
});
await test('Worker restart retains session tab view while browser startup clears it',async()=>{
  const current=await scope();await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:current},{tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'});
  listeners.length=runtimeListeners.length=tabRemoved.length=startup.length=0;chrome.alarms={create:()=>{},onAlarm:{addListener:()=>{}}};next=async()=>response({unread:0});
  ({pollSupport}=await import(pathToFileURL(join(root,'src/background/support.js'))+'?worker='+Date.now()));for(let i=0;i<20;i++)await tick();assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW'})).view,'expanded');
  startup.forEach(fn=>fn());await until(()=>Object.keys(session.supportTabViews||{}).length===0);assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW'})).view,'minimized');
});
await test('Closed tab revokes control capability and view before tab ID reuse',async()=>{
  const current=await scope(),sender={tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'};await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:current},sender);const before=(await runtime({type:'TP_SUPPORT_CHANNEL'},sender)).channel;
  tabRemoved.forEach(fn=>fn(5));await until(()=>!session.supportTabViews?.[5]);assert.notEqual((await runtime({type:'TP_SUPPORT_CHANNEL'},sender)).channel,before);assert.equal((await runtime({type:'TP_SUPPORT_TAB_VIEW'},sender)).view,'minimized');
});
await test('Account change during delayed view read cannot restore prior identity expanded preference',async()=>{
  const current=await scope(),sender={tab:{id:5},url:'chrome-extension://qa/support/chat.html?dock=1'};await runtime({type:'TP_SUPPORT_TAB_VIEW',view:'expanded',scope:current},sender);
  const original=chrome.storage.session.get;let entered,release;const started=new Promise(resolve=>entered=resolve);
  chrome.storage.session.get=(keys,cb)=>{const snapshot=select(session,keys);release=()=>cb(snapshot);entered();};
  const pending=runtime({type:'TP_SUPPORT_TAB_VIEW'},{tab:{id:5},url:'https://publisher.example/new-page'});await started;saved.paidSessionToken='e'.repeat(64);release();
  const answer=await pending;chrome.storage.session.get=original;assert.equal(answer.view,'minimized');
});
await test('Dock authentication requires verified Paid support identity',async()=>{
  next=async()=>response({unread:0});const result=await runtime({type:'TP_SUPPORT_AUTH'});
  assert.deepEqual(result,{authenticated:true});
});
await test('Dock authentication rejects missing Paid token without forwarding credentials',async()=>{
  const token=saved.paidSessionToken;saved.paidSessionToken='';requests.length=0;
  assert.deepEqual(await runtime({type:'TP_SUPPORT_AUTH'}),{authenticated:false});assert.equal(requests.length,0);saved.paidSessionToken=token;
});
await test('Dock authentication rejects an API change without sending the previous token',async()=>{
  const base=saved.customApiUrl;saved.customApiUrl='http://localhost:9000';requests.length=0;
  assert.deepEqual(await runtime({type:'TP_SUPPORT_AUTH'}),{authenticated:false});assert.equal(requests.length,0);saved.customApiUrl=base;
});
await test('Dock authentication rejects expired sessions and malformed identity',async()=>{
  next=async()=>new Response(JSON.stringify({error:{code:'AUTH_REQUIRED'}}),{status:401});
  assert.deepEqual(await runtime({type:'TP_SUPPORT_AUTH'}),{authenticated:false});
  next=async()=>new Response(JSON.stringify({email:'  ',enabled:true}));
  assert.deepEqual(await runtime({type:'TP_SUPPORT_AUTH'}),{authenticated:false});
});
await test('Dock authentication discards a delayed previous-account response after logout',async()=>{
  let entered,release;const started=new Promise(resolve=>entered=resolve);
  next=()=>new Promise(resolve=>{release=()=>resolve(response({unread:0}));entered();});
  const token=saved.paidSessionToken,pending=runtime({type:'TP_SUPPORT_AUTH'});await started;
  saved.paidSessionToken='';release();assert.deepEqual(await pending,{authenticated:false});saved.paidSessionToken=token;
});
const report={checks:results.length,passed:results.filter(result=>result.passed).length,results};
if(process.env.TP_QA_OUTPUT){mkdirSync(process.env.TP_QA_OUTPUT,{recursive:true});writeFileSync(join(process.env.TP_QA_OUTPUT,'background-report-10423.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));process.exitCode=results.some(result=>!result.passed)?1:0;
