/** .77 ChatGPT Login route choice in the actual endpoint worker (one button, the
 * worker decides): free plan -> chatgpt.com tab; paid plan -> Sign in with ChatGPT
 * (consent once, then reused for the same chatgpt.com account); refused consent ->
 * chatgpt.com tab. Synthetic browser events and API replies; no network or account. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const filename=new URL('../src/background/login/endpoint/login_endpoint_background.js',import.meta.url);
const source=await fs.readFile(filename,'utf8');
const pendingKey='loginPendingAuthV1',outcomeKey='loginOutcomeV1';
const SITE='c'.repeat(64),OFFICIAL='e'.repeat(64),REDIRECT='http://127.0.0.1:1455/auth/callback';
// WebCrypto digests finish on the thread pool: give each step real time, not only microtasks.
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setTimeout(resolve,2));};
const sha=async text=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');

async function fixture({plan='plus',token=null,callbackError='',consentTitle='Sign in with ChatGPT'}={}){
  const listeners={},timers=new Map(),requests=[],calls=[],diagnostics=[];let nextTimer=0;
  const state={paidApiBase:'http://127.0.0.1:8000',paidSessionToken:'fiction-only-tp-owner',loginProvider:'login_chatgpt',loginModel:''};
  let tab={id:8,url:'https://chatgpt.com/',status:'complete'};
  const signal=name=>({addListener:fn=>{const all=(listeners['_'+name] ||= []);all.push(fn);listeners[name]=(...args)=>{for(const each of all)each(...args);};}});
  const context=vm.createContext({URL,Uint8Array,Promise,Date,AbortSignal,console,TextEncoder,crypto:webcrypto,
    setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),queueMicrotask,
    chrome:{runtime:{id:'fiction-extension',getURL:p=>'chrome-extension://fiction-extension/'+p,onMessage:signal('message'),lastError:undefined},
      tabs:{onUpdated:signal('updated'),onRemoved:signal('removed'),
        update:(id,props,done)=>{calls.push(['tabs.update',id,props.url]);tab={...tab,url:props.url};done?.();},
        remove:(id,done)=>{calls.push(['tabs.remove',id]);done?.();}},
      webNavigation:{onBeforeNavigate:{addListener:(fn,filter)=>{listeners.navigate=fn;listeners.navigateFilter=filter;}}},
      scripting:{executeScript:async()=>[{result:consentTitle}]},
      storage:{onChanged:signal('storage')},alarms:{onAlarm:signal('alarm'),create(){}}},
    fetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push({url,body});
      if(url.endsWith('/endpoint-import')){const mode=body.credentials.mode;
        return {ok:true,json:async()=>({status:'connected',endpoint_validation:'identity_verified',
          session:{id:'lgs_'+'1'.repeat(48),provider:'login_chatgpt',account_id:'2'.repeat(32),transport:'web_endpoint'},
          models:[{id:mode === 'official'?'gpt-fixture':'web-current',name:'fixture',model_capabilities:{}}]})};}
      return {ok:true,json:async()=>({ok:true})};},
  });
  const store=patch=>{const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:state[key],newValue:value};state[key]=value;}return changes;};
  const exports={
    '../../../shared/login-session.js':{getLoginSession:async()=>({...state}),readLoginState:async()=>({...state}),
      writeLoginState:async patch=>{listeners.storage?.(store(patch),'local');},setLoginSession:async patch=>{listeners.storage?.(store(patch),'session');}},
    '../../../shared/login-auth.js':{LOGIN_PENDING_AUTH:pendingKey,LOGIN_OUTCOME:outcomeKey,loginAuthScope:async()=>'a'.repeat(64)},
    '../../../shared/browser-api.js':{createTab:async()=>({id:8}),getTab:async()=>({...tab}),queryTabs:async()=>[]},
    '../../api.js':{getApiBase:async()=>state.paidApiBase},
    '../../../shared/diagnostics.js':{recordDiagnostic:(name,data)=>diagnostics.push([name,data])},
    '../../../shared/data-consent.js':{hasDataConsent:async()=>true,COOKIE_LOGIN_PROVIDERS:['login_gemini','login_deepseek']},
    '../../../shared/account-gate.js':{readAccountSession:async({read,keys=[]}={})=>{const v=await read(['paidSessionToken','paidApiBase','paidEmail',...keys]);const token=String(v.paidSessionToken||''),base=String(v.paidApiBase||'').replace(/\/+$/,''),values={...v};delete values.paidSessionToken;return token?{ok:true,consent:true,signedIn:true,token,base,values,signal:new AbortController().signal}:{ok:false,consent:true,signedIn:false,base,values};},withAccountSignal:signal=>signal,accountSignal:()=>new AbortController().signal}, // 10495: the account gate (this user allowed data use)
    './login_browser_relay.js':{RELAY_PROVIDERS:{login_claude:{},login_chatgpt:{}},acquireBrowserRelay:()=>{calls.push(['relay']);return ()=>{};}},
    './login_chatgpt_official.js':{OFFICIAL_REDIRECT:REDIRECT,
      beginOfficialSignIn:async tabId=>{calls.push(['consent',tabId]);tab={...tab,url:'https://auth.openai.com/api/accounts/authorize?client_id=x',status:'complete'};
        return {verifier:'V'.repeat(43),state:'S'.repeat(32),nonce:'N'.repeat(32),startedAt:Date.now()};},
      readCallback:(url,pending)=>{const p=new URL(url).searchParams;if(p.get('state') !== pending.state)return {error:'official_callback_invalid'};
        if(p.get('error'))return {error:p.get('error') === 'access_denied'?'official_denied':'official_unavailable'};return {code:p.get('code'),clientId:'app_x'};},
      finishOfficialSignIn:async(callback,pending)=>{calls.push(['finish',callback.code,pending.websiteAccount]);return {account:OFFICIAL};},
      officialAccount:async site=>token && token.site === site?token.account:'',officialAccessToken:async()=>token?'fiction-local-token':null,
      forgetOfficial:async()=>{calls.push(['forgetOfficial']);}},
    './login_chatgpt_web.js':{forgetWebchats:async()=>{calls.push(['forgetWebchats']);}},
    '../login-ready-gate.js':{setAutoConnect(){}},
    '../login-tab-guard.js':{allowLoginTabs(){}},
    './login_endpoint_capture.js':{ENDPOINT_PROVIDERS:{login_chatgpt:{origin:'https://chatgpt.com',url:'https://chatgpt.com/'}},
      captureEndpointLogin:async()=>({ok:true,account:SITE,plan})},
  };
  const module=new vm.SourceTextModule(source,{context,identifier:filename.href});
  await module.link(async name=>{const values=exports[name];assert.ok(values,name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);},{context});});
  await module.evaluate();await tick();
  const flow={transport:'web_endpoint',provider:'login_chatgpt',flow_id:'lgf_'+'4'.repeat(48),state:'fiction-state',apiBase:state.paidApiBase,scope:'a'.repeat(64),url:'https://chatgpt.com/',expiresAt:Date.now()+300000};
  async function open(){state[pendingKey]={...flow};let reply;const answer=new Promise(resolve=>reply=resolve);
    listeners.message({type:'TP_LOGIN_ENDPOINT_OPEN',flowId:flow.flow_id},{id:'fiction-extension',url:'chrome-extension://fiction-extension/popup/popup.html'},reply);
    await tick();assert.equal((await answer).ok,true);await tick();}
  async function runTimers(){const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await tick();}
  async function redirect(query){listeners.navigate({tabId:8,frameId:0,url:REDIRECT+'?'+query});await tick();listeners.removed(8);await tick();}
  const imports=()=>requests.filter(x=>x.url.endsWith('/endpoint-import'));
  return {state,open,runTimers,redirect,imports,calls,requests,diagnostics,listeners,module};
}

const checks=[],failures=[];
async function check(name,fn){try{await fn();checks.push(name);console.log('PASS',name);}catch(error){failures.push({name,error:String(error?.stack || error)});console.log('FAIL',name,'\n',error);}}

await check('free plan connects through the chatgpt.com tab without a consent page',async()=>{
  const f=await fixture({plan:'free'});await f.open();
  assert.equal(f.calls.some(c=>c[0] === 'consent'),false);
  const [request]=f.imports();assert.ok(request,'import sent');
  assert.deepEqual(request.body.credentials,{mode:'website',account:SITE,plan:'free'});
  assert.equal(request.body.expected_identity,await sha('chatgpt-website\0'+SITE));
  assert.ok(f.calls.some(c=>c[0] === 'relay'),'relay pump held during import');
  assert.equal(f.state[outcomeKey].status,'connected');assert.equal(f.state[outcomeKey].chatgpt_mode,'website');
  assert.equal(f.state[outcomeKey].chatgpt_reason,'plan_free');assert.equal(f.state.loginModel,'web-current');
});

await check('paid plan starts Sign in with ChatGPT once, then the redirect finishes it',async()=>{
  const f=await fixture({plan:'plus'});await f.open();
  assert.deepEqual(f.calls.filter(c=>c[0] === 'consent'),[['consent',8]]);
  assert.equal(f.imports().length,0);assert.equal(f.state[outcomeKey].stage,'chatgpt_official_consent');
  assert.equal(f.state[pendingKey].official.websiteAccount,SITE);
  await f.runTimers();assert.equal(f.imports().length,0,'still waiting on the consent page');
  assert.deepEqual(JSON.parse(JSON.stringify(f.listeners.navigateFilter)),{url:[{schemes:['http'],hostEquals:'127.0.0.1',ports:[1455]}]});
  await f.redirect('code=abcdefgh123&state='+'S'.repeat(32));
  assert.ok(f.calls.some(c=>c[0] === 'tabs.remove' && c[1] === 8),'consent tab closed by TextPhantom');
  await f.runTimers();
  assert.deepEqual(f.calls.find(c=>c[0] === 'finish'),['finish','abcdefgh123',SITE]);
  const [request]=f.imports();
  assert.deepEqual(request.body.credentials,{mode:'official',account:OFFICIAL,plan:'plus'});
  assert.equal(request.body.expected_identity,await sha('chatgpt-official\0'+OFFICIAL));
  assert.ok(!JSON.stringify(f.requests).includes('fiction-local-token') && !JSON.stringify(f.requests).includes('abcdefgh123'),'no token or code reaches the API');
  assert.equal(f.state[outcomeKey].status,'connected',JSON.stringify(f.state[outcomeKey]));
  assert.equal(f.state[outcomeKey].chatgpt_mode,'official');assert.equal(f.state.loginModel,'gpt-fixture');
});

await check('paid plan with a kept token for the same account skips consent',async()=>{
  const f=await fixture({plan:'pro',token:{site:SITE,account:OFFICIAL}});await f.open();
  assert.equal(f.calls.some(c=>c[0] === 'consent'),false);
  assert.deepEqual(f.imports()[0].body.credentials,{mode:'official',account:OFFICIAL,plan:'pro'});
});

await check('a token granted for another chatgpt.com account is not reused',async()=>{
  const f=await fixture({plan:'pro',token:{site:'d'.repeat(64),account:OFFICIAL}});await f.open();
  assert.equal(f.calls.filter(c=>c[0] === 'consent').length,1);assert.equal(f.imports().length,0);
});

await check('denied consent falls back to the chatgpt.com tab',async()=>{
  const f=await fixture({plan:'plus'});await f.open();
  await f.redirect('error=access_denied&state='+'S'.repeat(32));await f.runTimers();
  assert.deepEqual(f.imports()[0].body.credentials,{mode:'website',account:SITE,plan:'plus'});
  assert.equal(f.state[outcomeKey].chatgpt_reason,'official_denied');
  assert.ok(f.diagnostics.some(([name,data])=>name === 'login.chatgpt.website_fallback' && data.reason === 'official_denied'));
});

await check('"This account can\'t access this app" falls back to the chatgpt.com tab',async()=>{
  const f=await fixture({plan:'plus',consentTitle:'This account can’t access this app'});await f.open();
  await f.runTimers();
  assert.deepEqual(f.imports()[0].body.credentials,{mode:'website',account:SITE,plan:'plus'});
  assert.ok(f.calls.some(c=>c[0] === 'tabs.update' && c[2] === 'https://chatgpt.com/'),'consent page left');
  assert.equal(f.state[outcomeKey].chatgpt_reason,'official_unavailable');
});

await check('a redirect with another state fails without importing',async()=>{
  const f=await fixture({plan:'plus'});await f.open();
  await f.redirect('code=abcdefgh123&state=forged');await f.runTimers();
  assert.equal(f.imports().length,0);
  assert.equal(f.state[outcomeKey].status,'failed');assert.equal(f.state[outcomeKey].code,'login_chatgpt_official_callback_invalid');
});

await check('closing the consent tab by hand still cancels the sign-in',async()=>{
  const f=await fixture({plan:'plus'});await f.open();
  f.listeners.removed(8);await new Promise(resolve=>setTimeout(resolve,20));await tick();
  assert.equal(f.imports().length,0);assert.equal(f.state[outcomeKey].status,'failed');assert.equal(f.state[outcomeKey].code,'login_tab_closed');
});

await check('Disconnect clears ChatGPT tokens and tabs only for the popup',async()=>{
  const f=await fixture();let reply;
  f.listeners.message({type:'TP_LOGIN_CHATGPT_FORGET'},{id:'fiction-extension',url:'https://chatgpt.com/'},value=>{reply=value;});await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(reply)),{ok:false});assert.equal(f.calls.some(c=>c[0] === 'forgetOfficial'),false);
  f.listeners.message({type:'TP_LOGIN_CHATGPT_FORGET'},{id:'fiction-extension',url:'chrome-extension://fiction-extension/popup/popup.html'},value=>{reply=value;});await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(reply)),{ok:true});
  assert.ok(f.calls.some(c=>c[0] === 'forgetOfficial') && f.calls.some(c=>c[0] === 'forgetWebchats'));
});

console.log(JSON.stringify({passed:failures.length === 0,count:checks.length,failures},null,1));
if(failures.length)process.exit(1);
