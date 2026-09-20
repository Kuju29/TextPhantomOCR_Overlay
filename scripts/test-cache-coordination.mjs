/** Local runtime stays passive; actual loopback HTTP, typed trace shipment and API ingest. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createOllamaAdapter} from '../src/shared/ai/providers/local-ollama.js';
import {observeLocalPrefix,createLocalPrefixObserver} from '../src/shared/ai/cache-coordination.js';
import {shortenValue,setTracingEnabled,note,flushTrace} from '../src/shared/trace.js';
import {rememberDiagnostic,recentDiagnostic,clearRecentDiagnostics} from '../src/background/ai/recent-diagnostics.js';
import {formatRequestDiagnostic} from '../src/shared/ai/diagnostic-view.js';
const calls=[],events=[],wire=[];
const server=http.createServer(async(req,res)=>{
 let text='';for await(const c of req)text+=c;calls.push(JSON.parse(text));
 res.writeHead(200,{'content-type':'application/x-ndjson'});
 res.end(JSON.stringify({message:{content:'<<TP_P0:Hello>>'}})+'\n'+JSON.stringify({done:true,done_reason:'stop',prompt_eval_count:3000,eval_count:10})+'\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}`,layout={staticPrefixSha256:'a'.repeat(64),targetLang:'th',sourceLang:'en'};
let final;
try{
 const adapter=createOllamaAdapter({baseUrl:url});
 const request={model:'fixture-local',messages:[{role:'system',content:'STYLE_UNCHANGED'},{role:'user',content:'<<TP_P0:Hello>>'}],outputTokens:512,thinkingMode:'off',thinkingCapability:{supported:true,control:'boolean'},contextTokens:12288};
 const ctx={expectedIds:['P0'],cacheContext:layout,cacheRevision:'digest1',trace:(_event,v)=>events.push(v),wireTrace:(event,v)=>wire.push([event,v])};
 const first=await adapter.generate(request,ctx),second=await adapter.generate(request,ctx);
 assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[0],adapter.payload(request));
 assert.equal(first.cacheCoordination.mode,'runtime_managed');assert.equal(first.cacheCoordination.role,'leader');
 assert.equal(second.cacheCoordination.role,'leader');assert.equal(second.cacheCoordination.groupId,first.cacheCoordination.groupId);
 assert.equal(second.cacheCoordination.previousCompletions,1);assert.equal(second.cacheCoordination.waitMs,0);
 assert.equal(second.cacheCoordination.cacheStatus,'not_reported');assert.equal(second.cacheCoordination.cachedInputTokens,null);
 assert.equal(calls[0].think,false);assert.equal(calls[0].options.num_ctx,12288);assert.equal(calls[0].options.temperature,.2);
 const japanese=await adapter.generate(request,{...ctx,cacheContext:{...layout,targetLang:'ja',staticPrefixSha256:'b'.repeat(64)}});
 assert.notEqual(japanese.cacheCoordination.groupId,first.cacheCoordination.groupId);
 const back=await adapter.generate(request,ctx);assert.equal(back.cacheCoordination.groupId,first.cacheCoordination.groupId);assert.equal(back.cacheCoordination.role,'leader');
 const changed=await adapter.generate({...request,model:'other'},ctx);assert.notEqual(changed.cacheCoordination.groupId,back.cacheCoordination.groupId);
 const probe=await adapter.generate(request,{expectedIds:['P0']});assert.equal(probe.cacheCoordination,undefined,'discovery probe must not count as translation/cache leader');
 assert.equal(calls.length,6,'no extra warmup/discovery requests');
 const controller=new AbortController();controller.abort(new DOMException('Cancelled','AbortError'));
 await assert.rejects(adapter.generate(request,{...ctx,signal:controller.signal}),err=>err.cacheCoordination.requestDispatched===false);
 assert.equal(calls.length,6,'cancelled before dispatch remains not sent');
 assert.ok(events.some(e=>e.releaseReason==='leader_cancelled'));
 assert.ok(events.filter(e=>e.schema==='tp.cache_coordination/1').every(e=>e.waitMs===0&&e.providerCacheTtlMs===null));
 const args={url,model:'x',payload:{},layout};
 const one=await observeLocalPrefix({...args,headers:{Authorization:'PRIVATE_ACCOUNT'}}),two=await observeLocalPrefix({...args,headers:{Authorization:'PRIVATE_OTHER'}});
 assert.notEqual(one.snapshot().groupId,two.snapshot().groupId);
 one.dispatched();final=one.finish({cachedInputTokens:123,inputTokens:3000},true);
 assert.equal(final.cacheStatus,'reported_hit');assert.equal(final.providerCacheReady,null);
 assert.ok(wire.some(([event,v])=>event==='providerRequest'&&v.cacheCoordination));
}finally{server.closeAllConnections();server.close();await once(server,'close');}
// One sanitizer shared with both trace paths. Counterfeit readiness and secrets removed.
const dirty={...final,providerCacheReady:true,providerCacheTtlMs:100,operationId:'ai:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',api_key:'PRIVATE',prompt:'PRIVATE',endpoint:'PRIVATE'};
const safe=shortenValue(dirty);assert.equal(safe.providerCacheReady,null);assert.equal(safe.providerCacheTtlMs,null);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);assert.ok(Object.keys(safe).length>20);
const python=spawnSync('python',['-c',`import sys,json;sys.path.insert(0,'api');from backend.diagnostic_schema import sanitize_cache_coordination;print(json.dumps(sanitize_cache_coordination(json.load(sys.stdin))))`],{input:JSON.stringify(dirty),encoding:'utf8'});
assert.equal(python.status,0,python.stderr);assert.deepEqual(JSON.parse(python.stdout),safe,'JS/Python schema parity');
rememberDiagnostic({provider:'huggingface',model:'x',operationId:'ai:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',coordination:{...safe,waitMs:210},result:{schema:'tp.audit/1',event:'translation_result',resultStatus:'complete_at_contract_boundary',actualInput:3000,actualOutput:10,cachedInput:123}});
const row=recentDiagnostic('huggingface','x');assert.equal(row.coordination.waitMs,210);
assert.match(formatRequestDiagnostic(row),/Cache wait: 0.21 s/);assert.doesNotMatch(formatRequestDiagnostic(row),/PRIVATE|groupId|providerCacheReady|unknown/);clearRecentDiagnostics();
// Real JS shipment -> actual ASGI route -> actual temp JSONL; duplicate ACK safety.
const originalFetch=globalThis.fetch,shipments=[];
try{
 globalThis.fetch=async(_url,init)=>{shipments.push(JSON.parse(init.body));return new Response('{"ok":true}',{status:200});};
 setTracingEnabled(true,()=> 'http://fixture','compact','cache-fixture');
 note('fixture','cache-proof',dirty,'tcache123456');await flushTrace();setTracingEnabled(false);
 assert.equal(shipments.length,1);
 const child=spawnSync('python',['-c',String.raw`
import sys,json,tempfile,os,asyncio
from pathlib import Path
sys.path.insert(0,'api')
with tempfile.TemporaryDirectory() as temp:
 os.environ.update(TP_TRACE='1',TP_TRACE_DIR=temp,TP_LOG_DIR=temp)
 from backend import trace
 from backend.api.routes.logs import router
 from fastapi import FastAPI
 import httpx
 trace._ROOT=Path(temp);app=FastAPI();app.include_router(router)
 payload=json.load(sys.stdin);payload['traceSession']=trace.session_id()
 async def run():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
   a=await c.post('/v1/trace',json=payload);b=await c.post('/v1/trace',json=payload)
   assert a.status_code==200 and b.status_code==200,(a.text,b.text)
   assert b.json()['written']==0,b.text
 asyncio.run(run());trace.flush()
 text='\n'.join(p.read_text() for p in Path(temp).glob('*.jsonl'))
 rows=[json.loads(s)['d'] for s in text.splitlines() if s and json.loads(s).get('fn')=='cache-proof']
 assert len(rows)==1,rows
 d=rows[0];assert d['schema']=='tp.cache_coordination/1'
 assert d['cachedInputTokens']==123 and d['cacheStatus']=='reported_hit'
 assert d['providerCacheReady'] is None and d['missReason']=='unknown'
 assert d['providerCacheTtlMs'] is None and d['coordinationPolicy']=='observe_no_wait'
 assert d['leaderLeaseState']=='released' and d['observationRecorded'] is True
 assert d['operationId']=='ai:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' and d['staticPrefixSha256']=='a'*64,d
 assert len(d)>20 and 'PRIVATE' not in text
 print('PASS complete cache event (>20 fields), HTTP ingestion, deduplicated shipment and secret redaction')
`],{input:JSON.stringify(shipments[0]),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr||child.stdout);console.log(child.stdout.trim());
}finally{setTracingEnabled(false);globalThis.fetch=originalFetch;}
console.log('PASS Local loopback HTTP / model-language-account namespaces / cancellation / no extra requests / compact UI / cross-runtime trace');

// Independent statistics/active leases, no timers, late-result fences and rotation.
let now=0;const observer=createLocalPrefixObserver({clock:()=>now,leaseMs:100,maxGroups:1,maxActive:2});
const config={url:'http://localhost:11434',model:'x',payload:{},layout};
const a=await observer(config);a.dispatched();
const other=await observer({...config,model:'y'});
const b=await observer(config);b.dispatched();
assert.equal(b.snapshot().role,'observer');assert.equal(a.snapshot().leaderCoordinationId,b.snapshot().leaderCoordinationId);
a.finish({inputTokens:100,cachedInputTokens:10},true);assert.equal(a.snapshot().observationRecorded,false);
b.finish({inputTokens:100,cachedInputTokens:0},true);
const c=await observer(config);c.dispatched();assert.equal(c.snapshot().reason,'next_request');
now=101;const d=await observer(config);d.dispatched();assert.equal(d.snapshot().reason,'lease_expired');
d.finish({inputTokens:100,cachedInputTokens:5},true);c.finish({inputTokens:100,cachedInputTokens:0},true);
assert.equal(c.snapshot().releaseReason,'lease_superseded');assert.equal(c.snapshot().latestObservationApplied,false);
now=9999999;const e=await observer(config);assert.equal(e.snapshot().previousCacheHit,true);assert.equal(e.snapshot().retentionMs,null);
assert.equal(e.snapshot().waitMs,0);other.finish({},false);e.finish({},false);
console.log('PASS Local observation LRU independent of active lease / logical expiry / request-order fence / no wait');
