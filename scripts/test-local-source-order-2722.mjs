import assert from 'node:assert/strict';
import {reserveLocalIndependentJob as reserve,enterLocalIndependentJob as enter,
  finishLocalIndependentJob as finish,cancelLocalIndependentJobs as cancel} from '../src/background/ai/translation-paths/independent-order.js';
const sleep=()=>new Promise(r=>setTimeout(r,5));
const payload=(index,batch='b',style=true)=>({engine:'extension',source:'ai',lang:'th',metadata:{batch_id:batch},
  context:{page_index:index,page_url:'https://fixture/chapter',tp_tab_session:'session'},
  ai:{translation_mode:'independent',provider:'ollama',model:'fixture',base_url:'http://localhost:11434',style_examples:style}});
// Enqueue intentionally out of source order; OCR completes page 3 before 1.
const p=[payload(2),payload(0),payload(1)];p.forEach(x=>reserve(x,1));
const order=[]; const e3=enter(p[0],null).then(()=>order.push(3));const e2=enter(p[2],null).then(()=>order.push(2));
await sleep();assert.deepEqual(order,[]);await enter(p[1],null);order.push(1);
await sleep();assert.deepEqual(order,[1],'POST alone cannot make prior translations available');
finish(p[1]);await e2;assert.deepEqual(order,[1,2]);finish(p[2]);await e3;assert.deepEqual(order,[1,2,3]);finish(p[0]);
// A failed/cancelled earlier OCR reservation cannot wedge followers.
const a=payload(0,'cancel'),b=payload(1,'cancel');reserve(a,1);reserve(b,1);const wb=enter(b);finish(a);await wb;finish(b);
// Another document/batch may run while the first one is waiting.
const c=payload(0,'parallel'),d=payload(1,'parallel'),other=payload(0,'other');[c,d,other].forEach(x=>reserve(x,2));
const wd=enter(d).then(()=>false,e=>e.name);await enter(c);await enter(other);cancel({tabId:2,batchId:'parallel'});assert.equal(await wd,'AbortError');finish(other);
// With examples disabled, only source-order admission is required; capacity owns overlap.
const x=payload(0,'noexamples',false),y=payload(1,'noexamples',false);reserve(x);reserve(y);
let started=false;const wy=enter(y).then(()=>started=true);await sleep();assert.equal(started,false);await enter(x);await wy;finish(x);finish(y);
// Reusing a settled payload for an explicit resume gets a fresh ticket.
reserve(x);await enter(x);finish(x);
console.log('PASS Local source order: OCR reversal, accepted-result dependency, cancellation, scope isolation, examples-off overlap');
