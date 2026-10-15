/** Production controller regression tests. Fake timers/network; no real OTP. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createPaidServiceController} from '../src/popup/controllers/paid-service-controller.js';
import {createApiHealthController} from '../src/popup/controllers/api-health-controller.js';
const checks=[];
const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const settle=async()=>{for(let n=0;n<12;n++)await new Promise(r=>setImmediate(r));};
function clock(){let time=1000000,id=0;const timers=new Map();return{now:()=>time,setTimeoutFn:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:time+ms});return key;},clearTimeoutFn:key=>timers.delete(key),tick:async ms=>{time+=ms;for(const [key,t]of[...timers])if(t.at<=time){timers.delete(key);t.fn();}await settle();},timers};}
const el=(value='')=>({value,textContent:'',style:{display:''},disabled:false,handlers:{},attrs:{},addEventListener(n,fn){this.handlers[n]=fn;},setAttribute(k,v){this.attrs[k]=v;},replaceChildren(...children){this.children=children;},focus(){this.focused=true;}});
const elNames=['mode','sources','lang','apiUrl','aiService','aiServiceWrap','aiPaidPanel','aiPaidUnavailable','aiPaidConnectionMessage','aiPaidTitle','aiPaidSubtitle','aiPaidLogin','aiPaidAccount','aiPaidEmailStep','aiPaidCodeStep','aiPaidEmail','aiPaidCode','aiPaidCodeEmail','aiPaidSend','aiPaidCheck','aiPaidVerify','aiPaidResend','aiPaidChangeEmail','aiPaidEmailLabel','aiPaidCredits','aiPaidHeld','aiPaidAccountState','aiPaidModel','aiPaidRefresh','aiPaidLogout','aiPaidStatus','aiProviderWrap','aiKeyWrap','aiModelWrap','aiEndpointWrap','aiPageImageWrap'];
globalThis.document={createElement:()=>el(),visibilityState:'visible'};
const account={email:'customer@example.com',credits:{available:'10000',held:'20'},models:[{id:'demo/model',name:'Demo model',eligible_tp:'10000'}],paid_paused:false};
const make=(storage={},options={})=>{
 const time=clock(),els=Object.fromEntries(elNames.map(n=>[n,el()]));els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value='http://localhost:7860';els.aiPaidEmail.value='customer@example.com';
 const state={lastApiOk:true,lastSavedApiUrl:els.apiUrl.value,healthSeq:0};let controller;
 const requests=[];let behavior={online:true,otp:true,unauthorized:false,meta:'configured'};
 globalThis.fetch=async(url,opts={})=>{
  requests.push({url,method:opts.method||'GET',headers:opts.headers,body:opts.body});
  if(options.fetch)return options.fetch(url,opts);
  const meta=url.endsWith('/meta');
  if(!meta&&!behavior.online)return{ok:false,status:503,json:async()=>({error:{code:'CENTER_UNAVAILABLE',message:'Offline'}})};
  if(url.endsWith('/paid/me')&&behavior.unauthorized)return{ok:false,status:401,json:async()=>({error:{code:'SESSION_EXPIRED',message:'Expired'}})};
  return{ok:true,status:200,json:async()=>meta?{ok:true,paid:behavior.meta==='configured'?{available:true}:null}:url.endsWith('/status')?{available:behavior.otp,code:behavior.otp?'READY':'OTP_DISABLED',message:behavior.otp?'Ready':'Operator has disabled OTP'}:url.endsWith('/me')?account:url.endsWith('/verify')?{token:'customer-token'}:{ok:true}};
 };
 controller=createPaidServiceController({els,state,getStorage:async()=>structuredClone(storage),setStorage:async p=>Object.assign(storage,structuredClone(p)),toggleUi:()=>controller.applyVisibility(),...time,recoveryMs:1000,requestTimeoutMs:2000,recheckApi:options.recheckApi});
 return{controller,els,state,storage,time,requests,behavior};
};
const event={preventDefault(){}};
// Popup opens using a fresh health snapshot: it must still discover Paid.
{
 const x=make({aiServiceMode:'paid'});await x.controller.initialize();
 const h=createApiHealthController({els:x.els,state:x.state,normalizeUrl:x=>x,checkHealthOnce:async()=>true,fetchJson:async u=>(await fetch(u)).json(),paths:{META:'/meta'},timeout:100,retryDelays:[],setStatus(){},setSelectOptions(){},orderLanguages:x=>x,languages:[],sources:[],pinnedLanguages:[],persist:async()=>{},toggleUi(){},paidAvailability:(...a)=>x.controller.setAvailability(...a),...x.time});
 assert(h.acceptSnapshot({ok:true,fresh:true,base:x.els.apiUrl.value},x.els.apiUrl.value));await settle();
 check('Fresh API health snapshot still reads /meta and restores sign-in',()=>{assert(x.requests.some(r=>r.url.endsWith('/meta')));assert.equal(x.els.aiPaidPanel.style.display,'');assert.equal(x.els.aiPaidSend.disabled,false);});
 check('No OTP POST merely by reopening',()=>assert(x.requests.every(r=>r.method==='GET')));
 h.dispose();x.controller.dispose();
}
// Extension API comes first, Center starts later. No restart required.
{
 const x=make({aiServiceMode:'paid'});x.behavior.online=false;await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 check('Center offline retains selector and email form',()=>{assert.equal(x.els.aiServiceWrap.style.display,'');assert.equal(x.els.aiPaidPanel.style.display,'');assert.equal(x.els.aiPaidSend.disabled,true);assert.match(x.els.aiPaidConnectionMessage.textContent,/temporarily/);});
 x.behavior.online=true;await x.time.tick(1000);
 check('Center starts later and GET recovery enables email without reloading',()=>{assert.equal(x.els.aiPaidSend.disabled,false);assert.equal(x.els.aiPaidUnavailable.style.display,'none');assert.equal(x.storage.aiServiceMode,'paid');});
 check('Recovery does not request OTP automatically',()=>assert(x.requests.every(r=>r.method==='GET')));
 x.controller.dispose();
}
// Ordinary two step form and popup-close continuity while checking email.
let signedInStorage;
{
 const x=make({aiServiceMode:'paid'});await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 x.els.aiPaidEmail.value='customer@example.com';await x.els.aiPaidEmailStep.handlers.submit(event);
 check('Email submission shows OTP step only',()=>{assert.equal(x.els.aiPaidEmailStep.style.display,'none');assert.equal(x.els.aiPaidCodeStep.style.display,'');assert.equal(x.els.aiPaidCodeEmail.textContent,'customer@example.com');assert.equal(x.els.aiPaidResend.disabled,true);});
 const count=x.requests.filter(r=>r.method==='POST').length;await x.els.aiPaidResend.handlers.click(event);await settle();
 check('Resend cooldown prevents duplicate email requests',()=>assert.equal(x.requests.filter(r=>r.method==='POST').length,count));
 const saved=structuredClone(x.storage);x.controller.dispose();
 const y=make(saved);await y.controller.initialize();y.controller.setAvailability(true,y.els.apiUrl.value);await settle();
 check('Popup reopen restores OTP step without sending a new code',()=>{assert.equal(y.els.aiPaidCodeStep.style.display,'');assert(y.requests.every(r=>r.method==='GET'));assert.equal(JSON.stringify(y.storage).includes('123456'),false);});
 y.els.aiPaidCode.value='12a3456';y.els.aiPaidCode.handlers.input();assert.equal(y.els.aiPaidCode.value,'123456');
 await y.els.aiPaidCodeStep.handlers.submit(event);
 check('Verify signs in, shows credits/model, and clears pending code step',()=>{assert.equal(y.state.paidReady,true);assert.equal(y.els.aiPaidLogin.style.display,'none');assert.equal(y.els.aiPaidAccount.style.display,'');assert.equal(y.storage.paidPendingLogin,null);assert.equal(y.storage.paidModel,'demo/model');assert.equal(y.els.aiPaidCode.value,'');});
 check('Only customer session is sent to account endpoint',()=>{const r=y.requests.find(r=>r.url.endsWith('/me'));assert.equal(r.headers.Authorization,'Bearer customer-token');assert.equal(y.storage.paidApiBase,'http://localhost:7860');});
 signedInStorage=structuredClone(y.storage);y.controller.dispose();
}
// Full state hydration as after a browser restart, with Center initially down.
{
 const x=make(structuredClone(signedInStorage));x.behavior.online=false;await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 check('Browser restart while offline retains token and account shell, not login',()=>{assert.equal(x.storage.paidSessionToken,'customer-token');assert.equal(x.els.aiPaidLogin.style.display,'none');assert.equal(x.els.aiPaidAccount.style.display,'');assert.equal(x.state.paidReady,false);});
 x.behavior.online=true;await x.time.tick(1000);
 check('Browser restart session auto-restores via /me with no new OTP',()=>{assert.equal(x.state.paidReady,true);assert(x.requests.every(r=>r.method==='GET'));});
 x.behavior.online=false;await x.controller.reconnect();
 check('Temporary /me failure preserves balance and token but disables readiness',()=>{assert.equal(x.els.aiPaidCredits.textContent,'10,000 TP');assert.equal(x.storage.paidSessionToken,'customer-token');assert.equal(x.state.paidReady,false);});
 x.behavior.online=true;x.behavior.unauthorized=true;await x.time.tick(1000);
 check('Definitive 401 clears only the expired customer session and shows login',()=>{assert.equal(x.storage.paidSessionToken,'');assert.equal(x.els.aiPaidLogin.style.display,'');assert.equal(x.storage.aiServiceMode,'paid');});
 x.controller.dispose();
}
{
 const x=make(structuredClone(signedInStorage));await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 const n=x.requests.length;x.els.apiUrl.value='http://localhost:7999';x.state.lastSavedApiUrl=x.els.apiUrl.value;x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 check('Changing saved API never forwards previous customer token',()=>{assert.equal(x.storage.paidSessionToken,'');assert(x.requests.slice(n).every(r=>!r.headers?.Authorization));assert.equal(x.state.paidReady,false);});
 x.controller.setAvailability(false,x.els.apiUrl.value);
 check('Authoritative API without Paid shows customer availability and Manual remains reachable',()=>{assert.equal(x.els.aiServiceWrap.style.display,'');assert.equal(x.els.aiPaidConnectionMessage.textContent,'Paid is not available on this API. Choose Manual or try again later.');assert.doesNotMatch(x.els.aiPaidConnectionMessage.textContent,/TP_CENTER|Center settings|not configured/i);assert.equal(x.els.aiPaidSend.disabled,true);});
 x.els.aiService.value='manual';await x.els.aiService.handlers.change();
 check('Only explicit user choice switches from Paid to Manual',()=>{assert.equal(x.storage.aiServiceMode,'manual');assert.equal(x.state.paidActive,false);});
 x.controller.dispose();
}
// Transient metadata failure after accepting snapshot must recover by itself.
{
 const time=clock(),els={apiUrl:el('https://api.example'),lang:el(),sources:el()},state={lastApiOk:true,healthSeq:0};let calls=0;const observed=[];
 const h=createApiHealthController({els,state,normalizeUrl:x=>x,checkHealthOnce:async()=>true,fetchJson:async()=>{if(++calls===1)throw Error('temporary');return{ok:true,paid:{configured:true}};},paths:{META:'/meta'},timeout:100,retryDelays:[],setStatus(){},setSelectOptions(){},orderLanguages:x=>x,languages:[],sources:[],pinnedLanguages:[],persist:async()=>{},toggleUi(){},paidAvailability:(...a)=>observed.push(a),...time,metaRetryDelayMs:500});
 await h.refreshMeta(els.apiUrl.value);
 check('Failed metadata is unknown rather than definitively unsupported',()=>assert.equal(observed.at(-1)[0],null));
 await time.tick(500);
 check('Transient metadata self-recovers',()=>assert.equal(observed.at(-1)[0],true));
 h.dispose();await time.tick(10000);
 check('Disposing popup stops metadata retry traffic',()=>assert.equal(calls,2));
}
// Hung status gets bounded timeout and recovery, not a permanently disabled form.
{
 const x=make({aiServiceMode:'paid'},{fetch:async(_url,opts)=>new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>{const e=Error('aborted');e.name='AbortError';reject(e);} ))});
 await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();await x.time.tick(2000);
 check('Hung status request times out and schedules bounded read-only recovery',()=>{assert.equal(x.els.aiPaidSend.disabled,true);assert.match(x.els.aiPaidConnectionMessage.textContent,/temporarily/);assert(x.time.timers.size>0);});
 x.controller.dispose();await settle();check('Dispose cancels pending requests/timers',()=>assert.equal(x.time.timers.size,0));
}
// Ignore completions that belong to a previous URL or closed popup.
{
 let release;
 const x=make(structuredClone(signedInStorage),{fetch:async(url)=>{
  if(url.endsWith('/me'))return new Promise(r=>{release=()=>r({ok:true,json:async()=>account});});
  return{ok:true,json:async()=>({available:true})};
 }});
 await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 x.els.apiUrl.value='http://localhost:7999';x.state.lastSavedApiUrl=x.els.apiUrl.value;x.controller.setAvailability(true,x.els.apiUrl.value);
 release();await settle();
 check('Late /me completion cannot restore previous API account',()=>{assert.equal(x.storage.paidSessionToken,'');assert.equal(x.state.paidReady,false);assert.equal(x.els.aiPaidAccount.style.display,'none');});
 x.controller.dispose();
}
{
 let release;
 const x=make({aiServiceMode:'paid'},{fetch:async(url)=>{
  if(url.endsWith('/verify'))return new Promise(r=>{release=()=>r({ok:true,json:async()=>({token:'stale-verified-session'})});});
  return{ok:true,json:async()=>({available:true,ok:true})};
 }});
 await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 x.els.aiPaidEmail.value='customer@example.com';await x.els.aiPaidEmailStep.handlers.submit(event);
 x.els.aiPaidCode.value='123456';const verify=x.els.aiPaidCodeStep.handlers.submit(event);await settle();
 x.els.apiUrl.value='http://localhost:7999';x.state.lastSavedApiUrl=x.els.apiUrl.value;x.controller.setAvailability(true,x.els.apiUrl.value);
 release();await verify;await settle();
 check('Late OTP verification response cannot save token on a changed API',()=>{assert.notEqual(x.storage.paidSessionToken,'stale-verified-session');assert.equal(x.state.paidReady,false);});
 x.controller.dispose();
}
{
 let release;
 const x=make({aiServiceMode:'paid'},{fetch:async(url)=>new Promise(r=>{release=()=>r({ok:true,json:async()=>({available:true})});})});
 await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 x.controller.dispose();const before=x.els.aiPaidSend.disabled;release();await settle();
 check('Closed popup discards late readiness completion',()=>{assert.equal(x.els.aiPaidSend.disabled,before);assert.equal(x.time.timers.size,0);});
}
// Discovery while currently using Manual must still offer Paid on late Center start.
{
 const x=make({aiServiceMode:'manual',aiProvider:'openrouter',aiKey:'manual-fixture',aiModel:'my-manual-model'});x.behavior.online=false;
 await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
 check('Configured API advertises Paid even when Center has not started and Manual is selected',()=>{assert.equal(x.els.aiServiceWrap.style.display,'');assert.equal(x.requests.length,0);});
 x.behavior.online=true;x.els.aiService.value='paid';await x.els.aiService.handlers.change();await settle();
 check('Explicit Paid selection after Center starts works without API restart',()=>{assert.equal(x.els.aiPaidSend.disabled,false);assert.equal(x.storage.aiProvider,'openrouter');assert.equal(x.storage.aiKey,'manual-fixture');assert.equal(x.storage.aiModel,'my-manual-model');});
 x.controller.dispose();
}

console.log(`PASS ${checks.length} Paid recovery checks`);
if(process.env.TP_TEST_REPORT)fs.writeFileSync(process.env.TP_TEST_REPORT,JSON.stringify({scope:'Production JavaScript controllers with simulated storage, timers and HTTP. No real accounts or OTP.',checks,passed:checks.length},null,2));
