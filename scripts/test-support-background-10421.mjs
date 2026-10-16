import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
globalThis.crypto ??= webcrypto;
const saved={tpDataConsentV1:{version:1,granted:true,at:1},supportActivated:true,paidSessionToken:'a'.repeat(64),paidApiBase:'http://localhost:7860',customApiUrl:'http://localhost:7860'};
const listeners=[],requests=[],notices=[];let next=async()=>new Response(JSON.stringify({thread:{unread:1,last_seq:4}}),{status:200});
globalThis.chrome={runtime:{getManifest:()=>({version:'qa'}),sendMessage:()=>{},lastError:null},storage:{local:{get:(keys,cb)=>queueMicrotask(()=>cb(Object.fromEntries(keys.map(k=>[k,saved[k]])))),set:(patch,cb)=>queueMicrotask(()=>{Object.assign(saved,patch);cb?.();})},onChanged:{addListener:fn=>listeners.push(fn)}},tabs:{query:(_opts,cb)=>cb([{id:5}]),sendMessage:(id,msg,cb)=>{notices.push({id,msg});cb?.();}}};
globalThis.fetch=async(url,opts)=>{if (url.endsWith('/meta')) return new Response(JSON.stringify({ok:true,paid:{configured:true}}),{status:200});requests.push({url,opts});return next(url,opts);};
const {pollSupport}=await import(new URL('../src/background/support.js', import.meta.url));
const results=[];const tick=()=>new Promise(r=>setImmediate(r));
async function until(predicate){const deadline=Date.now()+2000;while(!predicate()){assert(Date.now()<deadline,'Queued unread check did not complete');await new Promise(r=>setTimeout(r,5));}}
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
await test('Concurrent unread triggers never overlap upstream requests',async()=>{requests.length=0;let active=0,maximum=0;next=async()=>{active++;maximum=Math.max(maximum,active);await tick();active--;return new Response(JSON.stringify({thread:{unread:1,last_seq:4}}),{status:200});};await Promise.all([pollSupport(),pollSupport()]);for(let i=0;i<10;i++)await tick();assert.equal(maximum,1);});
await test('Identity change during unread fetch queues fresh account check',async()=>{requests.length=0;let entered,release;const started=new Promise(r=>entered=r);next=(_url,opts)=>new Promise((resolve,reject)=>{release=()=>resolve(new Response(JSON.stringify({thread:{unread:0,last_seq:8}}),{status:200}));opts.signal.addEventListener('abort',()=>reject(Object.assign(new Error('abort'),{name:'AbortError'})));entered();});
const pending=pollSupport();await started;saved.paidSessionToken='b'.repeat(64);next=async()=>new Response(JSON.stringify({thread:{unread:0,last_seq:9}}),{status:200});listeners.forEach(fn=>fn({paidSessionToken:{newValue:saved.paidSessionToken}},'local'));release();await pending;await until(()=>requests.length===2 && saved.supportUnread?.lastSeq===9);assert.equal(requests.length,2,'Listeners '+listeners.length+' requests '+requests.length+' lastSeq '+saved.supportUnread?.lastSeq);assert.equal(requests[1].opts.headers.Authorization,'Bearer '+saved.paidSessionToken);});
const report={checks:results.length,passed:results.filter(x=>x.passed).length,results};console.log(JSON.stringify(report,null,2));process.exitCode=results.some(x=>!x.passed)?1:0;
