// Diagnostic transport uses real modules; network is held to expose async-base races.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
globalThis.chrome={runtime:{getManifest:()=>({version:'test43'})}};
const trace=await import(new URL('src/shared/trace.js',root));
const log=await import(new URL('src/shared/log-sink.js',root));
const results=[];
async function check(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}finally{trace.setTracingEnabled(false);log.setLogShippingEnabled(false);}}
const delay=()=>new Promise(r=>setTimeout(r,0));
const data=Object.fromEntries(Array.from({length:9},(_,i)=>[`v${i}`,'ก'.repeat(140)]));
let statistics;
await check('300 multibyte trace records: exact-once, byte bounded, one shipment in flight',async()=>{
 const requests=[];let active=0,peak=0;
 globalThis.fetch=async(_url,init)=>{active++;peak=Math.max(peak,active);await delay();requests.push({body:JSON.parse(init.body),bytes:Buffer.byteLength(init.body),keepalive:init.keepalive});active--;return {ok:true,status:200,json:async()=>({ok:true})};};
 trace.setTracingEnabled(true,async()=>{await delay();return 'http://fixture';},'compact','budget');
 for(let i=0;i<300;i++)trace.note('fixture','burst',{...data,index:i});
 for(let i=0;i<100;i++){await Promise.all(Array.from({length:12},()=>trace.flushTrace()));if(requests.flatMap(x=>x.body.records).length===300)break;}
 const records=requests.flatMap(x=>x.body.records);
 assert.equal(records.length,300);assert.equal(new Set(records.map(x=>x.n)).size,300);assert.equal(peak,1);
 assert.ok(requests.every(x=>x.bytes<=48*1024));assert.ok(requests.every(x=>x.keepalive===false));
 statistics={records:records.length,batches:requests.length,maxBytes:Math.max(...requests.map(x=>x.bytes)),peak};
});
await check('old 503 cannot switch off a new trace session',async()=>{
 let end;globalThis.fetch=()=>new Promise(r=>{end=r;});trace.setTracingEnabled(true,()=> 'http://fixture','compact','old');trace.note('fixture','old');const pending=trace.flushTrace();
 while(!end)await delay();trace.setTracingEnabled(true,()=> 'http://fixture','compact','new');trace.note('fixture','new');end({status:503,ok:false});await pending;
 assert.equal(trace.isTracing(),true);
 const sent=[];globalThis.fetch=async(_u,i)=>{sent.push(JSON.parse(i.body));return {status:200,ok:true,json:async()=>({ok:true})};};await trace.flushTrace();
 assert.equal(sent.length,1);assert.equal(sent[0].traceSession,'new');assert.equal(sent[0].records.length,1);assert.equal(sent[0].records[0].fn,'new');
});
await check('oversized relayed metadata is dropped once instead of poisoning every flush',async()=>{
 const sent=[];globalThis.fetch=async(_u,i)=>{sent.push(JSON.parse(i.body));return {status:200,ok:true,json:async()=>({ok:true})};};trace.setTracingEnabled(true,()=> 'http://fixture','compact','oversized');
 trace.traceRelay({file:'x'.repeat(100000),fn:'oversized',n:1});trace.note('fixture','small');await trace.flushTrace();await trace.flushTrace();
 assert.equal(sent.length,1);assert.equal(sent[0].records.length,1);assert.equal(sent[0].records[0].fn,'small');assert.equal(sent[0].droppedSinceLastBatch,1);
});
await check('log shipping obeys the same byte and in-flight limits and ignores old ACKs',async()=>{
 const sent=[];let active=0,peak=0;
 globalThis.fetch=async(_u,i)=>{active++;peak=Math.max(peak,active);await delay();sent.push({body:JSON.parse(i.body),bytes:Buffer.byteLength(i.body),keepalive:i.keepalive});active--;return {status:200,ok:true,json:async()=>({ok:true})};};
 log.setLogShippingEnabled(true,async()=>{await delay();return 'http://fixture';},'http://fixture',{authoritative:true});
 for(let i=0;i<100;i++)log.recordLogLine({i,event:'a'.repeat(1500)});
 for(let i=0;i<100;i++){await delay();await Promise.all(Array.from({length:8},()=>log.flushLogs()));if(sent.flatMap(x=>x.body.records).length===100)break;}
 const records=sent.flatMap(x=>x.body.records);assert.equal(records.length,100);assert.equal(new Set(records.map(x=>x.n)).size,100);assert.equal(peak,1);assert.ok(sent.every(x=>x.bytes<=48*1024&&x.keepalive===false));
});
await check('AI wire failure never warns/errors and only publishes bounded redacted trace metadata',async()=>{
 const wire=await import(new URL('src/background/ai/wire-trace.js',root));const sent=[],warnings=[];
 const oldWarn=console.warn,oldError=console.error;
 trace.setTracingEnabled(true,()=> 'http://fixture','compact','wire');globalThis.fetch=async(_u,i)=>{sent.push(JSON.parse(i.body));return {ok:true,status:200,json:async()=>({ok:true})};};
 console.warn=(...a)=>warnings.push(a);console.error=(...a)=>warnings.push(a);
 try{const recorder=wire.createAiWireRecorder({enabled:true,operationId:'fixture-op',traceId:'fixture-trace',identity:{route:'direct-local'},apiBase:'http://fixture',relay:{path:'/relay',token:'secret-capability'},fetchImpl:async()=>{throw new Error('sensitive provider message');}});await recorder('units',[]);await recorder.flush(100);await trace.flushTrace();}finally{console.warn=oldWarn;console.error=oldError;}
 assert.equal(warnings.length,0);assert.ok(sent.flatMap(x=>x.records).some(x=>x.fn==='relayDisabled'));assert.doesNotMatch(JSON.stringify(sent),/secret-capability|sensitive provider message/);
});
console.log(JSON.stringify({schema:'tp.trace-shipping-budget/1',statistics,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
process.exitCode=results.some(x=>!x.pass)?1:0;
