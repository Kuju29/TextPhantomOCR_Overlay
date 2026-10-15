import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const base='http://localhost:7860';
const store={customApiUrl:base,apiDefaultsFetchedAt:Date.now()};
globalThis.chrome={runtime:{id:'fixture',getManifest:()=>({version:'2026.10.4.43'})},storage:{local:{get(keys,cb){const value=Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys)).map(key=>[key,store[key]??keys[key]]));cb?.(value);return Promise.resolve(value);},set(value,cb){Object.assign(store,value);cb?.();return Promise.resolve();}},onChanged:{addListener(){}}}};
const settings={...store,aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-customer',paidApiBase:base,paidModel:'tp-model'};
let sync=null,calls=[];
globalThis.fetch=async(url,options={})=>{
 calls.push({url:String(url),method:options.method||'GET'});
 const selected={id:'tp-model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'4',output_tp:'9',model_revision:2,policy_revision:1},...(sync?{price_sync:sync}:{})};
 return Response.json(String(url).endsWith('/meta')?{paid:{available:true}}:{credits:{available:'1250',held:'0'},models:[selected]});
};
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
for(const status of ['stale','unavailable']){
 sync={automatic:true,status,checked_at:null};calls=[];
 await assert.rejects(()=>resolveJobAiProfile(settings,{language:'th'}),error=>error.code==='PAID_PRICE_UNVERIFIED'&&/price|ราคา/i.test(error.message),'Authoritative '+status+' pricing must stop before a generation handoff.');
 assert.equal(calls.length,2);assert(calls.every(call=>call.method==='GET'),'The price check cannot reserve or dispatch.');
}
for(const metadata of [null,{automatic:true,status:'current',checked_at:Math.floor(Date.now()/1000)}]){
 sync=metadata;calls=[];const result=await resolveJobAiProfile(settings,{language:'th'});
 assert.equal(result.settings.aiProvider,'paid');assert.equal(result.settings.aiModel,'tp-model');
 assert.equal(result.settings.aiPricing,undefined,'A display price must not become caller billing authority.');
 assert.equal(calls.length,2);assert(Object.isFrozen(result));
}
console.log(JSON.stringify({passed:true,count:4,scope:'Actual normal Paid resolver performs fresh GET metadata/account only; server-owned current pricing passes, stale/unavailable blocks, legacy compatible; no generation or charges'}));
