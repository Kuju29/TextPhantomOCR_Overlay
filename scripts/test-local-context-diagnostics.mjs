import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {rejectedBudgetDiagnostic} from '../src/shared/ai/request-diagnostics.js';
import {note,flushTrace,setTracingEnabled} from '../src/shared/trace.js';
import '../src/shared/diagnostic-schema.js';
const rows=['initial','repair'].map(attemptKind=>rejectedBudgetDiagnostic({diagnostics:{constraint:'context_window',estimatedInput:8870,estimatedOutput:100,completionAvailable:0,contextLimit:2048,modelContext:2048,runtimeContext:2048,requestedContext:2048,contextCeiling:2048,contextRequired:9354,contextPolicy:'ollama-request-context-v1',contextReason:'bounded_limit',estimateKind:'script_weight_with_output_calibration'}},{attemptKind,pageUnits:12,operationId:'ai:'+'a'.repeat(32)}));
const fetch=globalThis.fetch,ships=[];
try{
 globalThis.fetch=async(_u,init)=>{ships.push(JSON.parse(init.body));return {ok:true,status:200,json:async()=>({ok:true})};};
 setTracingEnabled(true,()=> 'http://fixture','compact','fixture-session');
 for(const row of rows)note('local-context','context-budget-test',{...row,prompt:'PRIVATE_TEST',api_key:'hf_PRIVATE_TEST'});
 await flushTrace();
}finally{setTracingEnabled(false);globalThis.fetch=fetch;}
assert.equal(ships.length,1);
const result=spawnSync('python',['-c',String.raw`
import os,sys,json,tempfile,asyncio
from pathlib import Path
with tempfile.TemporaryDirectory() as temp:
 os.environ.update(TP_TRACE='compact',TP_TRACE_DIR=temp,TP_TRACE_CONTENT='0')
 sys.path.insert(0,'api')
 from backend import trace
 from backend.api.routes import logs
 from fastapi import FastAPI
 import httpx
 trace.start_session();payload=json.load(sys.stdin);payload['traceSession']=trace.session_id()
 app=FastAPI();app.include_router(logs.router)
 async def run():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
   a=await client.post('/v1/trace',json=payload);b=await client.post('/v1/trace',json=payload)
   assert a.json()['written']==2,a.text
   assert b.json()['written']==0,b.text
 asyncio.run(run());trace.flush()
 text='\n'.join(p.read_text() for p in Path(temp).glob('trace-*.jsonl'))
 records=[json.loads(x) for x in text.splitlines() if x]
 rows=[r['d'] for r in records if r.get('fn')=='context-budget-test']
 assert len(rows)==2
 for row in rows:
  assert row['requestDispatched'] is False and row['requestUnits']==0
  assert row['planned']['contextLimit']==2048 and row['planned']['modelContext']==2048
  assert row['planned']['contextReason']=='bounded_limit'
  assert row['estimateKind']=='script_weight_with_output_calibration'
  assert row['planned']['inputLimit'] is None
 assert 'PRIVATE_TEST' not in text
 print('PASS initial/repair context evidence: real JS shipping -> API HTTP ingestion -> disk trace; dedupe and privacy')
`],{input:JSON.stringify(ships[0]),encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);console.log(result.stdout.trim());
