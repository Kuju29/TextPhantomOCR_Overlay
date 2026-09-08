/** Real trace module with virtual clock/network; includes idle-tail recovery. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root=process.env.TP_TEST_ROOT || process.cwd();
const source=readFileSync(path.join(root,'src/shared/trace.js'),'utf8');
const results=[];
const microtasks=async()=>{for(let n=0;n<40;n++)await Promise.resolve();};
function harness(){
  let clock=100_000,id=0,send=async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})});
  const timers=new Map(),sent=[],warnings=[];
  const ctx={TextEncoder,TextDecoder,URL,AbortController,DOMException,Math,
    Date:class extends Date{static now(){return clock;}},
    crypto:{randomUUID:()=> 'fixture-producer'},chrome:{runtime:{getManifest:()=>({version:'test'})}},
    console:{warn:(...v)=>warnings.push(v),error:(...v)=>warnings.push(v)},
    setTimeout:(fn,delay)=>{const key=++id;timers.set(key,{at:clock+delay,fn});return key;},
    clearTimeout:key=>timers.delete(key),
    fetch:async(url,init)=>{sent.push({url,init,body:JSON.parse(init.body),at:clock});return send(url,init);},
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(root,'src/shared/diagnostic-schema.js'),'utf8'),ctx);
  vm.runInContext(source.replace(/^import .*?;\s*$/gm,'').replace(/^export /gm,'')+'\nglobalThis.api={note,flushTrace,setTracingEnabled,isTracing,resetTracingForBaseChange,traceRelay,getTraceShippingState:typeof getTraceShippingState==="function"?getTraceShippingState:null};',ctx);
  const api=ctx.api;
  const advance=async ms=>{
    const until=clock+ms;
    for(let i=0;i<5000;i++){
      await microtasks();
      const next=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next){clock=until;await microtasks();return;}
      clock=next[1].at;timers.delete(next[0]);next[1].fn();
    }
    throw new Error('timer storm');
  };
  const enable=(getBase=()=> 'http://fixture.invalid',refresh=null)=>api.setTracingEnabled(true,getBase,'compact','s',refresh);
  return {api,sent,warnings,timers,advance,enable,setSend:f=>send=f,now:()=>clock,
    state:()=>JSON.parse(JSON.stringify(api.getTraceShippingState()))};
}
async function test(name,fn){try{await fn();results.push({name,pass:true});console.log('PASS '+name);}catch(error){results.push({name,pass:false,error:error.stack});console.error('FAIL '+name+': '+error.message);}}
await test('lost ACK retries identical records and identical shipment identity',async()=>{
  const h=harness();let calls=0;h.setSend(async()=>{if(++calls===1)throw new Error('lost ack');return {ok:true,status:200,json:async()=>({ok:true,session:'s'})};});
  h.enable();h.api.note('fixture','start');await h.api.flushTrace();await h.api.flushTrace();
  assert.equal(h.sent.length,2);assert.equal(h.sent[0].body.shipmentId,h.sent[1].body.shipmentId);
  assert.deepEqual(h.sent[0].body.records,h.sent[1].body.records);assert.equal(h.state().buffer.queued,0);
  assert.equal(h.state().transport.acknowledged,1);assert.equal(h.state().transport.totalFailures,1);
});
await test('three failures keep opt-in and recover idle terminal suffix without handshake',async()=>{
  const h=harness();h.enable();h.setSend(async()=>{throw new Error('Bearer SENTINEL_SECRET_FAILURE');});
  h.api.note('repair','applying');for(let i=0;i<3;i++)await h.api.flushTrace();
  assert.equal(h.api.isTracing(),true);assert.equal(h.state().state,'backoff');
  h.api.note('repair','repairPatch',{applied:true});h.api.note('repair','done',{repaired:12,unresolved:1});
  for(let i=0;i<200;i++)await h.api.flushTrace();assert.equal(h.sent.length,3,'events cannot bypass cooldown');
  h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})}));
  await h.advance(4999);assert.equal(h.sent.length,3);await h.advance(1);
  assert.equal(h.sent.length,4);assert.equal(h.state().buffer.queued,0);assert.equal(h.state().state,'active');
  assert.deepEqual(h.sent.at(-1).body.records.map(r=>r.fn),['applying','repairPatch','done']);
  assert.equal(h.sent.at(-1).body.shipping.transport.totalFailures,3);
  assert.equal(h.warnings.length,0);assert.doesNotMatch(JSON.stringify(h.sent),/SENTINEL_SECRET_FAILURE/);
});
await test('generic gateway 503 retries; only explicit trace_disabled stops',async()=>{
  const h=harness();h.enable();h.setSend(async()=>({ok:false,status:503,json:async()=>{throw new Error('HTML gateway');}}));
  h.api.note('fixture','one');await h.api.flushTrace();assert.equal(h.api.isTracing(),true);assert.equal(h.state().buffer.queued,1);
  h.setSend(async()=>({ok:false,status:503,json:async()=>({detail:{code:'trace_disabled'}})}));
  await h.api.flushTrace();assert.equal(h.api.isTracing(),false);assert.equal(h.state().buffer.queued,0);
  await h.advance(100_000);assert.equal(h.sent.length,2);assert.equal(h.timers.size,0);
});
await test('HTTP 200 with invalid JSON/negative ACK cannot silently drop records',async()=>{
  for(const reply of [null,{ok:false},{ok:true,session:'foreign'}]){
    const h=harness();h.enable();h.setSend(async()=>({ok:true,status:200,json:async()=>reply}));
    h.api.note('fixture','final');await h.api.flushTrace();assert.equal(h.state().buffer.queued,1);
    assert.equal(h.state().transport.lastCode,'invalid_ack');assert.equal(h.state().transport.acknowledged,0);
  }
});
await test('dead endpoint backoff caps at 30 seconds and queue stays bounded with explicit losses',async()=>{
  const h=harness();h.enable();h.setSend(async()=>{throw new Error('offline');});
  h.api.note('fixture','first');for(let n=0;n<3;n++)await h.api.flushTrace();
  for(let n=0;n<4100;n++)h.api.note('fixture','queued',{n});h.api.note('repair','done',{repaired:12,unresolved:1});
  assert.equal(h.state().buffer.queued,4000);assert.equal(h.state().buffer.dropped,102);
  await h.advance(100_000);assert(h.sent.length<=9,'bounded probes, not retry per trace event');
  assert(h.state().transport.retryAt-h.now()<=30_000);
  h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})}));await h.advance(150_000);
  assert.equal(h.state().buffer.queued,0);assert.equal(h.state().buffer.dropped,0);
  assert(h.sent.some(s=>s.body.records.some(r=>r.fn==='done')));assert(h.sent.some(s=>s.body.droppedSinceLastBatch===102));
  assert(h.sent.every(s=>Buffer.byteLength(s.init.body)<=48*1024));assert(h.sent.every(s=>s.init.keepalive===false));
});
await test('verbose flood preserves earlier critical decisions and reports dropped records',async()=>{
  const h=harness();h.enable();h.setSend(async()=>{throw new Error('offline');});
  h.api.note('fixture','profile',{schema:'tp.audit/1',event:'workload_profile',reason:'loaded'});
  for(let i=0;i<3;i++)await h.api.flushTrace();
  for(let i=0;i<4200;i++)h.api.note('fixture','geometry',{schema:'tp.audit/1',event:'geometry_snapshot',reason:'source_geometry',totalRows:i});
  h.api.note('repair','done',{repaired:1,unresolved:1});
  assert.equal(h.state().buffer.queued,4000);assert.equal(h.state().buffer.dropped,202);
  h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})}));
  await h.advance(200_000);
  assert(h.sent.some(s=>s.body.records.some(r=>r.fn==='profile')));
  assert(h.sent.some(s=>s.body.records.some(r=>r.fn==='done')));
  assert(h.sent.some(s=>s.body.droppedSinceLastBatch===202));
  assert.equal(h.state().buffer.queued,0);assert.equal(h.warnings.length,0);
});
await test('hung asynchronous base lookup releases shipper on deadline',async()=>{
  const h=harness();h.enable(()=>new Promise(()=>{}));h.api.note('fixture','base');
  const pending=h.api.flushTrace();await h.advance(10_000);await pending;
  assert.equal(h.state().transport.lastCode,'deadline_exceeded');assert.equal(h.state().buffer.queued,1);
  h.enable();await h.api.flushTrace();assert.equal(h.state().buffer.queued,0);
});
await test('hung response body releases shipper and late response never acknowledges',async()=>{
  const h=harness();let finish;h.enable();h.setSend(async()=>({ok:true,status:200,json:()=>new Promise(r=>finish=r)}));
  h.api.note('repair','done');const pending=h.api.flushTrace();await microtasks();await h.advance(10_000);await pending;
  assert.equal(h.state().transport.acknowledged,0);assert.equal(h.state().transport.lastCode,'deadline_exceeded');
  finish({ok:true,session:'s'});await microtasks();assert.equal(h.state().buffer.queued,1);
  h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})}));await h.api.flushTrace();assert.equal(h.state().buffer.queued,0);
});
await test('lost old-session ACK cannot erase new records or disable new tracing',async()=>{
  const h=harness();let finish;h.enable();h.setSend(()=>new Promise(r=>finish=r));h.api.note('fixture','old');
  const pending=h.api.flushTrace();await microtasks();
  h.api.setTracingEnabled(true,()=> 'http://fixture.invalid','compact','new');h.api.note('fixture','new');
  finish({ok:false,status:503,json:async()=>({detail:{code:'trace_disabled'}})});await pending;
  assert.equal(h.api.isTracing(),true);h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'new'})}));await h.api.flushTrace();
  assert.equal(h.sent.at(-1).body.records.length,1);assert.equal(h.sent.at(-1).body.records[0].fn,'new');assert.equal(h.sent.at(-1).body.droppedSinceLastBatch,1);
});
await test('session mismatch refresh quarantines old records and keeps an explicit gap',async()=>{
  const h=harness();h.enable(undefined,async()=>({trace:true,traceSession:'new',traceDetail:'compact'}));
  h.setSend(async()=>({ok:false,status:409,json:async()=>({detail:{code:'trace_session_mismatch',currentSession:'new'}})}));
  h.api.note('fixture','old');await h.api.flushTrace();
  h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'new'})}));h.api.note('repair','done');await h.api.flushTrace();
  assert.equal(h.sent.at(-1).body.traceSession,'new');assert.equal(h.sent.at(-1).body.records.length,1);assert.equal(h.sent.at(-1).body.droppedSinceLastBatch,1);
});
await test('failed session-refresh is recoverable, never treated as trace=false',async()=>{
  const h=harness();h.enable(undefined,async()=>{throw new Error('offline');});h.api.note('fixture','one');
  h.setSend(async()=>({ok:false,status:409,json:async()=>({detail:{currentSession:'unconfirmed'}})}));await h.api.flushTrace();
  assert.equal(h.api.isTracing(),true);assert.equal(h.state().buffer.queued,1);
});
await test('reset to another API base clears old queued/sensitive evidence and cooldown',async()=>{
  const h=harness();h.enable();h.setSend(async()=>{throw new Error('offline');});h.api.note('fixture','private-old');
  for(let n=0;n<3;n++)await h.api.flushTrace();h.api.resetTracingForBaseChange();
  assert.equal(h.state().state,'unnegotiated');assert.equal(h.state().buffer.queued,0);assert.equal(h.timers.size,0);
  h.api.note('fixture','new-prefix');await h.advance(60_000);assert.equal(h.sent.length,3,'no upload before opt-in');
  h.enable();h.setSend(async()=>({ok:true,status:200,json:async()=>({ok:true,session:'s'})}));await h.api.flushTrace();
  assert.deepEqual(h.sent.at(-1).body.records.map(r=>r.fn),['new-prefix']);
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
process.exitCode=results.some(r=>!r.pass)?1:0;
