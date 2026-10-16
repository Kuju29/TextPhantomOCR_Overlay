import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const stored={tpDataConsentV1:{version:1,granted:true,at:1},paidSessionToken:'customer-session',paidApiBase:'http://localhost:7860'}, writes=[], trace=[]; // 10495: a signed-in user who allowed data use
globalThis.chrome={runtime:{getManifest:()=>({version:'fixture10464'})},storage:{local:{
  get(keys,cb){const v=keys==null?structuredClone(stored):typeof keys==='string'?{[keys]:structuredClone(stored[keys])}:Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,structuredClone(stored[k])])):{...keys,...structuredClone(stored)};cb?.(v);return Promise.resolve(v);},
  set(v,cb){writes.push(structuredClone(v));Object.assign(stored,structuredClone(v));cb?.();return Promise.resolve();},
  remove(keys,cb){for(const k of [].concat(keys))delete stored[k];cb?.();return Promise.resolve();},
}}};
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
const {flushUsageReceiptJournal,currentUsage}=await import('../src/shared/ai-usage.js');
const {userMessageForCode}=await import('../src/shared/error-contract.js');
let posts=0;
globalThis.fetch=async()=>{posts++;return Response.json({detail:{
  schema:'tp.error/1',code:'paid_database_unavailable',origin:'control_center',stage:'paid_database',
  category:'database',httpStatus:503,retryable:false,providerDispatchEvidence:'unconfirmed',
  providerAttempts:null,generationAttempts:null,requestDispatched:null,centerRequestDispatched:true,
  creditState:'unconfirmed',message:'Database failed; original operation outcome unknown',
}},{status:503});};
await assert.rejects(translateViaServer([{id:'P0',text:'Hello'}],{
  base:'https://api.fixture.invalid',operationId:'database-unconfirmed-operation',targetLang:'th',sourceLang:'en',
  ai:{provider:'paid',model:'qa/test',translation_mode:'independent'},
  trace:(name,value)=>trace.push({name,value}),
}),error=>error.code==='paid_database_unavailable'&&error.origin==='control_center'&&
  error.generationAttempts===null&&error.providerAttempts===null&&error.requestDispatched===null);
await flushUsageReceiptJournal({recover:true});
assert.equal(posts,1,'Database failure cannot automatically resend the financial operation');
const failed=trace.find(x=>x.name==='text-only AI failed').value;
assert.equal(failed.generationAttempts,null);assert.equal(failed.providerAttempts,null);
assert.equal(failed.providerDispatchEvidence,'unconfirmed');
const usage=currentUsage(stored.aiUsageV1,{runtime:'cloud',provider:'paid',model:'qa/test'});
assert.equal(usage.requests,0,'Unconfirmed database failure cannot invent a billed generation');
assert.equal(usage.pendingOperations,1,'Original pending operation remains available for reconciliation');
assert.ok(userMessageForCode('paid_database_unavailable').includes('ฐานข้อมูล Center'));
assert.ok(!userMessageForCode('paid_database_unavailable').includes('ผู้ให้บริการ AI ไม่รับ'));
const journals=writes.flatMap(v=>Object.entries(v).filter(([k])=>k.startsWith('aiUsageReceiptV1:')).map(([,v])=>v.event));
assert.ok(journals.some(x=>x.pending===true));
assert.ok(!journals.some(x=>x.resolvePending===true||x.requests>0));
console.log('Paid database browser transport: one HTTP request, unknown generation, pending retained, correct Thai message.');
