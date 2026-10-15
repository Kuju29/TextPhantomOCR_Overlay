/** Closed-popup Login handoff through production storage, settings and translation.
 * Provider capture and HTTP responses are fictional; no account or network use.
 * Run with --baseline to load the immutable uploaded .51 worker from git HEAD.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import * as loginStorage from '../src/shared/login-session.js';
import * as loginAuth from '../src/shared/login-auth.js';
import * as browserApi from '../src/shared/browser-api.js';
import {getApiBase} from '../src/background/api.js';
import * as diagnostics from '../src/shared/diagnostics.js';
import {ENDPOINT_PROVIDERS} from '../src/background/login/endpoint/login_endpoint_capture.js';
import {readFullSettings} from '../src/shared/settings.js';
import {resolveJobAiProfile} from '../src/background/ai-profile-resolver.js';
import {buildAiPayload} from '../src/background/context-menu.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';

Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});
const root=new URL('../',import.meta.url),baseline=process.argv.includes('--baseline');
const workerPath='TextPhantom/src/background/login/endpoint/login_endpoint_background.js';
const workerSource=baseline
  ? execFileSync('git',['show','HEAD:'+workerPath],{cwd:new URL('..',root),encoding:'utf8'})
  : await fs.readFile(new URL('src/background/login/endpoint/login_endpoint_background.js',root),'utf8');
const pending=loginAuth.LOGIN_PENDING_AUTH,outcome=loginAuth.LOGIN_OUTCOME;
const owner='fiction-textphantom-owner',secret='fiction-provider-cookie-never-persist';
const sessionId='lgs_'+'1'.repeat(48),accountId='2'.repeat(32);
const capabilities={reasoning:{supported:false},vision:{supported:false}};
const model=id=>({id,name:'Fictional '+id,model_capabilities:capabilities});
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;

async function fixture({provider='login_gemini',selected='',models=[model('web-default')],
  beforeCapture,afterImport,onModelWrite,importTransform,failModelWrite=false}={}){
  const base='http://localhost:7860',writes=[],requests=[],messages=[],timers=new Map();
  const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiUrlDefault:base,
    apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',
    paidSessionToken:owner,paidApiBase:base,loginProvider:provider,loginModel:selected};
  const ram={},listeners=new Set();let nextTimer=0,captureCount=0,emitEnabled=true,clock=Date.now();
  const signal=()=>{const handlers=new Set();return {addListener:fn=>handlers.add(fn),removeListener:fn=>handlers.delete(fn),
    emit:(...args)=>{for(const fn of handlers)fn(...args);}};};
  const storageSignal={addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)};
  const emit=(changes,area)=>{if(emitEnabled)for(const fn of listeners)fn(changes,area);};
  let chrome;
  function area(data,name){
    return {
      get(keys,done){const list=Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||data);
        done(Object.fromEntries(list.map(key=>[key,structuredClone(data[key]??keys?.[key])])));},
      set(patch,done){
        if(name==='local'&&Object.hasOwn(patch,'loginModel')&&failModelWrite){
          chrome.runtime.lastError={message:'Fictional local storage write failure'};done?.();delete chrome.runtime.lastError;return;
        }
        const copy=structuredClone(patch),changes={};
        for(const [key,value] of Object.entries(copy)){changes[key]={oldValue:data[key],newValue:value};data[key]=value;}
        writes.push({area:name,patch:copy,local:structuredClone(local),session:structuredClone(ram)});
        if(name==='local'&&Object.hasOwn(patch,'loginModel'))onModelWrite?.({local,ram,emit,expire});
        done?.();emit(changes,name);
      },
      remove(keys,done){for(const key of [].concat(keys))delete data[key];done?.();},
    };
  }
  chrome={runtime:{id:'fiction-closed-popup',getManifest:()=>({version:'2026.10.4.52'}),
    getURL:path=>'chrome-extension://fiction-closed-popup/'+path,onMessage:signal(),
    sendMessage:message=>{messages.push(structuredClone(message));return Promise.resolve();}},
    storage:{local:area(local,'local'),session:area(ram,'session'),onChanged:storageSignal},
    tabs:{get:(_id,done)=>done({id:8,url:ENDPOINT_PROVIDERS[provider].url,status:'complete'}),
      create:(_options,done)=>done({id:8}),onUpdated:signal(),onRemoved:signal()},
    alarms:{onAlarm:signal(),create(){}}};
  const session={id:sessionId,account_id:accountId,provider,transport:'web_endpoint',
    ...(['login_chatgpt','login_claude'].includes(provider)?{authentication_only:true,
      authentication_validation:'identity_verified',generation_validation:'not_tested'}:{})};
  const scope=await loginAuth.loginAuthScope(base,owner);
  const flow={flow_id:'lgf_'+'4'.repeat(48),provider,transport:'web_endpoint',state:'fiction-state',
    scope,apiBase:base,url:ENDPOINT_PROVIDERS[provider].url,tabId:8,browserInstance:'b'.repeat(48),
    expiresAt:clock+60000,traceId:'fiction-closed-popup'};
  const expire=()=>{clock=flow.expiresAt+1;};
  const captureCredentials=provider==='login_gemini'?{psid:secret,auth_user:0}
    : provider==='login_deepseek'?{token:secret}
    : provider==='login_claude'?{session_key:secret,organization:'fiction-organization'}
    : {access_token:secret,account_id:'fiction-workspace'};
  const fetchReply=async(address,options={})=>{
    const url=new URL(address),body=options.body?JSON.parse(options.body):null;
    assert.equal(url.origin,base,'No real endpoint is allowed in this test');
    requests.push({path:url.pathname,query:url.search,body,headers:Object.fromEntries(new Headers(options.headers))});
    if(url.pathname.endsWith('/endpoint-import')){
      assert.equal(body.credentials[Object.keys(captureCredentials)[0]],secret);
      await afterImport?.({local,ram,emit,flow,expire});
      const response={ok:true,status:'connected',endpoint_validation:'identity_verified',
        generation_validation:'not_tested',session,models,
        ...(['login_chatgpt','login_claude'].includes(provider)?{authentication_only:true,authentication_validation:'identity_verified'}:{})};
      return Response.json(importTransform?importTransform(structuredClone(response)):response);
    }
    if(url.pathname.endsWith('/cancel'))return Response.json({ok:true});
    if(url.pathname==='/meta')return Response.json({ok:true,paid:{available:true,configured:true}});
    if(url.pathname==='/paid/me')return Response.json({addons:{entitlements:[{code:'ai_login',status:'active'}]}});
    const alternate=provider==='login_gemini'?'login_deepseek':'login_gemini';
    const alternateSession={id:'lgs_'+'6'.repeat(48),provider:alternate,account_id:'7'.repeat(32),transport:'web_endpoint'};
    if(url.pathname==='/login/providers')return Response.json({providers:[{id:provider,session},{id:alternate,session:alternateSession}]});
    if(url.pathname==='/login/providers/'+alternate+'/models'){
      assert.equal(url.searchParams.get('session_id'),alternateSession.id);return Response.json({session:alternateSession,models:[model('web-default')]});
    }
    if(url.pathname==='/login/providers/'+provider+'/models'){
      assert.equal(url.searchParams.get('session_id'),session.id);return Response.json({session,models});
    }
    if(url.pathname==='/v1/ai/translate'){
      const result={schema:'tp.ai.result/1',translations:body.units.map(unit=>({id:unit.id,text:'คำแปล'})),
        missing:[],meta:{resolvedProvider:'login',resolvedModel:body.provider.model,generationAttempts:1,providerAttempts:1}};
      return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n',
        {headers:{'Content-Type':'application/x-ndjson'}});
    }
    throw new Error('Unexpected fictional endpoint: '+url.pathname);
  };
  globalThis.chrome=chrome;globalThis.fetch=fetchReply;
  const context=vm.createContext({chrome,fetch:fetchReply,URL,Uint8Array,Promise,AbortSignal,TextEncoder,
    console,crypto:webcrypto,Date:class extends Date{static now(){return clock;}},queueMicrotask,
    setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
  const imports={
    '../../../shared/login-session.js':loginStorage,
    '../../../shared/login-auth.js':loginAuth,
    '../../../shared/browser-api.js':browserApi,
    '../../api.js':{getApiBase},
    '../../../shared/diagnostics.js':diagnostics,
    './login_browser_relay.js':{RELAY_PROVIDERS:{login_claude:{}},acquireBrowserRelay:()=>()=>{}},
    './login_chatgpt_official.js':{OFFICIAL_REDIRECT:'http://127.0.0.1:1455/auth/callback',beginOfficialSignIn:async()=>{throw Error('ChatGPT not used');},readCallback:()=>({error:'unused'}),finishOfficialSignIn:async()=>{throw Error('ChatGPT not used');},officialAccount:async()=>'',officialAccessToken:async()=>null,forgetOfficial:async()=>{}},
    './login_chatgpt_web.js':{forgetWebchats:async()=>{}},
    '../login-ready-gate.js':{setAutoConnect(){}},
    '../login-tab-guard.js':{allowLoginTabs(){}},
    './login_endpoint_capture.js':{ENDPOINT_PROVIDERS,captureEndpointLogin:async()=>{
      ++captureCount;await beforeCapture?.({local,ram,emit,flow,expire});
      return {expected_identity:'f'.repeat(64),credentials:{...captureCredentials}};
    }},
  };
  const worker=new vm.SourceTextModule(workerSource,{context,identifier:new URL(workerPath,root).href});
  await worker.link(async name=>{
    const value=imports[name];assert(value,'Unexpected worker dependency: '+name);
    return new vm.SyntheticModule(Object.keys(value),function(){for(const [key,item]of Object.entries(value))this.setExport(key,item);},{context});
  });
  await worker.evaluate();await tick();
  async function start(){
    // Invoke the worker's real wake entry explicitly so its full asynchronous
    // lifecycle is awaited; an unawaitable event callback must not make this
    // integration test race its own assertions or leak into the next fixture.
    emitEnabled=false;
    try{await loginStorage.setLoginSession({[pending]:flow});}finally{emitEnabled=true;}
    await worker.namespace.wakeEndpointLogin();await tick();
  }
  async function wake(){await worker.namespace.wakeEndpointLogin();await tick();}
  function privateDataStayedPrivate(){
    assert(!JSON.stringify({local,ram,writes,messages}).includes(secret),'Provider authority must not enter storage or diagnostics');
    assert.equal(local.loginSessionId,undefined);assert.equal(local.loginAccountId,undefined);
    for(const request of requests.filter(request=>!request.path.endsWith('/endpoint-import')))
      assert(!JSON.stringify(request).includes(secret),'Provider authority must not enter translation or other requests');
  }
  async function translate(){
    const settings=await readFullSettings();
    const snapshot=await resolveJobAiProfile(settings,{language:'th'});
    assert.equal(snapshot.audit.source,'login_profile');assert(Object.isFrozen(snapshot.settings));
    const ai=await buildAiPayload('lens_text','ai',snapshot.settings,'');
    ai.conversation={documentId:'fiction-document',origins:[{pageId:'fiction-page',pageOrder:1,
      unitIds:['I1_P0'],originalIds:['fiction-source']}]};
    const result=await translateViaServer([{id:'I1_P0',text:'Hello'}],{ai,base,targetLang:'th',sourceLang:'en',
      batchId:webcrypto.randomUUID(),operationId:webcrypto.randomUUID(),tabSession:'fiction-tab',
      capabilities:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}});
    const sent=requests.find(request=>request.path==='/v1/ai/translate');
    assert(sent,'A completed Login must dispatch through the production serializer without a popup');
    assert.equal(sent.body.provider.id,'login');assert.equal(sent.body.provider.model,sessionId+'/'+settings.loginModel);
    assert.equal(sent.body.provider.apiKey,owner);assert.equal(sent.body.units[0].text,'Hello');
    assert(!JSON.stringify(sent).includes(secret));privateDataStayedPrivate();return {settings,snapshot,ai,result,sent};
  }
  return {local,ram,writes,requests,messages,flow,session,start,wake,translate,privateDataStayedPrivate,
    captureCount:()=>captureCount};
}

const checks=[],failures=[];
async function check(name,action){try{await action();checks.push(name);}catch(error){failures.push({name,
  code:error.code||'',message:error.message});}finally{globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;}}
for(const provider of ['login_gemini','login_deepseek']){
  await check(provider+' completes and translates immediately with no popup module',async()=>{
    const f=await fixture({provider});await f.start();
    assert.equal(f.ram[outcome]?.status,'connected');assert.equal(f.ram[pending],null);
    const {settings}=await f.translate();assert.equal(settings.loginModel,'web-default');
    assert.equal(settings.loginSessionId,sessionId);assert.equal(settings.loginAccountId,accountId);
    assert.equal(f.requests.filter(row=>row.path.endsWith('/endpoint-import')).length,1);
  });
  await check(provider+' retains a still-supported selected model on reconnect',async()=>{
    // A fictional expanded catalogue puts another valid model first, so an
    // unconditional first-row reset is observable. Current consumer ID stays real.
    const f=await fixture({provider,selected:'web-default',models:[model('fiction-secondary'),model('web-default')]});
    await f.start();assert.equal((await f.translate()).settings.loginModel,'web-default');
  });
  await check(provider+' replaces a removed model before publishing the Login receipt',async()=>{
    const f=await fixture({provider,selected:'removed-model'});await f.start();
    const publication=f.writes.find(row=>row.area==='session'&&row.patch[outcome]?.status==='connected');
    assert(publication,'Connected receipt must be published');assert.equal(publication.local.loginModel,'web-default');
    assert.equal((await f.translate()).settings.loginModel,'web-default');
  });
}
for(const first of ['login_gemini','login_deepseek'])await check(first+' switches to another connected provider without popup',async()=>{
  const f=await fixture({provider:first});await f.start();
  const alternate=first==='login_gemini'?'login_deepseek':'login_gemini';
  f.local.loginProvider=alternate;f.local.loginModel='';
  const snap=await resolveJobAiProfile(await readFullSettings(),{language:'th'});
  assert.equal(snap.settings.aiModel,'lgs_'+'6'.repeat(48)+'/web-default');
  assert.equal(snap.audit.source,'login_profile');
  assert(f.requests.some(row=>row.path==='/login/providers'));
  f.privateDataStayedPrivate();
});
// .77: ChatGPT chooses its route in the worker before import (test-login-chatgpt-flow-10477.mjs).
for(const provider of ['login_claude'])await check(provider+' authentication-only cannot inherit an old translation model',async()=>{
  const f=await fixture({provider,selected:'web-default',models:[]});await f.start();
  assert.equal(f.ram[outcome]?.status,'connected');assert.equal(f.ram.loginSessionId,sessionId);
  assert.equal(f.local.loginModel,'','Authentication-only must clear stale translation selection');
  await assert.rejects(()=>f.translate(),error=>error.code==='LOGIN_MODEL_UNAVAILABLE');
  assert(!f.requests.some(row=>row.path==='/v1/ai/translate'));f.privateDataStayedPrivate();
});
for(const [name,change]of [
  ['cancelled flow',async()=>loginStorage.setLoginSession({[pending]:null})],
  ['replaced Paid owner',async({local})=>{local.paidSessionToken='fiction-other-owner';}],
  ['selected provider change',async({local})=>{local.loginProvider='login_deepseek';}],
  ['selected API change',async({local})=>{local.customApiUrl='http://127.0.0.1:9999';local.paidApiBase=local.customApiUrl;}],
])await check(name+' during capture cannot import or revive the old Login',async()=>{
  const f=await fixture({beforeCapture:change});await f.start();await f.wake();
  assert(!f.requests.some(row=>row.path.endsWith('/endpoint-import')));
  assert.equal(f.ram.loginSessionId,undefined);assert.notEqual(f.ram[outcome]?.status,'connected');f.privateDataStayedPrivate();
});
await check('Cancellation after API import revokes its old flow without publishing session/model',async()=>{
  const f=await fixture({afterImport:async()=>loginStorage.setLoginSession({[pending]:null})});await f.start();await f.wake();
  assert.equal(f.requests.filter(row=>row.path.endsWith('/endpoint-import')).length,1);
  assert(f.requests.some(row=>row.path.endsWith('/cancel')));assert.equal(f.ram.loginSessionId,undefined);
  assert.equal(f.local.loginModel,'');f.privateDataStayedPrivate();
});
await check('Provider replacement while model storage completes cannot publish the old Login',async()=>{
  const f=await fixture({onModelWrite:({local})=>{local.loginProvider='login_deepseek';}});await f.start();await f.wake();
  assert.equal(f.ram.loginSessionId,undefined);assert.notEqual(f.ram[outcome]?.status,'connected');f.privateDataStayedPrivate();
});
await check('Model storage failure cannot advertise a usable Login or retain provider authority',async()=>{
  const f=await fixture({failModelWrite:true});await f.start();await f.wake();
  assert.equal(f.ram.loginSessionId,undefined);assert.notEqual(f.ram[outcome]?.status,'connected');
  assert(f.requests.some(row=>row.path.endsWith('/cancel')));f.privateDataStayedPrivate();
});
for(const [name,options]of [
  ['expiry during endpoint import',{afterImport:({expire})=>expire()}],
  ['expiry during local model write',{onModelWrite:({expire})=>expire()}],
])await check(name+' revokes the imported session before publishing a connected receipt',async()=>{
  const f=await fixture(options);await f.start();await f.wake();
  assert.equal(f.requests.filter(row=>row.path.endsWith('/endpoint-import')).length,1);
  assert.equal(f.ram.loginSessionId,undefined);assert.equal(f.ram.loginAccountId,undefined);
  assert.equal(f.ram[outcome]?.status,'failed');assert.equal(f.ram[outcome]?.code,'login_auth_expired');
  assert(f.requests.some(row=>row.path.endsWith('/cancel')));f.privateDataStayedPrivate();
});
for(const [name,options]of [
  ['Gemini empty model catalogue',{models:[]}],
  ['DeepSeek empty model catalogue',{provider:'login_deepseek',models:[]}],
  ['duplicate model IDs',{models:[model('web-default'),model('web-default')]}],
  ['null model row',{models:[null]}],
  ['blank model ID',{models:[model('   ')]}],
  ['wrong session provider',{importTransform:data=>({...data,session:{...data.session,provider:'login_deepseek'}})}],
  ['malformed session account',{importTransform:data=>({...data,session:{...data.session,account_id:'not-an-account'}})}],
  ['malformed session ID',{importTransform:data=>({...data,session:{...data.session,id:'not-a-session'}})}],
  ['Claude authentication-only with invented model',{provider:'login_claude'}],
])await check(name+' cannot bind authority or change the stored model',async()=>{
  const f=await fixture({...options,selected:'previous-selection'});await f.start();await f.wake();
  assert.equal(f.requests.filter(row=>row.path.endsWith('/endpoint-import')).length,1);
  assert.equal(f.ram.loginSessionId,undefined);assert.equal(f.ram.loginAccountId,undefined);
  assert.equal(f.ram[outcome]?.status,'failed');assert.equal(f.ram[outcome]?.code,'login_endpoint_api_invalid');
  assert.equal(f.local.loginModel,'previous-selection','Invalid server metadata must not mutate selected model');
  assert(f.requests.some(row=>row.path.endsWith('/cancel')));f.privateDataStayedPrivate();
});
console.log(JSON.stringify({scope:'Actual endpoint worker → local/session storage → settings → job profile → request serializer; no popup, fictional capture/HTTP only',
  worker:baseline?'immutable uploaded .51 baseline':'working source',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
