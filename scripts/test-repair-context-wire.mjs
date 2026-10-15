import assert from 'node:assert/strict';
import { normalizeSourceContext } from '../src/shared/ai/source-context.js';
import { composeCanonicalPrompt, composeTranslationUserMessage } from '../src/shared/ai/direct-local/prompt.js';
import { BUNDLED_CANONICAL_PROMPT_PLANS } from '../src/generated/canonical-prompt-plans.js';
const all=[{id:'I12_P4',text:'Hello'},{id:'I18_P7',text:'Goodbye'}];
const groups=[{targetIds:all.map(u=>u.id),origin:'initial_request',units:[{id:'c0',text:'Source context'}]}];
const original=structuredClone(groups);let checks=0;
for(const units of [all,all.slice(1)])for(const conversation of [true,false])for(const lang of ['th','en','ja']){
 const wire=units.map((u,i)=>conversation?u.id:`P${i}`);
 const normalized=normalizeSourceContext(groups,units,wire);
 assert.deepEqual(normalized[0].targetIds,wire);checks++;
 const prompt=composeCanonicalPrompt(BUNDLED_CANONICAL_PROMPT_PLANS[lang],{source_context:groups,style_examples:false},false,false,lang,units,wire);
 const user=composeTranslationUserMessage({sections:prompt.sections,sourceRecords:wire.map(id=>`<<${id.startsWith('I')?id:'TP_'+id}:source>>`).join('\n'),targetLang:lang,expectedIds:wire,conversationRecords:conversation});
 const targets=[...user.matchAll(/"appliesTo":(\[[^\]]*\])/g)].flatMap(m=>JSON.parse(m[1]));
 assert.deepEqual(targets,wire);checks++;
}
assert.deepEqual(normalizeSourceContext(groups,all)[0].targetIds,['P0','P1']);checks++;
for(const wire of [[],['I12_P4'],['I12_P4','I12_P4'],['','I18_P7']]){assert.throws(()=>normalizeSourceContext(groups,all,wire),/invalid_source_context_mapping/);checks++;}
assert.deepEqual(groups,original);checks++;
console.log(`PASS ${checks} source-context mapping and final prompt checks: sparse IDs, slices, legacy, th/en/ja`);

// Capture the actual fetch payload after Direct Local generation and real
// conversation preparation. Preserve existing committed messages byte-for-byte.
const { translateWithLocalOpenAi } = await import('../src/shared/ai/direct-local/generation.js');
const { localProviderCatalog, localAiPreset } = await import('../src/shared/ai/providers/local-registry.js');
const { prepareConversation, appendPreparedMessages } = await import('../src/shared/ai/conversation/prompt.js');
const oldFetch = globalThis.fetch;
let payloadCases = 0;
try {
 for (const spec of localProviderCatalog()) for (const units of [all,all.slice(1)]) {
  const native=spec.id==='lmstudio',ids=units.map(u=>u.id),calls=[],captured=[];
  const history=[{anchor:true,user:'ANCHOR_BYTES\n<<I1_P0:OLD_SOURCE>>',assistant:'<<I1_P0:คำเก่า>>',
   ...(native?{providerResponseId:'resp_context_previous'}:{})}];
  const frozenHistory=structuredClone(history);
  const ai={provider:spec.id,model:'wire-fixture',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
    prompt:'',translation_mode:'conversation',style_examples:false,thinking:'minimum',source_context:groups,
    model_capabilities:{limits:{contextTokens:65536},structuredOutput:{supported:false},reasoning:{supported:false,control:'none'}},
    conversation:{branch:'repair',origins:ids.map(id=>({pageId:'page-'+id.split('_')[0],pageOrder:Number(id.split('_')[0].slice(1)),unitIds:[id],originalIds:['original-'+id]}))}};
  globalThis.fetch=async (url,init)=>{
   const body=JSON.parse(init.body);calls.push(body);
   const content=ids.map(id=>`<<${id}:คำแปล>>`).join('\n');
   if(native){
    assert.equal(new URL(url).pathname,'/api/v1/chat');
    const event=(type,value)=>`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
    return new Response(event('chat.start',{model_instance_id:ai.model})+
     event('message.delta',{content})+
     event('chat.end',{result:{model_instance_id:ai.model,response_id:'resp_context_next',
      output:[{type:'message',content}],stats:{input_tokens:20,total_output_tokens:8}}}),
     {headers:{'content-type':'text/event-stream'}});
   }
   const data=spec.protocol==='ollama'?{message:{content},done:true,done_reason:'stop',prompt_eval_count:20,eval_count:8}:
    {choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:8,total_tokens:28}};
   return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const answer=await translateWithLocalOpenAi(units,{ai,canonicalPrompt:BUNDLED_CANONICAL_PROMPT_PLANS.th,targetLang:'th',sourceLang:'en',
    conversationContext:{prepare:async input=>{
     const prepared=await prepareConversation({...input,ai,state:{history,revision:1,scope:'wire-fixture',storage:'memory'}});
     if(native)prepared.providerConversation={enabled:true,historyTurns:prepared.turns.length,
      previousResponseId:prepared.turns.at(-1)?.providerResponseId||''};
     return prepared;
    },messages:appendPreparedMessages,capture:(text,responseId)=>captured.push({text,responseId})}});
  assert.equal(calls.length,1);
  if(native){
   assert.equal(calls[0].store,true);
   assert.equal(calls[0].previous_response_id,history[0].providerResponseId);
   assert.equal(calls[0].system_prompt,undefined);
   assert.equal(calls[0].messages,undefined);
   assert(!JSON.stringify(calls[0]).includes(history[0].user),'native continuation does not resend the anchor');
   assert.deepEqual(captured,[{text:ids.map(id=>`<<${id}:คำแปล>>`).join('\n'),responseId:'resp_context_next'}]);
  }else assert.deepEqual(calls[0].messages.slice(1,3),[
   {role:'user',content:history[0].user},{role:'assistant',content:history[0].assistant}]);
  const user=native?calls[0].input:calls[0].messages.at(-1).content;
  const targets=[...user.matchAll(/"appliesTo":(\[[^\]]*\])/g)].flatMap(m=>JSON.parse(m[1]));
  assert.deepEqual(targets,[],spec.id+' repair adds no repeated source-context instructions');
  assert.equal(user,units.map(unit=>`<<${unit.id}:${unit.text}>>`).join('\n'),spec.id+' repair is a normal OCR-only turn');
  assert.deepEqual(history,frozenHistory,'must not rewrite committed history');
  assert.equal(calls[0].format,undefined);assert.equal(calls[0].response_format,undefined);
  assert.deepEqual(answer.translations.map(row=>row.id),ids);
  assert.equal(answer.meta.usage.inputTokens,20);assert.equal(answer.meta.usage.outputTokens,8);
  payloadCases++;
 }
} finally {globalThis.fetch=oldFetch;}
console.log(`PASS ${payloadCases} captured Direct Local repair payloads across ${localProviderCatalog().length} runtimes; exact replay/native cursor + sliced stable context IDs + one call`);
