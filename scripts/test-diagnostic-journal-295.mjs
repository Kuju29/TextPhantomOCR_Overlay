/** Durable browser journal against mocked browser storage and network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
const checks=[];let moduleNo=0;
const done=name=>checks.push({name,passed:true});
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(r=>setImmediate(r));};
// 10494: these cases are about a user who switched "Send diagnostic logs" on.
const fresh=async({allowed=true}={})=>{const s=await import(`../src/shared/log-sink.js?test=${++moduleNo}`);s.setDiagnosticsUploadAllowed(allowed);return s;};
let db={},writes=0;
globalThis.chrome={storage:{local:{async get(key){return {[key]:structuredClone(db[key])};},async set(data){writes++;db={...db,...structuredClone(data)};}}}};
let payloads=[];
globalThis.fetch=async(_url,opt)=>{payloads.push(JSON.parse(opt.body));return{ok:true,json:async()=>({ok:true})};};
{
 // Default (switch off): nothing is recorded, kept or sent, even when the API accepts logs.
 db={tpDiagnosticJournalV1:{base:'http://localhost:7860',records:[{t:Date.now(),run:'old',n:1,event:'old'}],dropped:0,enabled:true,updatedAt:Date.now()}};
 const s=await fresh({allowed:false});await s.initializeLogJournal('http://localhost:7860');
 s.setLogShippingEnabled(true,()=> 'http://localhost:7860','http://localhost:7860',{authoritative:true});
 s.recordLogLine({diagnostic:true,event:'off.by.default'});await s.flushLogs();await s.persistLogJournal();
 assert.equal(payloads.length,0);assert.equal(s.logShippingState().pending,0);assert.equal(s.logShippingState().userAllowed,false);
 assert.deepEqual(db.tpDiagnosticJournalV1.records,[]);
 s.setDiagnosticsUploadAllowed(true);s.recordLogLine({diagnostic:true,event:'after.switch.on'});await s.flushLogs();
 assert.equal(payloads.length,1);assert.deepEqual(payloads[0].records.map(r=>r.event),['after.switch.on']);
 s.setDiagnosticsUploadAllowed(false);s.recordLogLine({diagnostic:true,event:'after.switch.off'});await s.flushLogs();
 assert.equal(payloads.length,1);assert.equal(s.logShippingState().pending,0);
 s.setLogShippingEnabled(false,null,'http://localhost:7860');await s.persistLogJournal();
 db={};payloads=[];
 done('Diagnostics switch off (default): nothing recorded, kept or shipped; on ships; off again stops');
}
{
 const s=await fresh();await s.initializeLogJournal('http://localhost:7860');
 s.recordLogLine({diagnostic:true,event:'otp.click',email:'private@example.com',otp_code:'123456',body:'PRIVATE-SENTINEL',token:'PRIVATE-SENTINEL'});
 await s.persistLogJournal();
 assert.equal(payloads.length,0);assert.equal(s.logShippingState().pending,1);
 assert(!JSON.stringify(db).includes('PRIVATE-SENTINEL'));assert(!JSON.stringify(db).includes('123456'));assert(!JSON.stringify(db).includes('private@example.com'));
 done('Before metadata, explicit diagnostics persist privately without transmission');
 s.setLogShippingEnabled(true,()=> 'http://localhost:7860','http://localhost:7860',{authoritative:true});
 await s.flushLogs();assert.equal(s.logShippingState().pending,0);assert.equal(payloads.length,1);
 done('TP_LOG_FILE advertised by meta flushes before any translation/TP_TRACE handshake');
 s.setLogShippingEnabled(false,null,'http://localhost:7860');await s.persistLogJournal();
}
{
 db={};payloads=[];
 const s=await fresh();await s.initializeLogJournal('http://localhost:7860');s.setLogShippingEnabled(true,()=> 'http://localhost:7860','http://localhost:7860',{authoritative:true});
 globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({detail:{code:'diagnostic_write_failed'}})});
 s.recordLogLine({diagnostic:true,event:'keep_for_retry'});await s.flushLogs();
 assert.equal(s.logShippingState().pending,1);assert(s.logShippingState().enabled);
 done('Disk failure / generic 503 retains records instead of disabling logging');
 await s.persistLogJournal();
 const restored=await fresh();await restored.initializeLogJournal('http://localhost:7860');
 assert.equal(restored.logShippingState().pending,1);assert(restored.logShippingState().enabled);
 s.setLogShippingEnabled(false,null,'http://localhost:7860');
 globalThis.fetch=async(url,opt)=>{payloads.push({url,...JSON.parse(opt.body)});return{ok:true,json:async()=>({ok:true})};};
 await restored.flushLogs();assert.equal(payloads.length,1);assert.equal(restored.logShippingState().pending,0);
 done('Worker restart restores the same run/n event and flushes when API returns');
 restored.setLogShippingEnabled(false,null,'http://localhost:7860');
}
{
 db={};const s=await fresh();await s.initializeLogJournal('http://localhost:7860');s.setLogShippingEnabled(true,()=> 'http://localhost:7860','http://localhost:7860',{authoritative:true});
 globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({detail:{code:'diagnostic_logging_disabled'}})});
 s.recordLogLine({diagnostic:true,event:'off'});await s.flushLogs();assert(!s.logShippingState().enabled);assert.equal(s.logShippingState().pending,0);
 done('Explicit server logging-disabled response stops shipping');
 s.setLogShippingEnabled(true,()=> 'http://localhost:7860','http://localhost:7860',{authoritative:true});assert(s.logShippingState().enabled);
 done('Fresh metadata can re-enable logging after API restart');
 s.setLogShippingEnabled(false,null,'http://localhost:7860');await s.persistLogJournal();
}
{
 db={};writes=0;const s=await fresh();await s.initializeLogJournal('http://localhost:7860');
 const before=writes;for(let i=0;i<2000;i++)s.recordLogLine({diagnostic:true,event:'bounded',i});
 await s.persistLogJournal();assert.equal(s.logShippingState().pending,400);assert.equal(s.logShippingState().dropped,1600);assert(writes-before<=3);
 done('Overflow is counted; persistence coalesces bursts rather than retaining thousands of storage writes');
 await s.initializeLogJournal('https://other.example/api');assert.equal(s.logShippingState().pending,0);
 done('Changing API discards old-scoped diagnostic records; never ships them to another operator');
}
{
 db={};const s=await fresh();await s.initializeLogJournal('http://localhost:7860');s.recordLogLine({diagnostic:true,event:'offline'});
 const oldSet=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw Error('quota');};
 await s.persistLogJournal();assert(s.logShippingState().storageFailures>0);assert.equal(s.logShippingState().pending,1);
 done('Storage quota failure is visible and does not discard in-memory evidence');chrome.storage.local.set=oldSet;
}
{
 const d=await import('../src/shared/diagnostics.js');const events=[];d.setDiagnosticSink(r=>events.push(r));
 let sent;
 globalThis.fetch=async(_url,opt)=>{sent=opt;return{status:200,ok:true,headers:new Headers({'X-Request-ID':'rid-from-api'})};};
 const response=await d.diagnosticFetch('http://localhost:7860/paid/auth/request',{method:'POST',body:JSON.stringify({email:'private@example.com',code:'123456'}),headers:{Authorization:'Bearer PRIVATE-SENTINEL','X-TP-Trace-ID':'shared-trace'}});
 assert.equal(sent.headers.Authorization,'Bearer PRIVATE-SENTINEL');assert.equal(response.tpTraceId,'shared-trace');assert.equal(events[1].request_id,'rid-from-api');
 assert(!JSON.stringify(events).includes('PRIVATE-SENTINEL'));assert(!JSON.stringify(events).includes('private@example.com'));assert(!JSON.stringify(events).includes('123456'));
 done('HTTP diagnostics preserve request semantics, trace headers and response ID without body/session/OTP');
 globalThis.fetch=async()=>{throw new TypeError('raw PRIVATE-SENTINEL');};
 await assert.rejects(d.diagnosticFetch('http://localhost:7860/paid/me'),TypeError);
 assert.equal(events.at(-1).error_type,'TypeError');assert(!JSON.stringify(events).includes('PRIVATE-SENTINEL'));
 done('Browser network exception emits safe error class, elapsed time and trace before propagating');d.setDiagnosticSink(null);
}
console.log(JSON.stringify({scope:'Production modules; mocked chrome.storage and fetch, not a real browser restart',passed:checks.length,checks},null,2));
if(process.env.TP_TEST_REPORT)fs.writeFileSync(process.env.TP_TEST_REPORT,JSON.stringify({passed:checks.length,checks},null,2));
