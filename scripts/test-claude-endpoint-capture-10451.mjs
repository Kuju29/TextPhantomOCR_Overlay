/** Actual serialized Claude Login capture and normal worker handoff; synthetic browser only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source=await fs.readFile(new URL('../src/background/login/endpoint/login_endpoint_capture.js',import.meta.url),'utf8');
const backgroundSource=await fs.readFile(new URL('../src/background/login/endpoint/login_endpoint_background.js',import.meta.url),'utf8');
const account='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',organization='11111111-2222-4333-8444-555555555555';
const cookieValue='fiction-only-Claude-session-cookie';
const hash=async text=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('hex');
const tick=async()=>{for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));};

async function fixture(options={}){
  const requests=[],scripts=[],cookieRequests=[];
  const state={tab:{id:7,url:'https://claude.ai/new',status:'complete'},documentId:'original-document'};
  const window={};window.top=options.subframe?{}:window;
  const page=vm.createContext({window,URL,AbortSignal,TextEncoder,crypto:webcrypto,
    location:{origin:options.origin || 'https://claude.ai',pathname:'/new'},
    fetch:async(address,init)=>{
      requests.push({address,init});assert.equal(address,'/api/bootstrap');
      assert.equal(init.credentials,'include');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');
      if(options.fetchFailure)throw new Error(cookieValue);
      return {ok:options.status?false:true,status:options.status||200,json:async()=>{
        if(options.navigationDuringJson)page.location.origin='https://foreign.invalid';
        return options.bootstrap??{account:{uuid:account,lastActiveOrgId:organization},
          organizations:[{uuid:'not-selected-first-org'},{uuid:organization}]};
      }};
    }});
  const chrome={runtime:{lastError:null},permissions:{contains:(_query,done)=>done(options.permission!==false)},
    scripting:{executeScript:async(args,done)=>{
      scripts.push(args);assert.equal(args.world,'ISOLATED');assert.equal(JSON.stringify(args.target.frameIds),'[0]');
      const serialized=new vm.Script('('+args.func.toString()+')').runInContext(page);
      const result=await serialized(...args.args);
      if(options.tabChanged)state.tab.url='https://claude.ai/chat/another';
      if(options.documentChanged)state.documentId='replacement-document';
      done([{frameId:0,documentId:'original-document',result}]);
    }},
    cookies:{getAllCookieStores:done=>done([{id:'owned-store',tabIds:[7]}]),getAll:(query,done)=>{
      cookieRequests.push(query);assert.equal(query.name,'sessionKey');assert.equal(query.url,'https://claude.ai/');assert.equal(query.storeId,'owned-store');
      const rows=[{name:query.name,value:cookieValue,domain:'.claude.ai',secure:true,storeId:'owned-store'}];
      if(options.ambiguousCookie)rows.push({...rows[0],value:'fiction-other-cookie'});
      done(options.missingCookie?[]:rows);
    }},webNavigation:{getFrame:(_query,done)=>done({documentId:state.documentId,url:state.tab.url})}};
  const context=vm.createContext({chrome,URL});
  const helper=new vm.SyntheticModule(['getTab'],function(){this.setExport('getTab',async()=>({...state.tab}));},{context});
  const module=new vm.SourceTextModule(source,{context});await module.link(()=>helper);await module.evaluate();
  return {state,requests,scripts,cookieRequests,capture:module.namespace};
}

const checks=[],failures=[];
async function check(name,run){try{await run();checks.push(name);}catch(error){failures.push({name,error:error.message});}}

await check('normal Claude captures account plus selected second organization, never the first organization',async()=>{
  const f=await fixture(),value=await f.capture.captureEndpointLogin(7,'login_claude');
  assert.equal(value.expected_identity,await hash(account+'\0'+organization));
  // .75: the claude.ai session stays in the browser tab (browser relay); no cookie is read.
  assert.equal(JSON.stringify(value.credentials),JSON.stringify({organization}));
  assert.equal(f.requests.length,1);assert.equal(f.cookieRequests.length,0);assert.equal(f.scripts[0].world,'ISOLATED');
});
await check('missing or malformed selected organization is typed before any provider cookie read',async()=>{
  for(const selected of [undefined,null,'',1,{},'ก','x'.repeat(161),'org;foreign','org\nforeign']){
    const f=await fixture({bootstrap:{account:{uuid:account,lastActiveOrgId:selected},organizations:[{uuid:'first-org'}]}});
    await assert.rejects(f.capture.captureEndpointLogin(7,'login_claude'),error=>error.code==='login_organization_required');
    assert.equal(f.cookieRequests.length,0);
  }
});
await check('bounded selected organization is preserved exactly and account is part of canonical ownership',async()=>{
  const selected='org_'+'a'.repeat(156);
  const f=await fixture({bootstrap:{account:{uuid:account,lastActiveOrgId:selected}}});
  const value=await f.capture.captureEndpointLogin(7,'login_claude');
  assert.equal(value.credentials.organization,selected);assert.equal(value.expected_identity,await hash(account+'\0'+selected));
  assert.notEqual(value.expected_identity,await hash(account));
});
await check('missing account, signed-out response and network failure do not create a captured session',async()=>{
  for(const bootstrap of [{}, {account:{}}, {account:{uuid:null,lastActiveOrgId:organization}},
      {account:{uuid:{id:account},lastActiveOrgId:organization}}, {account:{uuid:'user\nforeign',lastActiveOrgId:organization}}]){
    const f=await fixture({bootstrap});
    const value=await f.capture.captureEndpointLogin(7,'login_claude');assert.equal(value,null);assert.equal(f.cookieRequests.length,0);
  }
  const signedOut=await fixture({status:401});assert.equal(await signedOut.capture.captureEndpointLogin(7,'login_claude'),null);
  const failed=await fixture({fetchFailure:true});await assert.rejects(failed.capture.captureEndpointLogin(7,'login_claude'),error=>error.code==='login_capture_unavailable'&&!error.message.includes(cookieValue));
});
await check('original tab/document/top-frame remain required',async()=>{
  for(const options of [{tabChanged:true},{documentChanged:true},{navigationDuringJson:true},{origin:'https://foreign.invalid'},{subframe:true}]){
    const f=await fixture(options);await assert.rejects(f.capture.captureEndpointLogin(7,'login_claude'),error=>/^login_[a-z_]+$/.test(error.code));
  }
});
await check('.75 Claude capture needs no cookie permission and never reads a cookie',async()=>{
  for(const options of [{permission:false},{ambiguousCookie:true},{missingCookie:true}]){
    const f=await fixture(options),value=await f.capture.captureEndpointLogin(7,'login_claude');
    assert.equal(JSON.stringify(value.credentials),JSON.stringify({organization}));assert.equal(f.cookieRequests.length,0);
  }
});

async function backgroundFlow(changeOwner=false){
  const f=await fixture(),base='https://api.fixture.invalid',owner='fiction-tp-owner',scope=base+'|'+owner;
  const pendingKey='pending',outcomeKey='outcome',posts=[],writes=[],relay=[];let captured;
  const values={paidApiBase:base,paidSessionToken:owner,loginProvider:'login_claude',loginModel:'',[pendingKey]:{transport:'web_endpoint',provider:'login_claude',
    flow_id:'lgf_'+'a'.repeat(48),apiBase:base,scope,state:'b'.repeat(64),browserInstance:'c'.repeat(48),tabId:7,expiresAt:Date.now()+300000}};
  const event=()=>({addListener(){}});
  const context=vm.createContext({URL,Date,AbortSignal,setTimeout,clearTimeout,crypto:webcrypto,
    chrome:{runtime:{onMessage:event()},tabs:{onUpdated:event(),onRemoved:event()},storage:{onChanged:event()},alarms:{onAlarm:event(),create(){}}},
    fetch:async(address,init)=>{
      assert.equal(address,base+'/login/providers/login_claude/auth/endpoint-import');
      const body=JSON.parse(init.body);posts.push(body);assert.equal(body.credentials.organization,organization);
      assert.equal(body.expected_identity,await hash(account+'\0'+organization));
      return {ok:true,json:async()=>({status:'connected',session:{id:'lgs_'+'d'.repeat(48),provider:'login_claude',account_id:'e'.repeat(32),transport:'web_endpoint'},endpoint_validation:'identity_verified',models:[{id:'claude-fixture',name:'claude-fixture',model_capabilities:{}}]})};
    }});
  const virtual=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
  const imports={
    '../../../shared/login-session.js':virtual({getLoginSession:async()=>({...values}),readLoginState:async()=>({...values}),writeLoginState:async patch=>{writes.push(patch);Object.assign(values,patch);},setLoginSession:async patch=>{assert(!JSON.stringify(patch).includes(cookieValue),'Provider credential must not enter extension storage');writes.push(patch);Object.assign(values,patch);}}),
    '../../../shared/login-auth.js':virtual({LOGIN_PENDING_AUTH:pendingKey,LOGIN_OUTCOME:outcomeKey,loginAuthScope:async(api,user)=>api+'|'+user}),
    '../../../shared/browser-api.js':virtual({queryTabs:async()=>[],getTab:async()=>({...f.state.tab}),createTab:async()=>{throw Error('Original Login tab required');}}),
    '../../api.js':virtual({getApiBase:async()=>base}),
    '../../../shared/diagnostics.js':virtual({recordDiagnostic:(...args)=>assert(!JSON.stringify(args).includes(cookieValue))}),
    './login_browser_relay.js':virtual({RELAY_PROVIDERS:{login_claude:{}},acquireBrowserRelay:(api,token)=>{relay.push(['acquire',api,token]);return ()=>relay.push(['release']);}}),
    './login_chatgpt_official.js':virtual({OFFICIAL_REDIRECT:'http://127.0.0.1:1455/auth/callback',beginOfficialSignIn:async()=>{throw Error('ChatGPT not used');},readCallback:()=>({error:'unused'}),finishOfficialSignIn:async()=>{throw Error('ChatGPT not used');},officialAccount:async()=>'',officialAccessToken:async()=>null,forgetOfficial:async()=>{}}),
    './login_chatgpt_web.js':virtual({forgetWebchats:async()=>{}}),
    '../login-ready-gate.js':virtual({setAutoConnect(){}}),
    '../login-tab-guard.js':virtual({allowLoginTabs(){}}),
    './login_endpoint_capture.js':virtual({ENDPOINT_PROVIDERS:f.capture.ENDPOINT_PROVIDERS,captureEndpointLogin:async(...args)=>{captured=await f.capture.captureEndpointLogin(...args);if(changeOwner)values.paidSessionToken='different-owner';return captured;}}),
  };
  const module=new vm.SourceTextModule(backgroundSource,{context});await module.link(name=>{assert(imports[name],name);return imports[name];});await module.evaluate();
  const settled=()=>captured?.credentials&&Object.keys(captured.credentials).length===0;
  for(let n=0;n<1000&&!settled();n++)await new Promise(resolve=>setTimeout(resolve,1));
  assert(captured?.credentials,'Capture must complete');assert.equal(Object.keys(captured.credentials).length,0,'Trusted worker must release provider secrets after import');
  return {values,posts,writes,relay};
}
await check('normal worker handoff binds exact Claude organization and persists only opaque completion',async()=>{
  const f=await backgroundFlow();assert.equal(f.posts.length,1);assert.equal(JSON.stringify(f.posts[0].credentials),JSON.stringify({organization}));
  // The relay pump runs exactly while the API verifies through the claude.ai tab.
  assert.equal(JSON.stringify(f.relay),JSON.stringify([['acquire','https://api.fixture.invalid','fiction-tp-owner'],['release']]));
  assert.equal(f.values.loginSessionId,'lgs_'+'d'.repeat(48));assert.equal(f.values.outcome.generation_validation,'not_tested');
});
await check('TextPhantom owner change while capturing prevents old Claude import or stored session',async()=>{
  const f=await backgroundFlow(true);assert.equal(f.posts.length,0);assert.equal(f.values.loginSessionId,undefined);
});

console.log(JSON.stringify({scope:'Actual serialized Claude capture + trusted endpoint worker; synthetic fixed first-party bootstrap/cookie, no live account/provider calls',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
