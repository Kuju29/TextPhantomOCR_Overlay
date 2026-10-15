import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const base='http://localhost:7860';
const store={customApiUrl:base,apiDefaultsFetchedAt:Date.now()};
globalThis.chrome={runtime:{id:'fixture',getManifest:()=>({version:'2026.10.4.58'})},storage:{local:{get(keys,cb){const v=Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys)).map(k=>[k,store[k]??keys[k]]));cb?.(v);return Promise.resolve(v);},set(v,cb){Object.assign(store,v);cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}};
const settings={...store,aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-customer',paidApiBase:base,paidModel:'tp-model',customPreservedSetting:'manual-rate-cap'};
const makeAccount=()=>({price_quote_available:true,credits:{available:'1250',held:'0'},models:[{id:'tp-model',max_output:2048,price_sync:{automatic:true,status:'unavailable'},model_capabilities:{limits:{maxOutputTokens:2048,contextTokens:16384}}},{id:'tp-other',max_output:8192,model_capabilities:{limits:{maxOutputTokens:8192,contextTokens:32768}}}]});
let account=makeAccount(),status=200,calls=[],release=null,blocked=false,invalidJson=false,metaAvailable=true;let checks=0;
globalThis.fetch=async(url,options={})=>{
 const row={url:String(url),auth:new Headers(options.headers).get('Authorization')};calls.push(row);
 if(row.url.endsWith('/meta'))return Response.json({paid:{available:metaAvailable}});
 assert(row.url.endsWith('/paid/me'),'resolver must not request another quote or AI');
 if(blocked)await new Promise(r=>{const previous=release;release=()=>{previous?.();r();};});
 if(invalidJson)return new Response("{",{status:200,headers:{"Content-Type":"application/json"}});
 return Response.json(account,{status});
};
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error('boundary not reached');};
const initial=await resolveJobAiProfile({...settings,aiPaidQuoteToken:'old-display-token',aiPaidPricing:{routeRevision:1}},{language:'th'});
assert.equal(calls.length,2);assert.equal(initial.settings.aiModel,'tp-model');assert.equal(initial.settings.aiPaidQuoteToken,undefined);assert.equal(initial.settings.aiPaidPricing,undefined);assert.equal(initial.settings.customPreservedSetting,'manual-rate-cap');assert.equal(initial.settings.aiModelCapabilities.limits.maxOutputTokens,2048);checks+=6;
// Same-origin account reads coalesce while in flight; selected model and profile
// remain per caller and no wallet/metadata read survives the completed call.
calls=[];blocked=true;
const same=Promise.all([resolveJobAiProfile(settings,{language:'th'}),resolveJobAiProfile({...settings,paidModel:'tp-other'},{language:'en'})]);
await until(()=>calls.some(c=>c.url.endsWith('/paid/me')));await new Promise(r=>setImmediate(r));
assert.equal(calls.filter(c=>c.url.endsWith('/meta')).length,1);assert.equal(calls.filter(c=>c.url.endsWith('/paid/me')).length,1);checks+=2;
blocked=false;release();release=null;
const resolved=await same;assert.deepEqual(resolved.map(r=>r.settings.aiModel),['tp-model','tp-other']);assert.deepEqual(resolved.map(r=>r.settings.aiModelCapabilities.limits.maxOutputTokens),[2048,8192]);checks+=2;
const before=calls.length;await resolveJobAiProfile(settings);assert.equal(calls.length,before+2);checks++;
// Separate authenticated accounts must never share a read, even at one origin.
calls=[];blocked=true;
const separate=Promise.all([resolveJobAiProfile(settings),resolveJobAiProfile({...settings,paidSessionToken:'synthetic-other'})]);
await until(()=>calls.filter(c=>c.url.endsWith('/paid/me')).length===2);
assert.deepEqual(calls.filter(c=>c.url.endsWith('/paid/me')).map(c=>c.auth).sort(),['Bearer synthetic-customer','Bearer synthetic-other']);checks++;
blocked=false;release();release=null;await separate;

// Origin changes cannot share the authenticated account request in flight.
calls=[];blocked=true;
const oldOrigin=resolveJobAiProfile(settings);
await until(()=>calls.some(c=>c.url===base+'/paid/me'));
const alternate='http://localhost:7861';store.customApiUrl=alternate;
const newOrigin=resolveJobAiProfile({...settings,paidApiBase:alternate});
await until(()=>calls.some(c=>c.url===alternate+'/paid/me'));
assert.equal(calls.filter(c=>c.url.endsWith('/paid/me')).length,2);checks++;
blocked=false;release();release=null;await Promise.all([oldOrigin,newOrigin]);store.customApiUrl=base;
// A shared invalid response rejects every waiter and cannot poison a later read.
calls=[];blocked=true;invalidJson=true;
const invalid=Promise.allSettled([resolveJobAiProfile(settings),resolveJobAiProfile(settings)]);
await until(()=>calls.some(c=>c.url.endsWith('/paid/me')));await new Promise(r=>setImmediate(r));
assert.equal(calls.filter(c=>c.url.endsWith('/paid/me')).length,1);checks++;
blocked=false;release();release=null;
assert((await invalid).every(r=>r.status==='rejected'&&r.reason.code==='PAID_CENTER_UNAVAILABLE'));checks++;
invalidJson=false;const failedCalls=calls.length;await resolveJobAiProfile(settings);assert.equal(calls.length,failedCalls+2);checks++;
metaAvailable=false;calls=[];await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_CENTER_UNAVAILABLE');assert.equal(calls.length,1);checks+=2;metaAvailable=true;

// Errors clear the in-flight slot, and later reads observe revoked/paused/model
// state immediately. UI credit metadata is never used to authorize spending.
status=401;await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_LOGIN_REQUIRED');checks++;
status=503;await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_CENTER_UNAVAILABLE');checks++;
status=200;account={...makeAccount(),paid_restriction:{blocked:true,code:'PAID_ACCOUNT_RESTRICTED',reason:'dispute'}};await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_ACCOUNT_RESTRICTED');checks++;
account={...makeAccount(),paid_paused:true};await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_PAUSED');checks++;
account={...makeAccount(),models:[]};await assert.rejects(()=>resolveJobAiProfile(settings),e=>e.code==='PAID_MODEL_NOT_ALLOWED');checks++;
account={...makeAccount(),credits:{available:'0',held:'0'}};await resolveJobAiProfile(settings);checks++;
account=makeAccount();await resolveJobAiProfile(settings);checks++;
assert(calls.every(c=>!c.url.includes('price-quote')&&!c.url.includes('translate')&&!c.url.includes('completions')));checks++;
assert(!JSON.stringify(store).includes('old-display-token'));checks++;
const {sessionSafe}=await import('../src/background/translation-session-store.js');
const {redactAiWireValue}=await import('../src/background/ai/wire-trace.js');
const privateConfig={price_quote_token:'opaque-never-persisted',priceQuoteToken:'opaque-never-persisted',aiPaidQuoteToken:'opaque-never-persisted',paidPriceQuoteToken:'opaque-never-persisted',model:'tp-model'};
assert.deepEqual(sessionSafe({ai:privateConfig}),{ai:{model:'tp-model'}});assert(!JSON.stringify(redactAiWireValue(privateConfig)).includes('opaque-never-persisted'));checks+=2;
console.log(JSON.stringify({passed:true,checks,scope:'Actual resolver: two read-only calls, in-flight coalescing only, private account/model scope, no click quote or AI; fresh operation quote and spend admission remain in API/Center'}));
