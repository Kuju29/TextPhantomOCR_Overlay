import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
import {providerPressure, pressurePause, taskPageIds} from '../src/background/repair/provider-pressure.js';
import {diagnoseTargetScripts} from '../src/background/ai/script-diagnostics.js';
import {makePageCheckpoint,checkpointCredentialMatches} from '../src/background/repair/page-checkpoint.js';
import {repairRequestProgress} from '../src/background/repair/executor.js';
import {createDispatchJournal} from '../src/background/repair/dispatch-journal.js';
import {createPreparedPageJournal} from '../src/background/repair/prepared-page-journal.js';

const pressure=providerPressure({code:'provider_rate_limited',status:502,upstreamStatus:429,
  retryAfterMs:60000,constraintScope:'key',creditState:'released',message:'PRIVATE'},100);
assert.equal(pressure.until,60100); assert.equal(pressure.scope,'key');
assert.equal(pressurePause(pressure,100).requestDispatched,false);
assert.equal(pressurePause(pressure,60100),null);
assert.equal(providerPressure({status:429,code:'paid_credits_insufficient'}),null);
assert.equal(providerPressure({code:'provider_rate_limited'},100).scope,'unknown');
assert(!JSON.stringify(pressure).includes('PRIVATE'));
const task={units:[{pageId:'a'},{pageId:'b'},{pageId:'a'}]};
assert.deepEqual(taskPageIds(task),['a','b']);
assert.deepEqual(repairRequestProgress('finished',{},'task',3,taskPageIds(task)).pageIds,['a','b']);

const diagnostic=(text,source=text)=>diagnoseTargetScripts([{id:'g0',text}],'th',[{id:'g0',text:source}])[0];
assert.equal(diagnostic('AoshiAiyori2025').decision,'accept');
assert.equal(diagnostic('AoshiAiyori2025','Some other text').decision,'reject');
assert.equal(diagnostic('THIS IS AN UNTRANSLATED SENTENCE').decision,'reject');
assert.equal(diagnostic('I want to go home now').decision,'reject');
assert.equal(diagnostic('これは翻訳されていません').decision,'reject');

async function page(sourceLang, key='account-a') {
  return makePageCheckpoint({payload:{metadata:{image_id:'page'},lang:'th',rate:null},
    result:{lensDocument:{languages:{source:sourceLang},paragraphs:[]}}, units:[],
    plan:{ai:{provider:'paid',model:'fixture',api_key:key,translation_mode:'conversation'},route:'server'},
    ctx:{jobId:'generation'},operationId:'operation'});
}
const a=await page('en'), b=await page('ja'), c=await page('en','account-b');
assert.equal(a.groupKey,b.groupKey,'OCR language must not split the same Conversation');
assert.notEqual(a.groupKey,c.groupKey,'accounts remain isolated');
assert(await checkpointCredentialMatches(a,'account-a'));
assert(!await checkpointCredentialMatches(a,'account-b'));

const values={};let removes=0;
const area={get:async key=>key==null?structuredClone(values):{[key]:structuredClone(values[key])},
  set:async patch=>Object.assign(values,structuredClone(patch)),remove:async keys=>{removes++;for(const key of [].concat(keys))delete values[key];}};
const prepared=createPreparedPageJournal({area:()=>area}), dispatch=createDispatchJournal({area:()=>area});
for(const id of ['a','b','c','d']) await prepared.record('run',id,{...a,pageId:id});
await prepared.removeMany('run',['a','b','c','d']); assert.equal(removes,1);
assert.deepEqual(await prepared.listRun('run'),[]);
await dispatch.removeMany('run',['a','b']); assert.equal(removes,2);
console.log('PASS .65 rate evidence, task membership, credit signature, account isolation and bounded journal removal');
