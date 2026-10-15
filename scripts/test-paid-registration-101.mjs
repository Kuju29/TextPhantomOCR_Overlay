/** Production controller regression tests. Fake timers/network; no real OTP. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
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

let registration=true, domainError=false;
function response(url,opts={}) {
 let data=url.endsWith('/status')?{available:true,registration_enabled:registration}:
 url.endsWith('/me')?account:url.endsWith('/verify')?{token:'customer-token',registered:true}:
 {ok:true,request_status:'received',delivery_status:'unconfirmed',resend_after_seconds:120};
 const fail=domainError&&url.endsWith('/request');
 if(fail)data={error:{code:'EMAIL_DOMAIN_NOT_ALLOWED',message:'Recipient domain is not enabled'}};
 return Promise.resolve({ok:!fail,status:fail?400:200,headers:{get:()=>null},json:async()=>data});
}
const x=make({aiServiceMode:'paid',uiLanguageV1:'ja',lang:'ko',aiPrompt:'Private image prompt'},{fetch:response});await x.controller.initialize();x.controller.setAvailability(true,x.els.apiUrl.value);await settle();
check('New-user sign-up is visible, without an automatic POST',()=>{assert.match(x.els.aiPaidTitle.textContent,/create account/);assert(x.requests.every(r=>r.method==='GET'));});
x.els.aiPaidEmail.value='customer@example.com';await x.els.aiPaidEmailStep.handlers.submit(event);await settle();
const req=x.requests.find(r=>r.url.endsWith('/request')), device=JSON.parse(req.body).device_id;
check('OTP receives selected UI language metadata without image language or private prompt',()=>{const body=JSON.parse(req.body);assert.equal(body.ui_language,'ja');assert.deepEqual(Object.keys(body).sort(),['device_id','email','ui_language']);assert.equal(x.storage.lang,'ko');assert.equal(x.storage.aiPrompt,'Private image prompt');});
// .85 owner: one random install id for the whole browser profile (tpInstallIdV1), also sent as X-TP-Install.
check('Device hint is one random id per browser profile, persisted and sent as X-TP-Install',()=>{assert.match(device,/^[a-f0-9]{32}$/);assert.equal(x.storage.tpInstallIdV1,device);assert.equal(new Headers(req.headers).get('X-TP-Install'),device);});
check('Request receipt never claims actual mail delivery',()=>{assert.match(x.els.aiPaidStatus.textContent,/Request received/);assert.match(x.els.aiPaidStatus.textContent,/not confirmed/);assert.match(x.els.aiPaidStatus.textContent,/support:/);assert(!/email sent/i.test(x.els.aiPaidStatus.textContent));});
check('Server cooldown and support trace survive popup close',()=>{assert.equal(x.storage.paidPendingLogin.resendAt-x.time.now(),120000);assert(x.storage.paidPendingLogin.traceId);});
await x.time.tick(61000);check('No resend before server-provided two-minute cooldown',()=>assert(x.els.aiPaidResend.disabled));
const store=structuredClone(x.storage);x.controller.dispose();const y=make(store,{fetch:response});await y.controller.initialize();y.controller.setAvailability(true,y.els.apiUrl.value);await settle();
check('Reopen restores challenge without email re-send',()=>{assert(y.requests.every(r=>r.method==='GET'));assert.equal(y.els.aiPaidCodeStep.style.display,'');assert.match(y.els.aiPaidStatus.textContent,/reference/i);});
y.els.aiPaidCode.value='123456';await y.els.aiPaidCodeStep.handlers.submit(event);await settle();
check('Verified registration enters existing account screen and stores session, not OTP',()=>{assert(y.state.paidReady);assert.equal(y.storage.paidPendingLogin,null);assert.equal(y.storage.paidSessionToken,'customer-token');assert(!JSON.stringify(y.storage).includes('123456'));});
y.controller.dispose();
const z=make({aiServiceMode:'paid',paidDeviceIds:[{apiBase:'http://localhost:7860',id:device}]},{fetch:response});await z.controller.initialize();z.controller.setAvailability(true,z.els.apiUrl.value);await settle();z.els.aiPaidEmail.value='customer@example.com';await z.els.aiPaidEmailStep.handlers.submit(event);await settle();
check('An older per-API device id is migrated and reused',()=>{assert.equal(JSON.parse(z.requests.find(r=>r.url.endsWith('/request')).body).device_id,device);assert.equal(z.storage.tpInstallIdV1,device);});
z.storage.uiLanguageV1='th';z.els.apiUrl.value='http://localhost:7999';z.state.lastSavedApiUrl=z.els.apiUrl.value;z.controller.setAvailability(true,z.els.apiUrl.value);await settle();z.els.aiPaidEmail.value='customer@example.com';await z.els.aiPaidEmailStep.handlers.submit(event);await settle();
check('Different API keeps the same browser id and gets no old bearer',()=>{const req=z.requests.filter(r=>r.url.endsWith('/request')).at(-1);assert.equal(JSON.parse(req.body).device_id,device);assert(!req.headers.Authorization);});z.controller.dispose();
check('A changed UI language is read at the next explicit OTP request',()=>assert.equal(JSON.parse(z.requests.filter(r=>r.url.endsWith('/request')).at(-1).body).ui_language,'th'));
registration=false;domainError=true;const p=make({aiServiceMode:'paid',uiLanguageV1:'https://invalid.example'},{fetch:response});await p.controller.initialize();p.controller.setAvailability(true,p.els.apiUrl.value);await settle();
check('Registration-disabled policy shows returning customer wording',()=>assert.match(p.els.aiPaidSubtitle.textContent,/registrations are closed/));
p.els.aiPaidEmail.value='customer@example.com';await p.els.aiPaidEmailStep.handlers.submit(event);await settle();
check('An unsupported saved UI language falls back to English metadata',()=>assert.equal(JSON.parse(p.requests.find(r=>r.url.endsWith('/request')).body).ui_language,'en'));
check('Domain refusal stays on email screen with support trace, no pretend code sent',()=>{assert.equal(p.els.aiPaidCodeStep.style.display,'none');assert.match(p.els.aiPaidStatus.textContent,/Recipient domain/);assert.match(p.els.aiPaidStatus.textContent,/Trace:/);assert(!p.storage.paidPendingLogin);});p.controller.dispose();
console.log(JSON.stringify({checks,total:checks.length,scope:'Production controller with synthetic storage/timers/network; not installed browser extension'},null,2));
