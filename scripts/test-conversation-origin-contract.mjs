/** OCR IDs -> cross-page planner -> real API HTTP -> original provider adapter.
 * The companion Python entrypoint serves fixture model output, never a real AI.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {translationUnits} from '../src/shared/lens-document.js';
import {checkedOrigins,branchHistory} from '../src/shared/ai/conversation/origins.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import '../src/shared/diagnostic-schema.js';
const storage={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.9.14.13'}),sendMessage:(_m,cb)=>cb?.({}),lastError:null},storage:{local:{
 get(keys,cb){const names=Array.isArray(keys)?keys:typeof keys==='object'&&keys?Object.keys(keys):[keys];const out=keys==null?structuredClone(storage):Object.fromEntries(names.map(k=>[k,storage[k]??(typeof keys==='object'&&!Array.isArray(keys)?keys[k]:undefined)]));cb?.(out);return Promise.resolve(out);},
 set(value,cb){Object.assign(storage,structuredClone(value));cb?.();return Promise.resolve();}}}};
function units(label) {return translationUnits({paragraphs:[{id:'p0',sourceText:label+' first'},{id:'p1',sourceText:label+' second'}]});}
const originals=units('test');assert.deepEqual(originals.map(u=>u.id),['g0','g1']);
const row=(page,ids=['P0','P1'],src=['g0','g1'])=>({pageId:page,unitIds:ids,originalIds:src,sourceFingerprint:'a'.repeat(64)});
const valid=[row('page-a'),row('page-b',['P2','P3'])];
assert.deepEqual(checkedOrigins(valid,['P0','P1','P2','P3']),valid);
const cases=[valid,[row('opaque',['P0','P1','P2','P3','P4'],['g0','p0','P0','item:42','ข้อความ'])],
 [row('p',['P0'],['😀'])],[row('p',['P0'],['bad\nPRIVATE'])],[row('p',['P0'],[{}])],
 [row('p',['P0','P0'],['g0','g1'])],[row('p',['g0'],['g0'])],[row('p',['P１'],['g0'])],
 [row('p',['P0','P1'],['g0','g0'])],[row('p'),row('p',['P2','P3'])],
 [row('p',['P0'],['g'.repeat(161)])],[row('p',['P0'],['\u0000'])],[{...row('p'),sourceFingerprint:null}],null];
const outputs=cases.map(c=>{try{return {ok:true,rows:checkedOrigins(c)};}catch(e){assert.equal(e.code,'ai_conversation_origin_invalid');return {ok:false,validation:e.validation};}});
const py=spawnSync('python',['-c',`import sys,json;sys.path.insert(0,'api')
from backend.ai.translation_paths.origins import checked_origins,OriginValidationError
out=[]
for c in json.load(sys.stdin):
 try:out.append({'ok':True,'rows':checked_origins(c)})
 except OriginValidationError as e:out.append({'ok':False,'validation':e.validation})
print(json.dumps(out,ensure_ascii=False))`],{input:JSON.stringify(cases),encoding:'utf8'});
assert.equal(py.status,0,py.stderr);assert.deepEqual(JSON.parse(py.stdout),outputs);
const turn={pages:[row('p',['P0','P1'])],user:'source',assistant:'unchanged\r\n'};
assert.equal(branchHistory([turn],[row('p',['P0'],['g2'])]).reason,'none');
assert.equal(branchHistory([turn],[row('p',['P0'],['g0'])]).reason,'source_replayed');
const future={pages:[{...row('future',['P0'],['g9']),pageIndex:9}],user:'future',assistant:'translated'};
const earlier={...row('earlier',['P0'],['g1']),pageIndex:1};
assert.equal(branchHistory([future],[earlier],'request_arrival').reason,'none','READY arrival must not retire valid history merely because a lower page index completed later');
assert.equal(branchHistory([future],[earlier],'document_enqueue').reason,'source_order_rewound');
assert.throws(()=>checkedOrigins(valid,['P1','P0','P2','P3']),{validation:{field:'conversation.origins',reason:'source_order_mismatch'}});
if (!process.argv.includes('--http')) {
 console.log(`PASS ${cases.length} JS/Python origin parity cases; real OCR g IDs, per-page uniqueness, wire strictness, opaque preservation and branch IDs`);
} else {
 const base=process.argv[process.argv.indexOf('--http')+1];
 const {submitConversationPage}=await import('../src/background/ai/translation-paths/batch-dispatch.js');
 const {translateViaServer}=await import('../src/background/ai/transports/server.js');
 const traces=[];
 const caps={engineRoutesV2:true,aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'};
 const profile={provider:'huggingface',model:'fixture',base_url:'https://router.huggingface.co/v1',api_key:'PRIVATE_TEST_KEY',translation_mode:'conversation',source_lang:'en',thinking:'off',style_examples:true,memory_mode:'off',prompt:'',
   model_capabilities:{limits:{contextTokens:131072,maxOutputTokens:8192},structuredOutput:{supported:false},reasoning:{supported:true,control:'reasoning_effort',offValue:'none'}}};
 function page(i){const payload={source:'ai',lang:'th',context:{page_url:'http-e2e-doc',tp_tab_session:'private-http-owner',page_index:i},metadata:{image_id:`page-${i}`},ai:{...profile}};
  reserveConversationJob(payload,1);return {payload,ai:payload.ai,imageId:`page-${i}`,targetLang:'th',sourceLang:'en',route:'server',base,tabSession:'private-http-owner',sourceFingerprint:'a'.repeat(64),capabilities:caps,trace:(name,d)=>traces.push({name,d})};}
 const pages=[0,1,2,3].map(page);
 const first=submitConversationPage(units('SLOW_SOURCE'),pages[0]);
 let started=false;
 for(let i=0;i<400;i++){const d=await (await fetch(base+'/fixture/state')).json();if(d.calls){started=true;break;}await new Promise(r=>setTimeout(r,10));}
 assert.ok(started,'first real transport must reach fixture provider');
 const next=pages.slice(1,3).map((p,i)=>submitConversationPage(units(`PAGE_${i}`),p));
 await fetch(base+'/fixture/release',{method:'POST'});
 const results=await Promise.all([first,...next]);
 const tail=await submitConversationPage(units('LAST'),pages[3]);
 assert.deepEqual(results[0].translations.map(t=>t.id),['g0','g1']);
 assert.deepEqual(results[1].translations.map(t=>t.id),['g0','g1']);
 assert.equal(results[1].translations[0].text,'คำแปล0');assert.equal(results[2].translations[0].text,'คำแปล2');
 assert.equal(tail.meta.conversation.historyTurns,2);assert.equal(tail.meta.conversation.commitStatus,'committed');
 const state=await(await fetch(base+'/fixture/state')).json();assert.deepEqual(state.units,[2,4,2]);assert.deepEqual(state.messages,[2,4,6]);
 assert.equal(traces.filter(e=>e.name==='conversationBatch'&&e.d.phase==='dispatch').length,3);
 const {AI_USAGE_STORAGE_KEY,currentUsage}=await import('../src/shared/ai-usage.js');
 const stats=currentUsage(storage[AI_USAGE_STORAGE_KEY],{runtime:'cloud',provider:'huggingface',model:'fixture'});
 assert.equal(stats.requests,3);assert.equal(stats.totalTokens,3080);
 // Malformed metadata is rejected at actual HTTP ingress, not retried and not billed.
 const bad={...profile,conversation:{documentId:'bad',origins:[row('bad',['P0'],['\nPRIVATE_REJECTED_VALUE'])]}};
 let rejected;
 try{await translateViaServer([{id:'P0',text:'must not dispatch'}],{ai:bad,base,targetLang:'th',sourceLang:'en',tabSession:'owner',operationId:crypto.randomUUID(),capabilities:caps,trace:(name,d)=>traces.push({name,d})});}
 catch(e){rejected=e;}
 assert.equal(rejected?.code,'ai_conversation_origin_invalid');assert.equal(rejected.requestDispatched,false);assert.equal(rejected.stage,'conversation_mapping');
 assert.equal(rejected.validation.field,'conversation.origins.0.originalIds.0');
 assert.deepEqual(traces.find(e=>e.name==='text-only AI failed')?.d.providerHttpStatuses,[]);
 assert.equal((await(await fetch(base+'/fixture/state')).json()).calls,3);
 const after=currentUsage(storage[AI_USAGE_STORAGE_KEY],{runtime:'cloud',provider:'huggingface',model:'fixture'});
 assert.equal(after.requests,3);assert.equal(after.totalTokens,3080);
 for(const p of pages)finishConversationJob(p.payload);
 console.log(JSON.stringify({fixture:'OCR-gIDs-ready-transport-public-API-provider',requestUnits:state.units,historyMessages:state.messages,providerCalls:state.calls,extraWarmup:0,ledgerRequests:after.requests,totalTokens:after.totalTokens,invalidMappingRejectedBeforeProvider:true,scope:'real loopback HTTP; model output simulated'}));
}
