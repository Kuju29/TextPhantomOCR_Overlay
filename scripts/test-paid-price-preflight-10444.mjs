import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const base='http://localhost:7860';
const store={customApiUrl:base,apiDefaultsFetchedAt:Date.now(),tpDataConsentV1:{version:1,granted:true,at:1},
 paidSessionToken:'synthetic-customer',paidApiBase:base}; // 10495: the account session is read from storage (shared/account-gate.js)
globalThis.chrome={runtime:{id:'fixture',getManifest:()=>({version:'2026.10.4.43'})},storage:{local:{get(keys,cb){const value=Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys)).map(key=>[key,store[key]??keys[key]]));cb?.(value);return Promise.resolve(value);},set(value,cb){Object.assign(store,value);cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}};
const settings={...store,aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-customer',paidApiBase:base,paidModel:'tp-model'};
let sync=null,calls=[];
globalThis.fetch=async(url,options={})=>{
 calls.push({url:String(url),method:options.method||'GET'});
 const selected={id:'tp-model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'4',output_tp:'9',model_revision:2,policy_revision:1},...(sync?{price_sync:sync}:{})};
 return Response.json(String(url).endsWith('/meta')?{paid:{available:true}}:{credits:{available:'1250',held:'0'},models:[selected]});
};
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
// .66 (G1) and .91: price freshness is display information only. A stale or
// unavailable price record never blocks translation; the Center prices the real
// request (and refuses a model without a price) — the translation is the check.
for(const metadata of [{automatic:true,status:'stale',checked_at:null},{automatic:true,status:'unavailable',checked_at:null},
  null,{automatic:true,status:'current',checked_at:Math.floor(Date.now()/1000)}]){
 sync=metadata;calls=[];const result=await resolveJobAiProfile(settings,{language:'th'});
 assert.equal(result.settings.aiProvider,'paid');assert.equal(result.settings.aiModel,'tp-model');
 assert.equal(result.settings.aiPricing,undefined,'A display price must not become caller billing authority.');
 assert.equal(calls.length,2);assert(calls.every(call=>call.method==='GET'),'The price check cannot reserve or dispatch.');
 assert(Object.isFrozen(result));
}
console.log(JSON.stringify({passed:true,count:4,scope:'Actual normal Paid resolver performs fresh GET metadata/account only; current, stale, unavailable and legacy price records all pass (display only); no generation or charges'}));
