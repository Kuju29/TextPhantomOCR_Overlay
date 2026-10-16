/** Executes the actual endpoint worker, including its startup/message/storage event chain. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const filename=new URL('../src/background/login/endpoint/login_endpoint_background.js',import.meta.url);
const source=await fs.readFile(process.argv[2] || filename,'utf8');
const pendingKey='loginPendingAuthV1',outcomeKey='loginOutcomeV1';
const tick=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
async function fixture({holdStartup=false,holdImport=false,captureReady=true}={}){
  const startup=deferred(),imported=deferred(),listeners={},timers=new Map(),writes=[],requests=[],captures=[];
  let first=true,nextTimer=0;
  const state={paidApiBase:'http://127.0.0.1:8000',paidSessionToken:'fiction-only-tp-owner',loginProvider:'login_gemini',loginModel:''};
  const signal=name=>({addListener:fn=>{listeners[name]=fn;}});
  const context=vm.createContext({URL,Uint8Array,Promise,Date,AbortSignal,console,crypto:webcrypto,
    setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),queueMicrotask,
    chrome:{runtime:{id:'fiction-extension',getURL:p=>'chrome-extension://fiction-extension/'+p,onMessage:signal('message')},
      tabs:{onUpdated:signal('updated'),onRemoved:signal('removed')},storage:{onChanged:signal('storage')},
      alarms:{onAlarm:signal('alarm'),create(){}}},
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});
      if(url.endsWith('/endpoint-import')){if(holdImport)await imported.promise;return {ok:true,json:async()=>({status:'connected',endpoint_validation:'identity_verified',session:{id:'lgs_'+'1'.repeat(48),provider:'login_gemini',account_id:'2'.repeat(32),transport:'web_endpoint'},models:[{id:'web-default',name:'Provider default',model_capabilities:{}}]})};}
      return {ok:true,json:async()=>({ok:true})};},
  });
  const exports={
    '../../../shared/login-session.js':{getLoginSession:async()=>({...state}),readLoginState:async()=>{if(first){first=false;if(holdStartup)return startup.promise;}return {...state};},writeLoginState:async patch=>{writes.push(structuredClone(patch));const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:state[key],newValue:value};state[key]=value;}listeners.storage?.(changes,'local');},setLoginSession:async patch=>{writes.push(structuredClone(patch));const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:state[key],newValue:value};state[key]=value;}listeners.storage?.(changes,'session');}},
    '../../../shared/login-auth.js':{LOGIN_PENDING_AUTH:pendingKey,LOGIN_OUTCOME:outcomeKey,loginAuthScope:async()=> 'a'.repeat(64)},
    '../../../shared/browser-api.js':{queryTabs:async()=>[],createTab:async()=>({id:8}),getTab:async()=>({id:8,url:'https://gemini.google.com/app',status:'complete'})},
    '../../api.js':{getApiBase:async()=>state.paidApiBase},
    '../../../shared/diagnostics.js':{recordDiagnostic(){}},
    '../../../shared/data-consent.js':{hasDataConsent:async()=>true,COOKIE_LOGIN_PROVIDERS:['login_gemini','login_deepseek']},
    '../../../shared/account-gate.js':{readAccountSession:async({read,keys=[]}={})=>{const v=await read(['paidSessionToken','paidApiBase','paidEmail',...keys]);const token=String(v.paidSessionToken||''),base=String(v.paidApiBase||'').replace(/\/+$/,''),values={...v};delete values.paidSessionToken;return token?{ok:true,consent:true,signedIn:true,token,base,values,signal:new AbortController().signal}:{ok:false,consent:true,signedIn:false,base,values};},withAccountSignal:signal=>signal,accountSignal:()=>new AbortController().signal}, // 10495: the account gate (this user allowed data use)
    './login_browser_relay.js':{RELAY_PROVIDERS:{login_claude:{}},acquireBrowserRelay:()=>()=>{}},
    './login_chatgpt_official.js':{OFFICIAL_REDIRECT:'http://127.0.0.1:1455/auth/callback',beginOfficialSignIn:async()=>{throw Error('ChatGPT not used');},readCallback:()=>({error:'unused'}),finishOfficialSignIn:async()=>{throw Error('ChatGPT not used');},officialAccount:async()=>'',officialAccessToken:async()=>null,forgetOfficial:async()=>{}},
    './login_chatgpt_web.js':{forgetWebchats:async()=>{}},
    '../login-ready-gate.js':{setAutoConnect(){}},
    '../login-tab-guard.js':{allowLoginTabs(){}},
    './login_endpoint_capture.js':{ENDPOINT_PROVIDERS:{login_gemini:{origin:'https://gemini.google.com',url:'https://gemini.google.com/app'}},captureEndpointLogin:async()=>{const result=captureReady?{expected_identity:'3'.repeat(64),credentials:{psid:'fiction-only-provider-cookie'}}:null;captures.push(result);return result;}},
  };
  const module=new vm.SourceTextModule(source,{context,identifier:filename.href});
  await module.link(async name=>{const values=exports[name];assert.ok(values,name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});});
  await module.evaluate();await tick();
  const flow={transport:'web_endpoint',provider:'login_gemini',flow_id:'lgf_'+'4'.repeat(48),state:'fiction-state',apiBase:state.paidApiBase,scope:'a'.repeat(64),url:'https://gemini.google.com/app',expiresAt:Date.now()+300000};
  async function open(){state[pendingKey]={...flow};let reply;const answer=new Promise(resolve=>reply=resolve);listeners.message({type:'TP_LOGIN_ENDPOINT_OPEN',flowId:flow.flow_id},{id:'fiction-extension',url:'chrome-extension://fiction-extension/popup/popup.html'},reply);await tick();assert.equal((await answer).ok,true);await tick();}
  return {module,state,flow,open,startup,imported,requests,writes,captures,listeners,timers,tick};
}

const checks=[];
{
  const f=await fixture({holdStartup:true});await f.open();
  assert.equal(f.requests.length,0);
  f.startup.resolve({});await tick();
  assert.equal(f.requests.filter(x=>x.url.endsWith('/endpoint-import')).length,1,'pending Sign-in event lost during background startup; must complete without popup reopen or 30-second alarm');
  assert.equal(f.state[outcomeKey]?.status,'connected');assert.equal(f.state[pendingKey],null);
  assert.equal(f.state.loginModel,'web-default','Background must supply the model before any popup opens');
  assert.equal(f.captures[0]?.credentials?.psid,undefined,'captured credentials retained after import');
  assert.ok(!JSON.stringify(f.writes).includes('fiction-only-provider-cookie'),'provider credential persisted');
  checks.push('startup race completes once with popup closed');
}
{
  const f=await fixture();await f.open();await tick();
  assert.equal(f.state[outcomeKey]?.status,'connected');assert.equal(f.requests.length,1);
  await f.module.namespace.wakeEndpointLogin();assert.equal(f.requests.length,1);
  checks.push('completion is automatic and terminal events never re-import');
}
{
  const f=await fixture({captureReady:false});await f.open();await tick();
  assert.equal(f.requests.length,0);assert.equal(f.state[pendingKey]?.flow_id,f.flow.flow_id);
  assert.equal(f.timers.size,1);checks.push('signed-out original provider waits without terminal failure');
}
{
  const f=await fixture({holdImport:true});await f.open();await tick();
  assert.equal(f.requests.length,1);f.state[pendingKey]=null;f.imported.resolve();await tick();
  assert.equal(f.state.loginSessionId,undefined);assert.ok(f.requests.some(x=>x.url.endsWith('/cancel')));
  checks.push('cancel during import revokes old flow without reviving session');
}
{
  const f=await fixture({holdImport:true});await f.open();await tick();
  f.state.paidSessionToken='fiction-only-new-owner';f.state[pendingKey]={...f.flow,flow_id:'lgf_'+'5'.repeat(48),scope:'b'.repeat(64)};
  f.imported.resolve();await tick();assert.equal(f.state.loginSessionId,undefined);
  assert.equal(f.state[pendingKey].flow_id,'lgf_'+'5'.repeat(48));
  assert.ok(f.requests.some(x=>x.url.endsWith('/cancel')&&x.body.flow_id===f.flow.flow_id));
  checks.push('replacement owner flow preserved while old import cancelled');
}
console.log(JSON.stringify({passed:true,checks:checks.length,details:checks}));
