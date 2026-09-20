/** Page sanitizer -> real worker shipper -> real API ingest -> trace FILE. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import '../src/shared/diagnostic-schema.js';
import {traceRelay,setTracingEnabled,flushTrace,note,shortenValue} from '../src/shared/trace.js';
const sent=[],pageRecords=[];
const budget={schema:'tp.audit/1',event:'translation_budget',reason:'whole_page_fits',attemptKind:'initial',constraintScope:'per_request',wholePage:true,pageUnits:20,requestUnits:20,
 scope:{operationId:'ai:'+'a'.repeat(32)},planned:{estimatedInput:3000,estimatedOutput:600,reasoningReserve:0,contextLimit:32768},evidence:{hardFits:true,reliabilityFits:true}};
const requestResult={schema:'tp.audit/1',event:'translation_result',reason:'finished',attemptKind:'repair',resultStatus:'incomplete_ids',actualInput:2890,actualOutput:110,actualReasoning:0,
 cacheReported:false,cacheStatus:'not_reported',cachedInput:null,complete:false,missingCount:1,scope:budget.scope};

const localEvents=[
 {schema:'tp.audit/1',event:'stream_timing',reason:'stream_observed',operationId:'00000000-0000-4000-8000-000000000004',
  timing:{boundary:'transport_reader',framesObserved:3,contentChunks:2,firstContentMs:1000,lastContentMs:3375,
   lastFrameMs:3925,protocolTerminalMs:3925,streamEndedMs:3925,terminalKind:'protocol_done',maxInterFrameGapMs:2375,
   maxInterContentGapMs:2375,maxReadWaitMs:2000,tailAfterContentMs:550,frameProcessingMs:425,maxFrameProcessingMs:375,
   deltaCallbackMs:300,maxDeltaCallbackMs:250,wireWriteMs:125,maxWireWriteMs:125,text:'PRIVATE_RESPONSE'}},
 {schema:'tp.audit/1',event:'page_stream_timing',reason:'dom_acknowledged',operationId:'00000000-0000-4000-8000-000000000004',
  imageId:'00000000-0000-4000-8000-000000000005',runId:'00000000-0000-4000-8000-000000000006',
  generationId:'00000000-0000-4000-8000-000000000007',pageId:'00000000-0000-4000-8000-000000000008',
  pageOrder:2,recordsCompleteAt:1789900000000,streamRevision:11,validatedAt:1789900000001,validationMs:1,
  domEnqueuedAt:1789900000002,contentReceivedAt:1789900000004,renderStartedAt:1789900000004,renderFinishedAt:1789900000030,
  contentToAckMs:26,domQueueMs:2,complete:true,reused:false,source:'PRIVATE_OCR'},
 {schema:'tp.audit/1',event:'local_discovery',reason:'models_loaded',operationId:'00000000-0000-4000-8000-000000000001',connectionStage:'list_models',counts:{count:1},reused:false},
 {schema:'tp.audit/1',event:'local_discovery',reason:'failed',operationId:'00000000-0000-4000-8000-000000000002',connectionStage:'result',errorCode:'local_ai_unreachable',retryable:true,ready:false},
 {schema:'tp.audit/1',event:'local_discovery',reason:'ui_applied',operationId:'00000000-0000-4000-8000-000000000001',requestId:'00000000-0000-4000-8000-000000000003',connectionStage:'ui_apply',ready:true},
];
const scope={window:{__TP:{}},Element:class{},TextEncoder,Date,Math,crypto:globalThis.crypto,
 chrome:{runtime:{lastError:null,sendMessage:(msg,cb)=>{pageRecords.push(msg.record);cb?.();}}}};
vm.createContext(scope);
for(const file of ['src/shared/diagnostic-schema.js','src/content/trace.js'])vm.runInContext(readFileSync(file,'utf8'),scope);
scope.window.__TP.setTracingEnabled(true,'compact');
const event={schema:'tp.audit/1',event:'geometry_overlap',reason:'overlap_detected',sourceKind:'ai',
 totalRows:1,capturedRows:1,complete:true,rows:[{id:'p3',ref:'p8',x:.25,y:.3,w:.1,h:.1,text:'PRIVATE_OCR'}],
 api_key:'PRIVATE_KEY',scope:{traceId:'tabcdefgh123',imageId:'0123456789abcdef'},before:{outputTarget:180,recordTarget:10},after:{outputTarget:203,recordTarget:10}};
scope.window.__TP.traceNote('content/overlay/local-render.js','aiBlockOverlap',event);
assert.equal(pageRecords.length,1);assert.equal(pageRecords[0].d.rows[0].id,'p3');assert.equal(pageRecords[0].d.rows[0].ref,'p8');
globalThis.chrome={runtime:{getManifest:()=>({version:'test'})}};
globalThis.fetch=async(_u,init)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ok:true,session:'wire-fixture'}),{status:200});};
setTracingEnabled(true,()=> 'http://fixture.invalid','compact','wire-fixture');
traceRelay(pageRecords[0]);note('fixture','decision',event,'tabcdefgh123');
for(const item of [budget,requestResult,...localEvents])note('fixture','requestEvidence',item,'tabcdefgh123');
await flushTrace();setTracingEnabled(false);
assert.equal(sent.length,1);assert.equal(sent[0].records.length,9);assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_/);
const malicious={...event,reason:'https://PRIVATE_URL/key',rows:[{id:'Bearer PRIVATE_KEY',ref:'p2',x:Infinity,rotation:NaN}],before:{outputTarget:'PRIVATE_OCR'}};
const safe=shortenValue(malicious);assert.equal(safe.reason,'unknown');assert.equal(safe.rows[0].id,null);assert.equal(safe.rows[0].ref,'p2');assert.equal(safe.rows[0].x,null);assert.equal(safe.before.outputTarget,null);
const py=spawnSync(process.env.PYTHON||'python',['scripts/audit-wire-fixture.py'],{input:JSON.stringify({shipment:sent[0],vectors:[event,malicious,budget,requestResult,...localEvents],expected:[shortenValue(event),safe,shortenValue(budget),shortenValue(requestResult),...localEvents.map(shortenValue)]}),encoding:'utf8',maxBuffer:2**20});
assert.equal(py.status,0,py.stderr+'\n'+py.stdout);const result=JSON.parse(py.stdout);assert.equal(result.events,9);assert.equal(result.replayedWritten,0);
assert(result.timingsPreserved);assert(result.localPreserved);assert(result.everyId);assert(result.requestsPreserved);assert(result.secretFree);assert(result.schemaParity);
const tables=JSON.parse(readFileSync('api/backend/diagnostic-schema.json','utf8'));
assert.deepEqual(new Set(tables.events),new Set(globalThis.TPAuditSchema.events));assert.deepEqual(new Set(tables.reasons),new Set(globalThis.TPAuditSchema.reasons));
console.log('PASS typed events preserve IDs/before/after through page, worker, ASGI ingestion and trace file; secrets blocked; duplicate shipment deduped; JS/Python parity.');
