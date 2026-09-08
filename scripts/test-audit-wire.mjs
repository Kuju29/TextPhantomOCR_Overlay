/** Page sanitizer -> real worker shipper -> real API ingest -> trace FILE. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import '../src/shared/diagnostic-schema.js';
import {traceRelay,setTracingEnabled,flushTrace,note,shortenValue} from '../src/shared/trace.js';
const sent=[],pageRecords=[];
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
traceRelay(pageRecords[0]);note('fixture','decision',event,'tabcdefgh123');await flushTrace();setTracingEnabled(false);
assert.equal(sent.length,1);assert.equal(sent[0].records.length,2);assert.doesNotMatch(JSON.stringify(sent),/PRIVATE_/);
const malicious={...event,reason:'https://PRIVATE_URL/key',rows:[{id:'Bearer PRIVATE_KEY',ref:'p2',x:Infinity,rotation:NaN}],before:{outputTarget:'PRIVATE_OCR'}};
const safe=shortenValue(malicious);assert.equal(safe.reason,'unknown');assert.equal(safe.rows[0].id,null);assert.equal(safe.rows[0].ref,'p2');assert.equal(safe.rows[0].x,null);assert.equal(safe.before.outputTarget,null);
const py=spawnSync(process.env.PYTHON||'python',['scripts/audit-wire-fixture.py'],{input:JSON.stringify({shipment:sent[0],vectors:[event,malicious],expected:[shortenValue(event),safe]}),encoding:'utf8',maxBuffer:2**20});
assert.equal(py.status,0,py.stderr+'\n'+py.stdout);const result=JSON.parse(py.stdout);assert.equal(result.events,2);assert.equal(result.replayedWritten,0);
assert(result.everyId);assert(result.secretFree);assert(result.schemaParity);
const tables=JSON.parse(readFileSync('api/backend/diagnostic-schema.json','utf8'));
assert.deepEqual(new Set(tables.events),new Set(globalThis.TPAuditSchema.events));assert.deepEqual(new Set(tables.reasons),new Set(globalThis.TPAuditSchema.reasons));
console.log('PASS typed events preserve IDs/before/after through page, worker, ASGI ingestion and trace file; secrets blocked; duplicate shipment deduped; JS/Python parity.');
