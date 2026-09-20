/** Actual Local transport/generation via loopback; no live model calls. */
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {BUNDLED_CANONICAL_PROMPT_PLANS as plans} from '../src/generated/canonical-prompt-plans.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';
import {translateDirectLocal} from '../src/background/ai/transports/direct-local.js';
import {SCHEMA_OBJECT_CONTRACT} from '../src/shared/ai/direct-local/output-contract.js';
import {reserveConversationJob,enterConversationJob,finishConversationJob,cancelConversationJobs} from '../src/background/ai/translation-paths/order.js';
import {withLocalHistory,localScope} from '../src/background/ai/translation-paths/local-history.js';
const storage={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.9.14.9'})},storage:{local:{
 get(keys,cb){const result=Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]]));cb?.(result);return Promise.resolve(result);},
 set(value,cb){Object.assign(storage,structuredClone(value));cb?.();return Promise.resolve();}
}}};
let mode='valid',delayResolve,slow=false;
const calls=[],wire=[],events=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const part of req)raw+=part;
 const body=JSON.parse(raw);calls.push(body);
 const active=body.messages.at(-1).content;
 assert.ok(active.includes('Hello')||active.includes('Next')||active.includes('Repair'));
 if(slow) await new Promise(r=>{delayResolve=r;});
 const imageIds=[...active.matchAll(/<<(I[1-9][0-9]{0,6}_P[0-9]{1,6}):/gu)].map(m=>m[1]);
 const imageId=imageIds[0]||'';
 const text=mode==='invalid'?'':mode==='recoverable'?imageIds.map((id,index)=>`<<${id}:${index<2?'เสีย'+index:'ดี'+index}${index<2?'>':'>>'}`).join('\n'):
  mode==='wrong'?(imageId?`<<${imageId}:INVALID ENGLISH>>`:'<<TP_P0:INVALID ENGLISH>>'):imageId?`<<${imageId}:สวัสดี>>`:body.format?JSON.stringify({P0:'สวัสดี'}):'<<TP_P0:สวัสดี>>';
 res.writeHead(200,{'content-type':'application/x-ndjson'});
 res.end(JSON.stringify({model:body.model,message:{role:'assistant',content:text},done:false})+'\n'+JSON.stringify({model:body.model,done:true,done_reason:'stop',prompt_eval_count:200,eval_count:20,total_duration:1e7})+'\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=`http://127.0.0.1:${server.address().port}`;
const service=createTranslationService({directLocal:(units,options)=>translateDirectLocal(units,{...options,canonicalPrompt:plans.th})});
const ai={provider:'ollama',model:'fixture-chat',base_url:url,local_adapter:{protocol:'ollama',baseUrl:url},
 prompt:'',translation_mode:'conversation',style_examples:true,thinking:'off',
 model_capabilities:{limits:{scope:"runtime",source:"ollama-api-show+ps",contextTokens:4096,runtimeContextTokens:4096,modelContextTokens:32768,maxOutputTokens:4096},reasoning:{supported:true,control:'boolean'},
 structuredOutput:{supported:false}},conversation:{owner:'owner1',documentId:'doc1',reset:'test-1'}};
let op=0;
const send=(text,a=ai,id=(a?.translation_mode==='conversation'?'I1_P0':'actual-id'))=>{
 const image=/^I([1-9][0-9]{0,6})_P([0-9]{1,6})$/.exec(String(id));
 const effectiveAi=a?.translation_mode==='conversation'&&image?{...a,conversation:{...a.conversation,origins:[{pageId:`page-${image[1]}`,pageIndex:Number(image[1])-1,pageOrder:Number(image[1]),unitIds:[id],originalIds:[`g${image[2]}`]}]}}:a;
 return service([{id,text}],{ai:effectiveAi,targetLang:'th',sourceLang:'en',route:'direct-local',operationId:`ai:${String(++op).padStart(32,'0')}`,
  trace:(_event,value)=>events.push(value),wireTrace:(event,value)=>wire.push([event,value])});
};
const sendMany=(texts,a=ai,page=1)=>{
 const unitIds=texts.map((_,index)=>`I${page}_P${index}`);
 const units=texts.map((text,index)=>({id:unitIds[index],text}));
 const effectiveAi={...a,conversation:{...a.conversation,origins:[{pageId:`page-${page}`,pageIndex:page-1,pageOrder:page,unitIds,originalIds:texts.map((_,index)=>`g${page}-${index}`)}]}};
 return service(units,{ai:effectiveAi,targetLang:'th',sourceLang:'en',route:'direct-local',operationId:`ai:${String(++op).padStart(32,'0')}`,
  trace:(_event,value)=>events.push(value),wireTrace:(event,value)=>wire.push([event,value])});
};
try {
 for(const structured of [false,true]) {
  const a={...ai,conversation:{...ai.conversation,documentId:structured?'doc-json':'doc-marker'},
   model_capabilities:{...ai.model_capabilities,structuredOutput:{supported:structured,contract:SCHEMA_OBJECT_CONTRACT,source:'fixture'}}};
  const first=await send('Hello one',a,'I1_P0'),second=await send('Next two',a,'I2_P0'),third=await send('Next three',a,'I3_P0');
  const [x,y,z]=calls.slice(-3);
  assert.deepEqual(y.messages[0],x.messages[0],'system remains byte-identical');
  assert.ok(!x.messages[1].content.includes('H01\nEN:'),'Conversation must not inject Human Bootstrap Examples');
  assert.deepEqual(y.messages[1],x.messages[1],'committed first user turn is replayed byte-for-byte');
  assert.ok(!y.messages.at(-1).content.includes('H01\nEN:'),'next current user excludes bootstrap examples once history exists');
  assert.deepEqual(z.messages.slice(0,4),y.messages);
  assert.deepEqual(z.messages.map(m=>m.role),['system','user','assistant','user','assistant','user']);
  assert.equal(first.meta.conversation.commitStatus,'committed');
  assert.equal(second.meta.conversation.historyTurns,1);assert.equal(third.meta.conversation.historyTurns,2);
  assert.ok(!y.messages.at(-1).content.includes('สไตล์การแปล'));
  assert.ok(!y.messages.at(-1).content.includes('ตัวอย่าง A1'));
  assert.equal(first.meta.conversation.bootstrapExamplesIncluded,false);
  assert.equal(second.meta.conversation.bootstrapExamplesIncluded,false);
  assert.equal(third.meta.conversation.bootstrapExamplesIncluded,false);
  assert.deepEqual([first,second,third].map(r=>r.meta.conversation.bootstrapExamplesPersisted),[false,false,false]);
  assert.deepEqual([first,second,third].map(r=>r.meta.promptLayout.examplesIncluded),[false,false,false]);
  assert.equal(first.meta.promptLayout.bootstrapExamplesChars,0);
  assert.deepEqual([first,second,third].map(r=>r.meta.promptLayout.bootstrapExamplesChars),[first.meta.promptLayout.bootstrapExamplesChars,first.meta.promptLayout.bootstrapExamplesChars,first.meta.promptLayout.bootstrapExamplesChars]);
  assert.deepEqual(z.messages.slice(0,4),y.messages,'request N must be an exact native-message prefix of request N+1');
  assert.equal(second.meta.promptLayoutScope,'effective_provider_request');
  assert.equal(y.messages[2].content,'<<I1_P0:สวัสดี>>','Conversation history must preserve the I#_P# assistant record exactly');
  assert.ok(y.messages.at(-1).content.includes('<<I2_P0:Next two>>'));
  assert.equal('format' in y,false,'Conversation never sends model-varying JSON schema metadata');
  assert.equal(y.think,false);
  assert.ok(y.options.num_ctx>=8192, JSON.stringify({options:y.options, diagnostic:second.meta.conversation}));
  assert.ok(y.options.num_ctx*4>=second.meta.conversation.estimatedInput+second.meta.conversation.outputReserve,'runtime context must cover the planned request');
  assert.ok(!JSON.stringify(y).includes('owner1'));assert.equal(third.meta.conversation.providerCacheStatus,'not_reported');
  const before=calls.length;
  const repair=await send('Repair line',{...a,conversation:{...a.conversation,branch:'repair'}},'I4_P0');
  assert.equal(repair.meta.conversation.historyTurns,3);assert.equal(repair.meta.conversation.commitStatus,'committed');
  const after=await send('Next after repair',a,'I5_P0');assert.equal(after.meta.conversation.historyTurns,4);
  assert.equal(calls.length,before+2,'no extra warm-up calls');
  const changed=await send('Hello other',{...a,conversation:{...a.conversation,owner:'owner2'}},'I1_P0');
  assert.equal(changed.meta.conversation.historyTurns,0,'different users do not share private history');
  const reset=await send('Hello reset',{...a,conversation:{...a.conversation,reset:'obsolete-manual-reset'}},'I6_P0');
  assert.equal(reset.meta.conversation.historyTurns,5,'obsolete reset setting cannot erase a dynamic conversation');
 }
 // Conversation ignores the dormant Independent style-example preference.
 const checkboxOffConversation={...ai,style_examples:false,conversation:{...ai.conversation,documentId:'checkbox-off-conversation'}};
 const cbFirst=await send('Hello checkbox off',checkboxOffConversation,'I1_P0');
 assert.equal(cbFirst.meta.conversation.bootstrapExamplesIncluded,false);
 assert.ok(!calls.at(-1).messages[1].content.includes('H01\nEN:'));
 const cbSecond=await send('Next checkbox off',checkboxOffConversation,'I2_P0');
 assert.equal(cbSecond.meta.conversation.bootstrapExamplesIncluded,false);
 assert.equal(cbSecond.meta.conversation.bootstrapExamplesPersisted,false);
 assert.ok(!calls.at(-1).messages.at(-1).content.includes('H01\nEN:'));
 // Old route never visits history and sends exactly two messages every time.
 const legacy={...ai,translation_mode:'independent'};
 const l1=await send('Hello legacy',legacy),l2=await send('Hello legacy',legacy);
 assert.equal(calls.at(-1).messages.length,2);assert.deepEqual(calls.at(-1),calls.at(-2));
 assert.equal(l1.meta.conversation,undefined);assert.equal(l2.meta.conversation,undefined);
 // A structurally valid but wrong-language unit stays in the exact chat transcript;
 // page validation/repair owns the quality defect instead of resetting Conversation.
 mode='wrong';const badAi={...ai,conversation:{...ai.conversation,documentId:'bad-output-test'}};
 const bad=await send('Hello invalid',badAi,'I1_P0');assert.equal(bad.meta.conversation.commitStatus,'committed');
 mode='valid';const valid=await send('Next after bad',badAi,'I2_P0');assert.equal(valid.meta.conversation.historyTurns,1);
 assert.ok(wire.some(([e,d])=>e==='timing'&&d.conversation?.commitStatus==='committed'));
 assert.ok(events.some(e=>e.schema==='tp.conversation/1'&&e.historyTurns===2));
 // Recoverable physical-line marker damage keeps the good records in Conversation
 // without replaying the malformed provider bytes into the next request.
 mode='recoverable';
 const recoverableAi={...ai,conversation:{...ai.conversation,documentId:'recoverable-marker-test'}};
 const recovered=await sendMany(['Hello r0','Hello r1','Hello r2','Hello r3'],recoverableAi,1);
 assert.equal(recovered.meta.conversation.commitStatus,'committed');
 assert.equal(recovered.meta.contractDiagnostics.malformedMarkersRecoverable,true);
 mode='valid';
 const afterRecovered=await send('Next after recoverable',recoverableAi,'I2_P0');
 assert.equal(afterRecovered.meta.conversation.historyTurns,1);
 const replayed=calls.at(-1).messages[2].content;
 assert.equal(replayed,'<<I1_P2:ดี2>>\n<<I1_P3:ดี3>>');
 assert.ok(!replayed.includes('เสีย0>')&&!replayed.includes('เสีย1>'));
 // Regression from production 14.24: Conversation previously trimmed the prior
 // turn with standardOutputTokens*1.5 even though the workload guard sent a much
 // smaller num_predict. The history must be planned against the exact provider
 // completion budget instead.
 const budgetAi={...ai,conversation:{...ai.conversation,documentId:'budget-ownership'},
  workload:{version:1,predictedOutput:1200,reasoningReserve:0,completionAvailable:1900}};
 await send(`Hello ${'A'.repeat(1500)}`,budgetAi,'I1_P0');
 const budgetSecond=await send(`Next ${'B'.repeat(1500)}`,budgetAi,'I2_P0');
 const budgetRequest=calls.at(-1);
 assert.equal(budgetSecond.meta.conversation.historyTurns,1,'final guarded Local budget must retain a turn that fits 16K');
 assert.equal(budgetSecond.meta.conversation.outputReserve,budgetRequest.options.num_predict,
  'Conversation trim reserve must equal the actual provider num_predict');
 assert.equal(budgetSecond.meta.conversation.rolloverReason,'none');
 console.log('PASS 20 Local generations via real HTTP/NDJSON: append, exact Conversation budget ownership, schema/marker, BYOK stripping, repair append, wrong-language repair continuity, original route');
} finally {server.closeAllConnections();server.close();await once(server,'close');}
// Reserve before OCR; a cancelled middle page must not release later pages early.
function payload(doc='d',owner='owner',mode='conversation'){return {source:'ai',lang:'th',context:{page_url:doc,tp_tab_session:owner},ai:{provider:'ollama',model:'x',translation_mode:mode}};}
const a=payload(),b=payload(),c=payload(),other=payload('other');
for(const p of [a,b,c,other])reserveConversationJob(p,1);
await enterConversationJob(a);await enterConversationJob(other);
let entered=false;const future=enterConversationJob(c).then(()=>{entered=true;});
finishConversationJob(b);await new Promise(r=>setTimeout(r,20));assert.equal(entered,false,'cancel B cannot overtake A');
finishConversationJob(a);await future;assert.equal(entered,true);finishConversationJob(c);finishConversationJob(other);
const old=payload('d','owner','independent');assert.equal(reserveConversationJob(old,1),null);assert.equal(await enterConversationJob(old),0);
const aborted=payload('cancel');reserveConversationJob(aborted,8);cancelConversationJobs({tabId:8});await assert.rejects(enterConversationJob(aborted),{name:'AbortError'});finishConversationJob(aborted);
// Within a document Local history serializes, while another document remains free.
const first={...ai,conversation:{owner:'o',documentId:'serial',reset:'x'}};
let free,started=false;
const running=withLocalHistory(first,'th','en',null,async()=>{started=true;await new Promise(r=>{free=r;});});
while(!started)await new Promise(r=>setTimeout(r,1));
let secondStarted=false;
const queued=withLocalHistory(first,'th','en',null,async()=>{secondStarted=true;});
await withLocalHistory({...first,conversation:{...first.conversation,documentId:'parallel'}},'th','en',null,async()=>{});
assert.equal(secondStarted,false);free();await Promise.all([running,queued]);assert.equal(secondStarted,true);
console.log('PASS document enqueue order, cancellation fence, independent bypass, Local same-document serial / other-document parallel');
