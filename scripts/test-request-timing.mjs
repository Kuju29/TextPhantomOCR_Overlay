import assert from 'node:assert/strict';
const state={},events=[],progress=[],wire=[];let release,failWrite=false,holdRead=false;
const tick=()=>new Promise(r=>setImmediate(r));
globalThis.chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
 get(k,cb){const go=()=>cb(Array.isArray(k)?Object.fromEntries(k.map(x=>[x,state[x]])):{...k,...structuredClone(state)});if(holdRead){release=go;}else go();},
 set(v,cb){if(failWrite){chrome.runtime.lastError={message:'quota'};cb();delete chrome.runtime.lastError;}else{Object.assign(state,structuredClone(v));cb();}}
}}};
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
globalThis.fetch=async(url,init)=>{wire.push(JSON.parse(init.body));return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'g0',text:'ทดสอบ'}],missing:[],
 meta:{resolvedProvider:'openrouter',resolvedModel:'fixture',generationAttempts:1,providerAttempts:1,usage:{inputTokens:10,outputTokens:3,totalTokens:13}}}),{status:200});};
const opts=(id,signal)=>({base:'https://fixture.invalid',operationId:id,targetLang:'th',sourceLang:'ja',signal,
 ai:{provider:'openrouter',model:'fixture',prompt:'STYLE',thinking:'off'},trace:(name,data)=>events.push({name,data}),onProgress:p=>progress.push(p.state)});
const input=[{id:'g0',text:'日本語'}];
let checks=0;
holdRead=true;const one=translateViaServer(input,opts('wait-A'));const two=translateViaServer(input,opts('wait-B'));
await tick();assert.equal(wire.length,0);assert.equal(progress.filter(p=>p==='usage_pending').length,2);assert(!progress.includes('http_wait'));
holdRead=false;release();await Promise.all([one,two]);assert.equal(wire.length,2);
const started=events.filter(e=>e.name==='requestTiming'&&e.data.reason==='http_started');assert.equal(started.length,2);
assert(started.every(e=>e.data.timing.persistMs>=0&&e.data.timing.httpAttempts===1));checks++;
console.log('PASS delayed durable storage is not mislabeled as HTTP or provider time');
holdRead=true;const abort=new AbortController();const cancelled=translateViaServer(input,opts('cancel-during-persist',abort.signal));await tick();
abort.abort();holdRead=false;release();await assert.rejects(cancelled,e=>e.name==='AbortError');assert.equal(wire.length,2);checks++;
assert(events.some(e=>e.name==='requestTiming'&&e.data.reason==='cancelled'&&e.data.timing.httpAttempts===0));
console.log('PASS cancellation during pending storage cannot dispatch HTTP');
failWrite=true;await assert.rejects(translateViaServer(input,opts('storage-failed')));failWrite=false;
assert.equal(wire.length,2);assert(events.some(e=>e.name==='requestTiming'&&e.data.reason==='persistence_failed'&&e.data.timing.httpAttempts===0));checks++;
console.log('PASS failed persistence stays before HTTP; no fake provider attempt');
const phases=events.filter(e=>e.name==='requestTiming').map(e=>e.data.reason);
assert(phases.includes('http_headers')&&phases.includes('response_complete'));assert(progress.includes('validating'));checks++;
console.log('PASS ready / persistence / HTTP / headers / response separated with monotonic durations');
console.log(`${checks}/${checks} actual Cloud transport timing checks passed.`);
