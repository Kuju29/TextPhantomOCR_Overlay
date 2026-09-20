/** Actual ledger commits -> typed worker shipment -> API sanitizer/file.
 * No provider calls. Regression for requested-vs-serving-model trace lookup. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {persistProviderGeneration,currentUsage,flushUsageReceiptJournal} from '../src/shared/ai-usage.js';
import {shortenValue,setTracingEnabled,note,flushTrace} from '../src/shared/trace.js';
const stored={}, originalChrome=globalThis.chrome, originalFetch=globalThis.fetch;
const delta=[], sent=[];
try {
 globalThis.chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get(keys,cb){cb({...keys,...stored});},set(value,cb){Object.assign(stored,value);cb?.();}}}};
 const target={runtime:'cloud',provider:'huggingface',model:'deepseek-ai/DeepSeek-V4-Flash-0731'};
 const event={...target,model:'deepseek-v4-flash-0731',requestedModel:target.model,
  traceId:'tabcdefgh123',operationId:'ai:'+'b'.repeat(32),
  usage:{inputTokens:3000,outputTokens:100,totalTokens:3100,cachedInputTokens:1024,thinkingTokens:0,receiptId:'receipt-one'},success:true};
 await persistProviderGeneration(event,{emitTrace:(_label,d)=>delta.push(d)});
 await persistProviderGeneration({...event,operationId:'ai:'+'c'.repeat(32),usage:{...event.usage,receiptId:'receipt-two'}},{emitTrace:(_label,d)=>delta.push(d)});
 await persistProviderGeneration(event,{emitTrace:(_label,d)=>delta.push(d)});
 await flushUsageReceiptJournal();
 assert.equal(currentUsage(stored.aiUsageV1,target).totalTokens,6200,'cached input is included, not subtracted');
 assert.deepEqual(delta.map(d=>d.afterRequests),[1,2,2], 'trace looks up the same requested-model ledger key as its writer');
 assert.deepEqual(delta.map(d=>d.beforeRequests),[0,1,2]);
 assert.deepEqual(delta.map(d=>d.afterTotalTokens),[3100,6200,6200]);
 assert.deepEqual(delta.map(d=>d.totalTokens),[3100,3100,3100], 'nested usage is visible in trace');
 assert.deepEqual(delta.map(d=>d.deduplicated),[false,false,true]);
 for(const d of delta) {
  const safe=shortenValue({...d,api_key:'PRIVATE_KEY',prompt:'PRIVATE_OCR'});
  for(const k of ['schema','event','inputTokens','outputTokens','totalTokens','beforeRequests','afterRequests','beforeTotalTokens','afterTotalTokens','deduplicated'])assert.deepEqual(safe[k],d[k],k);
  assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_/);
 }
 globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return new Response('{"ok":true}',{status:200});};
 setTracingEnabled(true,()=> 'http://fixture','compact','usage-fixture');
 delta.forEach(d=>note('fixture','ledger-proof',d,'tabcdefgh123'));
 await flushTrace();setTracingEnabled(false);
 assert.equal(sent.length,1);
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
 trace._ROOT=Path(temp)
 app=FastAPI();app.include_router(router)
 payload=json.load(sys.stdin);payload['traceSession']=trace.session_id()
 async def send():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
   a=await c.post('/v1/trace',json=payload);b=await c.post('/v1/trace',json=payload)
   assert a.status_code==200 and b.status_code==200,(a.text,b.text)
   assert b.json()['written']==0,b.text
 asyncio.run(send());trace.flush()
 text='\n'.join(p.read_text() for p in Path(temp).glob('*.jsonl'))
 rows=[json.loads(line)['d'] for line in text.splitlines() if line and json.loads(line).get('fn')=='ledger-proof']
 assert [r['afterRequests'] for r in rows]==[1,2,2],rows
 assert [r['afterTotalTokens'] for r in rows]==[3100,6200,6200],rows
 assert [r['totalTokens'] for r in rows]==[3100,3100,3100],rows
 assert all(r['event']=='usage_ledger' for r in rows)
 assert [r['deduplicated'] for r in rows]==[False,False,True]
 assert 'PRIVATE_' not in text
 print('PASS 3 ledger deltas preserved through HTTP ingest; duplicate shipment writes zero')
`],{cwd:new URL('..',import.meta.url),input:JSON.stringify(sent[0]),encoding:'utf8'});
 assert.equal(child.status,0,child.stderr||child.stdout);console.log(child.stdout.trim());
} finally {setTracingEnabled(false);globalThis.chrome=originalChrome;globalThis.fetch=originalFetch;}
console.log('PASS requested/served alias, nested usage, duplicate receipt, totals inclusive of cache, and compact trace evidence');
