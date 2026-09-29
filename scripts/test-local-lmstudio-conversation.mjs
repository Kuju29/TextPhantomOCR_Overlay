/** Mock native SSE and IndexedDB: provider thread ID and accepted turn commit together. */
import assert from 'node:assert/strict';
import {getCanonicalPrompt} from '../src/background/ai/prompt-cache.js';
import {conversationTranslation} from '../src/background/ai/translation-paths/conversation.js';
import {localScope} from '../src/background/ai/translation-paths/local-history.js';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {localAiPreset,resolveLocalProvider} from '../src/shared/ai/providers/local-registry.js';

const savedFetch=globalThis.fetch,savedDb=globalThis.indexedDB;
const rows=new Map(),requests=[],wireStages=[],wireContracts=[],pendingWrites=[];
let pauseWrites=false;
const db={transaction(_name,mode){
  const tx={}, staged=new Map(), removed=new Set();
  let aborted=false,completed=false;
  tx.abort=()=>{if(aborted||completed)return;aborted=true;queueMicrotask(()=>tx.onabort?.());};
  const complete=()=>queueMicrotask(()=>{
    if(aborted)return;
    if(mode==='readwrite'){
      for(const key of removed)rows.delete(key);
      for(const [key,value] of staged)rows.set(key,structuredClone(value));
    }
    completed=true;
    tx.oncomplete?.();
  });
  const finish=()=>mode==='readwrite'&&pauseWrites?pendingWrites.push(complete):complete();
  tx.objectStore=()=>({
    get(key){const q={};queueMicrotask(()=>{q.result=structuredClone(rows.get(key));q.onsuccess?.();finish();});return q;},
    put(value){staged.set(value.scope,structuredClone(value));},
    count(){const q={};queueMicrotask(()=>{q.result=rows.size;q.onsuccess?.();finish();});return q;},
    getAll(){throw new Error('bulk history scan is forbidden');},
    delete(key){removed.add(key);},
  });
  return tx;
}};
globalThis.indexedDB={open(){const q={};queueMicrotask(()=>{q.result=db;q.onsuccess?.();});return q;}};
const plan=await getCanonicalPrompt('','th',{wantMemo:false});
const ai={provider:'lmstudio',model:'fixture-native',base_url:'http://127.0.0.1:1234/v1',
  local_adapter:{...localAiPreset('lmstudio'),baseUrl:'http://127.0.0.1:1234/v1'},
  prompt:'',translation_mode:'conversation',
  thinking:'off',style_examples:true,model_capabilities:{
    limits:{contextTokens:32768,maxInputTokens:32768,maxOutputTokens:4096},
    reasoning:{supported:true,mandatory:false,control:'levels',supported_efforts:['off','low']},
    structuredOutput:{supported:false}},
  conversation:{owner:'local-test',documentId:'native-stateful-fixture'}};
