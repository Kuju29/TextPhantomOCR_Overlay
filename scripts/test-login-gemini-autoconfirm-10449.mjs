/** Real worker + serialized Login-only Gemini capture; no popup or provider calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const base=new URL('../src/background/login/endpoint/',import.meta.url);
const workerSource=await fs.readFile(new URL('login_endpoint_background.js',base),'utf8');
const captureSource=await fs.readFile(new URL('login_endpoint_capture.js',base),'utf8');
const pending='loginPendingAuthV1',outcome='loginOutcomeV1';
const tick=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
async function fixture({navigateDuringCapture=false,signedIn=true,cookiePermission=true,importChallenge=false,replaceDuringCapture=false,expireDuringCapture=false}={}){
  let clock=Date.now(),url='https://gemini.google.com/app',documentId='original',navigationLeft=navigateDuringCapture?1:0;
  const listeners={},timers=new Map(),writes=[],requests=[];let nextTimer=0,captureReads=0;
  const signal=name=>({addListener:fn=>{listeners[name]=fn;}});
  const state={paidApiBase:'http://127.0.0.1:8000',paidSessionToken:'fiction-owner',loginProvider:'login_gemini',loginModel:''};
  const spec={flow_id:'lgf_'+'4'.repeat(48),provider:'login_gemini',transport:'web_endpoint',state:'fiction-state',
    scope:'a'.repeat(64),apiBase:state.paidApiBase,url,tabId:8,browserInstance:'b'.repeat(48),expiresAt:clock+60000};
  const getTab=async()=>({id:8,url,status:'complete'});
  const chrome={runtime:{id:'fiction-extension',getURL:p=>'chrome-extension://fiction-extension/'+p,onMessage:signal('message')},
    tabs:{onUpdated:signal('updated'),onRemoved:signal('removed')},storage:{onChanged:signal('storage')},
    alarms:{onAlarm:signal('alarm'),create(){}},
    permissions:{contains:(_x,done)=>done(cookiePermission)},
    cookies:{getAllCookieStores:done=>done([{id:'1',tabIds:[8]}]),getAll:(q,done)=>done(q.name==='__Secure-1PSID'?[{name:q.name,value:'fiction-provider-cookie',domain:'.google.com',secure:true,storeId:'1'}]:[])},
    webNavigation:{getFrame:(_q,done)=>done({documentId,url})},
    scripting:{executeScript:async(options,done)=>{
      captureReads++;
      const location=new URL(url),window={};window.top=window;
      const realm=vm.createContext({location,window,URL,AbortSignal,TextEncoder,crypto:webcrypto,
        fetch:async()=>({ok:true,text:async()=>signedIn?'"oPEP7c":"fiction@example.test"':'signed out'})});
      realm.args=options.args;
      const result=await vm.runInContext('('+options.func.toString()+')(...args)',realm);
      const capturedDocument=documentId;
      if(navigationLeft-- > 0){url='https://gemini.google.com/app?hl=th';documentId='after-login-navigation';}
      if(replaceDuringCapture)state[pending]={...state[pending],provider:'login_deepseek',browserInstance:'c'.repeat(48)};
      if(expireDuringCapture)clock=spec.expiresAt+1;
      done([{frameId:0,documentId:capturedDocument,result}]);
    }},
  };
  const context=vm.createContext({URL,Uint8Array,Promise,AbortSignal,TextEncoder,console,crypto:webcrypto,chrome,
    Date:class extends Date{static now(){return clock;}},queueMicrotask,
    setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    fetch:async(address,options)=>{
      requests.push({path:new URL(address).pathname,body:JSON.parse(options.body)});
      if(address.endsWith('/endpoint-import'))return importChallenge?
        {ok:false,status:403,json:async()=>({error:{code:'login_endpoint_challenge_required',stage:'endpoint_validation'}})}:
        {ok:true,json:async()=>({status:'connected',endpoint_validation:'identity_verified',session:{id:'lgs_'+'1'.repeat(48),provider:'login_gemini',account_id:'2'.repeat(32),transport:'web_endpoint'},models:[{id:'web-default',name:'Provider default',model_capabilities:{}}]})};
      return {ok:true,json:async()=>({ok:true})};
    }});
  const imports={
    '../../../shared/login-session.js':{getLoginSession:async()=>structuredClone(state),readLoginState:async()=>structuredClone(state),writeLoginState:async patch=>{writes.push(structuredClone(patch));const changes={};for(const [key,value]of Object.entries(patch)){changes[key]={oldValue:state[key],newValue:value};state[key]=value;}listeners.storage?.(changes,'local');},setLoginSession:async patch=>{writes.push(structuredClone(patch));const changes={};for(const [key,value]of Object.entries(patch)){changes[key]={oldValue:state[key],newValue:value};state[key]=value;}listeners.storage?.(changes,'session');}},
    '../../../shared/login-auth.js':{LOGIN_PENDING_AUTH:pending,LOGIN_OUTCOME:outcome,loginAuthScope:async()=> 'a'.repeat(64)},
    '../../../shared/browser-api.js':{getTab,createTab:async()=>({id:8}),queryTabs:async()=>[]},
    '../../api.js':{getApiBase:async()=>state.paidApiBase},
    '../../../shared/diagnostics.js':{recordDiagnostic(){}},
    './login_browser_relay.js':{RELAY_PROVIDERS:{login_claude:{}},acquireBrowserRelay:()=>()=>{}},
    './login_chatgpt_official.js':{OFFICIAL_REDIRECT:'http://127.0.0.1:1455/auth/callback',beginOfficialSignIn:async()=>{throw Error('ChatGPT not used');},readCallback:()=>({error:'unused'}),finishOfficialSignIn:async()=>{throw Error('ChatGPT not used');},officialAccount:async()=>'',officialAccessToken:async()=>null,forgetOfficial:async()=>{}},
    './login_chatgpt_web.js':{forgetWebchats:async()=>{}},
    '../login-ready-gate.js':{setAutoConnect(){}},
    '../login-tab-guard.js':{allowLoginTabs(){}},
  };
  const synthetic=(name)=>{const values=imports[name];assert(values,name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);},{context});};
  const capture=new vm.SourceTextModule(captureSource,{context,identifier:new URL('login_endpoint_capture.js',base).href});
  await capture.link(async name=>synthetic(name));await capture.evaluate();
  const worker=new vm.SourceTextModule(workerSource,{context,identifier:new URL('login_endpoint_background.js',base).href});
  await worker.link(async name=>name==='./login_endpoint_capture.js'?capture:synthetic(name));await worker.evaluate();await tick();
  async function settled(){for(let i=0;i<100;i++){await tick();if(timers.size||state[pending]===null||state[pending]?.provider!==spec.provider||['connected','failed'].includes(state[outcome]?.status))return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('Bounded synthetic Login lifecycle did not settle');}
  async function start(){state[pending]={...spec};listeners.storage({[pending]:{newValue:state[pending]}},'session');await settled();}
  async function timer(){const item=timers.entries().next().value;assert(item,'Original Login flow must remain pending with a timer');timers.delete(item[0]);clock+=1500;item[1]();await settled();}
  return {state,spec,writes,requests,timers,listeners,start,timer,setSignedIn:value=>signedIn=value,expire:()=>clock=spec.expiresAt+1,captureReads:()=>captureReads};
}
const checks=[],failures=[];
async function check(name,fn){try{await fn();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
await check('Gemini document transition during normal Login retries original flow and auto-confirms without popup reopen',async()=>{
  const f=await fixture({navigateDuringCapture:true});await f.start();
  assert.equal(f.state[pending]?.flow_id,f.spec.flow_id,'Benign original-tab document transition must not cancel the Login');
  assert.equal(f.requests.length,0,'No import or cancel before fresh document capture');await f.timer();
  assert.equal(f.state[outcome]?.status,'connected');assert.equal(f.state[pending],null);
  assert.equal(f.state.loginModel,'web-default','Connected must also be ready for a page action without popup');
  assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,1);
  assert.equal(f.captureReads(),2);assert(!JSON.stringify(f.writes).includes('fiction-provider-cookie'));
});
await check('Signed-out Gemini retries after sign-in using only background timer',async()=>{
  const f=await fixture({signedIn:false});await f.start();assert.equal(f.requests.length,0);f.setSignedIn(true);await f.timer();assert.equal(f.state[outcome]?.status,'connected');
});
await check('Cancelled original flow cannot be revived by its navigation retry',async()=>{
  const f=await fixture({navigateDuringCapture:true});await f.start();f.state[pending]=null;
  if(f.timers.size)await f.timer();assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,0);assert.equal(f.state.loginSessionId,undefined);
});
await check('Expired navigation retry revokes the original flow without importing',async()=>{
  const f=await fixture({navigateDuringCapture:true});await f.start();f.expire();await f.timer();
  assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,0);assert.equal(f.state[outcome]?.code,'login_auth_expired');
});
await check('Provider or browser-instance replacement during capture cannot import stale Gemini credentials',async()=>{
  const f=await fixture({replaceDuringCapture:true});await f.start();await tick();
  assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,0);
  assert.equal(f.state[pending]?.provider,'login_deepseek');assert.equal(f.state.loginSessionId,undefined);
});
await check('Flow expiration while capturing cannot send an endpoint import',async()=>{
  const f=await fixture({expireDuringCapture:true});await f.start();
  assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,0);assert.equal(f.state[outcome]?.code,'login_auth_expired');
});
await check('Missing cookie permission stays terminal; no verification bypass',async()=>{
  const f=await fixture({cookiePermission:false});await f.start();assert.equal(f.state[outcome]?.code,'login_cookie_permission_required');assert.equal(f.timers.size,0);
});
await check('Provider verification rejection is terminal and never automatically retransmitted',async()=>{
  const f=await fixture({importChallenge:true});await f.start();assert.equal(f.state[outcome]?.code,'login_endpoint_challenge_required');assert.equal(f.timers.size,0);
  f.listeners.updated(8,{});await tick();assert.equal(f.requests.filter(x=>x.path.endsWith('/endpoint-import')).length,1);
});
console.log(JSON.stringify({scope:'Actual worker + serialized Gemini login capture against synthetic browser events; no popup, real provider, credentials or generation',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
