import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {note,flushTrace,setTracingEnabled,shortenValue} from '../src/shared/trace.js';
import {rememberDiagnostic,recentDiagnostic,clearRecentDiagnostics} from '../src/background/ai/recent-diagnostics.js';
import {formatRequestDiagnostic} from '../src/shared/ai/diagnostic-view.js';
const event={schema:'tp.conversation/1',mode:'conversation',path:'conversation',phase:'finished',policy:'conversation-immutable-anchor-2026.9.15.2',
 scope:'a'.repeat(24),scopeStatus:'ready',historyRevision:2,turnIndex:3,historyTurns:2,historyMessages:4,historyChars:1000,
 historyEstimatedTokens:300,estimatedInput:3300,currentUserChars:100,staticUserRepeated:false,queueWaitMs:35.5,trimmedTurns:0,
 rolloverReason:'request_profile_changed',historySha256:'b'.repeat(64),prefixSha256:'c'.repeat(64),branch:'initial',orderPolicy:'document_enqueue',
 commitStatus:'committed',providerCacheStatus:'reported_zero',storage:'api_sqlite',historyQuality:'structural_and_script_checks_not_human_approved',
 historyMessageRoles:'user,assistant,user,assistant',contextLimit:32768,outputReserve:640,providerCallsAdded:0,legacyFallback:false,
 cachedInputTokens:0,actualInputTokens:3300,actualOutputTokens:100,pageOrder:3,
 planner:'conversation_cross_page',pageCount:3,unitCount:18,formattingWhitespaceChars:34,unexpectedProseChars:0,
 prompt:'PRIVATE_CONTENT',api_key:'PRIVATE_KEY',history:['PRIVATE_HISTORY'],unknownCount:99};
const safe=shortenValue(event);assert.equal(safe.commitStatus,'committed');assert.equal(safe.rolloverReason,'request_profile_changed');
assert.equal(safe.cachedInputTokens,0);assert.ok(Object.keys(safe).length>30);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);
rememberDiagnostic({provider:'huggingface',model:'fixture',operationId:'ai:'+'a'.repeat(32),conversation:event,result:{schema:'tp.audit/1',event:'translation_result',resultStatus:'complete_at_contract_boundary',actualInput:3300,actualOutput:100}});
const row=recentDiagnostic('huggingface','fixture');assert.equal(row.conversation.historyTurns,2);assert.match(formatRequestDiagnostic(row),/Conversation/);assert.doesNotMatch(formatRequestDiagnostic(row),/PRIVATE|prefixSha|committed/);clearRecentDiagnostics();
const batch={schema:'tp.conversation_batch/1',batchId:'11111111-1111-4111-8111-111111111111',phase:'distributed',planner:'conversation_cross_page',pageCount:3,unitCount:18,readyPageCount:4,readyUnitCount:22,splitReason:'learned_output_target',queueReason:'ready',firstOrder:1,lastOrder:3,estimatedInput:5000,predictedOutput:1024,mappedUnits:18,cancelledUnits:0,missingUnits:0,providerCallsAdded:0,providerRequestCount:1,usageOwner:'provider_request',requestMs:90,readyQueueWaitMs:30,previousTurnWaitMs:20,sourceOrderWaitMs:10,legacyFallback:false,prompt:'PRIVATE'};
const rejected={...batch,phase:'failed',mappingStatus:'rejected',idPolicy:'source_opaque_wire_pn',failureCode:'ai_conversation_origin_invalid',failureStage:'conversation_mapping',validationField:'conversation.origins.1.originalIds.0',validationReason:'invalid_source_id',providerRequestCount:0,requestDispatched:false,apiHttpStatus:400};
const rejectedSafe=shortenValue(rejected);assert.equal(rejectedSafe.validationField,rejected.validationField);assert.equal(rejectedSafe.providerRequestCount,0);
const batchSafe=shortenValue(batch);assert.equal(batchSafe.previousTurnWaitMs,20);assert.equal(batchSafe.usageOwner,'provider_request');
const old=globalThis.fetch,shipments=[];
try{
 globalThis.fetch=async(_u,init)=>{shipments.push(JSON.parse(init.body));return {ok:true,status:200,json:async()=>({ok:true})};};
 setTracingEnabled(true,()=> 'http://fixture','compact','conversation-fixture');note('conversation-fixture','conversation-proof',event,'tconversation123');note('conversation-fixture','conversation-batch-proof',batch,'tconversation123');note('conversation-fixture','conversation-rejection-proof',rejected,'tconversation123');await flushTrace();
}finally{setTracingEnabled(false);globalThis.fetch=old;}
assert.equal(shipments.length,1);
const python=spawnSync('python',['-c',String.raw`
import sys,json,tempfile,os,asyncio
from pathlib import Path
sys.path.insert(0,'api')
with tempfile.TemporaryDirectory() as temp:
 os.environ.update(TP_TRACE='compact',TP_TRACE_DIR=temp,TP_TRACE_CONTENT='0')
 from backend import trace
 from backend.api.routes.logs import router
 from backend.diagnostic_schema import sanitize_conversation
 from fastapi import FastAPI
 import httpx
 trace.start_session();app=FastAPI();app.include_router(router)
 data=json.load(sys.stdin);payload=data['shipment'];payload['traceSession']=trace.session_id()
 assert sanitize_conversation(data['dirty'])==data['safe']
 async def run():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
   a=await c.post('/v1/trace',json=payload);b=await c.post('/v1/trace',json=payload)
   assert a.status_code==b.status_code==200,(a.text,b.text)
   assert b.json()['written']==0,b.text
 asyncio.run(run());trace.flush()
 text='\n'.join(p.read_text() for p in Path(temp).glob('*.jsonl'))
 rows=[json.loads(s)['d'] for s in text.splitlines() if s and json.loads(s).get('fn')=='conversation-proof']
 assert len(rows)==1,rows
 d=rows[0];assert d==data['safe'],(d,data['safe'])
 assert d['historyMessages']==4 and d['cachedInputTokens']==0 and d['contextLimit']==32768
 assert len(d)>30 and 'PRIVATE' not in text
 assert d['formattingWhitespaceChars']==34 and d['unexpectedProseChars']==0 and d['pageCount']==3
 batches=[json.loads(s)['d'] for s in text.splitlines() if s and json.loads(s).get('fn')=='conversation-batch-proof']
 assert batches==[data['batchSafe']],batches
 rejected=[json.loads(s)['d'] for s in text.splitlines() if s and json.loads(s).get('fn')=='conversation-rejection-proof']
 assert rejected==[data['rejectedSafe']],rejected
 assert rejected[0]['providerRequestCount']==0 and rejected[0]['requestDispatched'] is False
 assert rejected[0]['validationField']=='conversation.origins.1.originalIds.0'
 assert len(batches[0])>20 and batches[0]['sourceOrderWaitMs']==10
 print('PASS conversation diagnostics: actual JS -> HTTP ASGI -> JSONL, >30 fields, zero/unknown, history provenance, dedupe, secret redaction')
`],{input:JSON.stringify({shipment:shipments[0],dirty:event,safe,batchSafe,rejectedSafe}),encoding:'utf8'});
assert.equal(python.status,0,python.stderr||python.stdout);console.log(python.stdout.trim());