let responseCount=0,mode='normal';
const sse=(type,event)=>`event: ${type}\ndata: ${JSON.stringify({type,...event})}\n\n`;
globalThis.fetch=async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:1234/api/v1/chat');
  const body=JSON.parse(init.body);requests.push(body);
  if(mode==='cancel')return new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});
  });
  if(mode==='evicted')return new Response(JSON.stringify({error:{message:'Previous response ID is unavailable'}}),
    {status:404,headers:{'content-type':'application/json'}});
  const input=typeof body.input==='string'?body.input:body.input.find(part=>part.type==='text')?.content||'';
  const id=[...input.matchAll(/<<(I[1-9][0-9]{0,6}_P[0-9]{1,6}):/g)].at(-1)?.[1];
  assert.ok(id,`latest user-only OCR marker required: ${JSON.stringify(body).length} bytes`);
  const answer=`<<${id}:คำแปล${responseCount+1}>>`,responseId=`resp_fixture_${++responseCount}`;
  const data=sse('chat.start',{model_instance_id:body.model})+
    (['unexpected_reasoning_delta','unexpected_empty_reasoning_delta'].includes(mode)
      ?sse('reasoning.delta',{content:mode==='unexpected_reasoning_delta'?'private model reasoning':''}):'')+
    sse('message.delta',{content:answer})+
    sse('chat.end',{result:{model_instance_id:body.model,output:[{type:'message',content:answer}],
      stats:{input_tokens:180,total_output_tokens:24,
        ...(mode==='unexpected_thinking'?{reasoning_output_tokens:7}:{})},
      ...(mode==='missing_id'?{}:{response_id:responseId})}});
  return new Response(data,{status:200,headers:{'content-type':'text/event-stream'}});
};
const send=(page,source,{signal=null,branch='initial',owner=ai.conversation.owner,limits=null,reasoning=null,thinking=null}={})=>{
  const id=`I${page}_P0`;
  const active={...ai,...(thinking?{thinking}:{}),...(limits||reasoning?{model_capabilities:{...ai.model_capabilities,
      ...(limits?{limits}:{}),...(reasoning?{reasoning}:{})}}:{}),
    conversation:{...ai.conversation,owner,branch,
    origins:[{pageId:`page-${page}`,pageOrder:page,pageIndex:page-1,unitIds:[id],originalIds:[`text-${page}`]}]}};
  return conversationTranslation((units,options)=>translateWithLocalOpenAi(units,{...options,canonicalPrompt:plan}),
    [{id,text:source}],{ai:active,route:'direct-local',targetLang:'th',sourceLang:'en',signal,
      wireTrace:(stage,value)=>{
        wireStages.push(stage);
        if(stage==='contractSelection')wireContracts.push(value);
      }});
};
try {
  assert.throws(()=>resolveLocalProvider({...ai.local_adapter,protocol:'ollama'},'lmstudio'),error=>
    error.code==='local_provider_response_contract'&&error.requestDispatched===false,
    'a named native provider must not inherit a swapped adapter protocol');
  const beforeMismatchedEndpoint=requests.length;
  await assert.rejects(conversationTranslation((_units,options)=>options.conversationContext.prepare({
    protocol:'openai',
  }),[{id:'I1_P0',text:'SOURCE'}],{ai,route:'direct-local',targetLang:'th',sourceLang:'en'}),error=>
    error.code==='ai_conversation_native_endpoint_mismatch'&&error.requestDispatched===false);
  assert.equal(requests.length,beforeMismatchedEndpoint,'native mismatch fails before generation');
  const first=await send(1,'First');
  assert.equal(first.meta.conversation.commitStatus,'committed');
  assert.equal(first.meta.conversation.continuationTransport,'native_response_cursor');
  assert.equal(first.meta.conversation.providerMemory,'new_thread');
  assert.equal(first.meta.conversation.providerCacheStatus,'not_reported');
  assert.equal(requests[0].store,true);
  assert.ok(requests[0].system_prompt);
  assert.equal(requests[0].previous_response_id,undefined);
  assert.ok(requests[0].input.includes('H01\nEN:') && requests[0].input.includes('H20\nEN:'),
    'first anchor keeps the existing 20 quality examples');
  const second=await send(2,'Second'),third=await send(3,'Third');
  assert.equal(wireStages.filter(stage=>stage==='systemPrompt').length,1,
    'provider wire audit must not claim the system prompt was resent on continuation');
  assert.equal(second.meta.conversation.historyTurns,1);
  assert.equal(second.meta.conversation.continuationTransport,'native_response_cursor');
  assert.equal(third.meta.conversation.historyTurns,2);
  for(const [index,id] of [[1,'resp_fixture_1'],[2,'resp_fixture_2']]){
    assert.equal(requests[index].previous_response_id,id);
    assert.equal(requests[index].system_prompt,undefined);
    assert.ok(!JSON.stringify(requests[index]).includes('H01\nEN:'));
    assert.ok(!JSON.stringify(requests[index]).includes('First'));
  }
  assert.equal(second.meta.conversation.providerMemory,'continued_thread');
  assert.equal([...rows.values()][0].history.at(-1).providerResponseId,'resp_fixture_3');
  assert.ok(!JSON.stringify(second.meta.conversation).includes('resp_fixture_1'),
    'raw provider cursor is private and absent from the diagnostic result');

  const branch=await send(2,'Second changed');
  assert.equal(branch.meta.conversation.rolloverReason,'source_replayed');
  assert.equal(branch.meta.conversation.historyTurns,1);
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_1','branch uses last retained point');
  const repair=await send(4,'Repair',{branch:'repair'});
  assert.equal(repair.meta.conversation.commitStatus,'committed');
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_4');

  mode='missing_id';
  await assert.rejects(send(5,'Missing cursor'),error=>
    error.code==='local_provider_response_contract'&&error.diagnostics?.validatorSubtype==='missing_stateful_response_id');
  assert.equal([...rows.values()][0].history.at(-1).providerResponseId,'resp_fixture_5');
  mode='normal';
  const resumed=await send(5,'Retry missing cursor');
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_5');
  assert.equal(resumed.meta.conversation.commitStatus,'committed');

  mode='cancel';
  const controller=new AbortController();
  const cancelled=send(6,'Cancel',{signal:controller.signal});
  while(requests.length<8) await new Promise(resolve=>setTimeout(resolve,1));
  controller.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError'||error.code==='cancelled');
  assert.equal([...rows.values()][0].history.at(-1).providerResponseId,'resp_fixture_7');
  mode='normal';
  await send(6,'After cancellation');
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_7');

  mode='evicted';
  await assert.rejects(send(7,'Evicted provider thread'),error=>error.code==='local_ai_endpoint_incompatible');
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_8');
  const originalScope=await localScope(ai,'th','en');
  assert.notEqual(originalScope,await localScope({...ai,local_adapter:{...ai.local_adapter,
    baseUrl:'http://127.0.0.1:5678/v1'}},'th','en'),
    'the actual native endpoint participates in thread ownership');
  const persisted=rows.get(originalScope),withoutCursor=structuredClone(persisted);
  delete withoutCursor.history.at(-1).providerResponseId;
  rows.set(originalScope,withoutCursor);
  const beforeMissingState=requests.length;
  await assert.rejects(send(7,'Legacy history without a cursor'),error=>
    error.code==='ai_conversation_state_missing'&&error.requestDispatched===false);
  assert.equal(requests.length,beforeMissingState,'missing persisted cursor never replays full history');
  rows.set(originalScope,persisted);
  mode='normal';
  const scoped=await send(1,'Other owner',{owner:'someone-else'});
  assert.equal(scoped.meta.conversation.historyTurns,0);
  assert.equal(requests.at(-1).previous_response_id,undefined,'different owner cannot access previous thread');
  assert.equal(rows.size,2);
  for(let page=1;page<=5;page++) await send(page,`History ${page}`,{owner:'context-budget'});
  const rolled=await send(6,'After context limit',{owner:'context-budget',
    limits:{contextTokens:9400,maxInputTokens:9400,maxOutputTokens:4096}});
  assert.equal(rolled.meta.conversation.providerThreadRollover,true);
  assert.equal(rolled.meta.conversation.continuationTransport,'native_response_cursor');
  assert.equal(rolled.meta.conversation.historyTurns,0);
  assert.equal(requests.at(-1).previous_response_id,undefined,'context rollover starts a fresh provider thread');
  assert.ok(requests.at(-1).system_prompt,'fresh anchor restores the system prompt');
  pauseWrites=true;
  const duringCommit=new AbortController();
  const interrupted=send(7,'Cancel after IndexedDB put',{signal:duringCommit.signal});
  for(let i=0;i<200&&!pendingWrites.length;i++) await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(pendingWrites.length,1,'fixture reached the pending readwrite commit after put');
  assert.equal(rows.get(originalScope).history.at(-1).providerResponseId,'resp_fixture_8');
  duringCommit.abort();
  await assert.rejects(interrupted,error=>error.name==='AbortError');
  pendingWrites.shift()();
  pauseWrites=false;
  assert.equal(rows.get(originalScope).history.at(-1).providerResponseId,'resp_fixture_8',
    'an aborted IndexedDB transaction must never publish the canceled cursor');
  await send(7,'Retry after aborted put');
  assert.equal(requests.at(-1).previous_response_id,'resp_fixture_8');
  const beforeOff=requests.length;
  await assert.rejects(translateWithLocalOpenAi([{id:'off-check',text:'Off must stay off'}],{
    ai:{...ai,model_capabilities:{...ai.model_capabilities,
      reasoning:{supported:true,mandatory:true,control:'levels',supported_efforts:['low']}}},
    canonicalPrompt:plan,targetLang:'th',sourceLang:'en',
  }),error=>error.code==='local_model_thinking_unsupported' &&
    error.requestDispatched===false && error.generationAttempts===0);
  assert.equal(requests.length,beforeOff,'mandatory reasoning must not silently turn explicit Off into Low');
  await assert.rejects(send(1,'Unsupported explicit Low',{owner:'unsupported-low',thinking:'low',
    reasoning:{supported:true,mandatory:true,control:'levels',supported_efforts:['high']}}),
  error=>error.code==='local_model_thinking_unsupported'&&error.requestDispatched===false,
  'explicit Low must not silently become the native provider default');
  assert.equal(requests.length,beforeOff,'unsupported named mode must stop before native chat');
  const nonReasoning=await send(1,'No reasoning',{owner:'non-reasoning',reasoning:{supported:false}});
  assert.equal(requests.at(-1).reasoning,undefined);
  assert.equal(nonReasoning.meta.thinkingApplied,'not_applicable_non_reasoning_model');
  const knownNoReasoning={supported:false,mandatory:false,control:'none',
    supported_efforts:[],source:'lmstudio_native_loaded_instance'};
  const minimumNoReasoning=await send(1,'Verified no reasoning',{owner:'minimum-no-reasoning',
    thinking:'minimum',reasoning:knownNoReasoning});
  assert.equal(minimumNoReasoning.meta.thinkingApplied,'not_applicable_non_reasoning_model',
    'Lowest on an exact loaded non-reasoning model is not unknown provider-managed reasoning');
  assert.equal(wireContracts.at(-1)?.thinkingApplied,'not_applicable_non_reasoning_model');
  mode='evicted';
  await assert.rejects(send(1,'Verified no reasoning HTTP error',{owner:'minimum-no-reasoning-error',
    thinking:'minimum',reasoning:knownNoReasoning}),error=>
    error.generationMeta?.thinkingApplied==='not_applicable_non_reasoning_model',
  'the same exact capability remains visible on HTTP rejection');
  mode='normal';
  mode='unexpected_thinking';
  const cursorBeforeUnexpected=rows.get(originalScope).history.at(-1).providerResponseId;
  await assert.rejects(send(8,'Provider reported reasoning'),error=>
    error.code==='local_model_thinking_unsupported'&&error.requestDispatched===true&&
    error.generationAttempts===1&&error.generationMeta?.usage?.thinkingTokens===7);
  assert.equal(rows.get(originalScope).history.at(-1).providerResponseId,cursorBeforeUnexpected,
    'reported reasoning must not advance the provider conversation cursor');
  mode='normal';
  await send(8,'Retry after reported reasoning');
  assert.equal(requests.at(-1).previous_response_id,cursorBeforeUnexpected);
  for(const [nextMode,nextPage] of [['unexpected_reasoning_delta',9],['unexpected_empty_reasoning_delta',10]]){
    const before=rows.get(originalScope).history.at(-1).providerResponseId;
    mode=nextMode;
    await assert.rejects(send(nextPage,'Reasoning delta without usage counters'),error=>
      error.code==='local_model_thinking_unsupported'&&error.requestDispatched===true&&
      error.generationAttempts===1&&error.diagnostics?.validatorSubtype==='reasoning_reported_with_thinking_off');
    assert.equal(rows.get(originalScope).history.at(-1).providerResponseId,before,
      'even an empty reasoning.delta must prevent the provider cursor commit under Thinking Off');
    mode='normal';
    await send(nextPage,'Retry reasoning delta');
    assert.equal(requests.at(-1).previous_response_id,before);
  }
  const beforeUnknown=requests.length;
  const unknownLowest=await send(11,'Unknown Lowest',{owner:'unknown-lowest',thinking:'minimum',
    reasoning:{supported:null,source:'lmstudio_native_loaded_instance'}});
  assert.equal(unknownLowest.meta.conversation.commitStatus,'committed');
  assert.equal(unknownLowest.meta.thinkingApplied,'provider_managed_unverified');
  assert.equal(wireContracts.at(-1)?.thinkingApplied,'provider_managed_unverified',
    'native wire trace records the unverified provider-managed Lowest plan');
  assert.equal(requests.length,beforeUnknown+1);
  assert.equal(requests.at(-1).reasoning,undefined);
  const beforeOllama=requests.length;
  globalThis.fetch=async(url,init)=>{
    assert.ok(String(url).endsWith('/api/chat'));
    assert.equal(JSON.parse(init.body).think,false);
    const frames=[
      {model:'fixture-ollama',message:{thinking:'reasoning despite disabled setting'},done:false},
      {model:'fixture-ollama',message:{content:'<<TP_P0:คำแปล>>'},done:false},
      {model:'fixture-ollama',message:{content:''},done:true,done_reason:'stop',prompt_eval_count:20,eval_count:12},
    ];
    return new Response(frames.map(frame=>JSON.stringify(frame)+'\n').join(''),
      {headers:{'content-type':'application/x-ndjson'}});
  };
  await assert.rejects(translateWithLocalOpenAi([{id:'original-id',text:'source text'}],{
    ai:{...ai,provider:'ollama',model:'fixture-ollama',base_url:'http://localhost:11434',
      local_adapter:localAiPreset('ollama'),model_capabilities:{...ai.model_capabilities,
        reasoning:{supported:true,mandatory:false,control:'boolean',source:'ollama-api-show'}}},
    canonicalPrompt:plan,targetLang:'th',sourceLang:'en',
  }),error=>error.code==='local_model_thinking_unsupported'&&error.requestDispatched===true&&
    error.diagnostics?.validatorSubtype==='reasoning_reported_with_thinking_off');
  assert.equal(requests.length,beforeOllama,'Ollama failure does not mutate LM Studio state');
  console.log('PASS LM Studio native first/continuation/branch/repair/rollover, atomic cursor, missing ID/state, cancel, eviction, owner scope and strict Thinking Off');
}finally{globalThis.fetch=savedFetch;globalThis.indexedDB=savedDb;}
