import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ||= webcrypto;
import { uncertainRepairIds } from '../src/shared/ai/repair-alignment.js';
import { repairValidation } from '../src/background/repair/executor.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { localProviderCatalog, localAiPreset } from '../src/shared/ai/providers/local-registry.js';
import { prepareConversation, appendPreparedMessages } from '../src/shared/ai/conversation/prompt.js';
import { BUNDLED_CANONICAL_PROMPT_PLANS } from '../src/generated/canonical-prompt-plans.js';
const ids=['I10_P11','I26_P23','I26_P28','I26_P29','I26_P30'];
const units=ids.map(id=>({id,text:'An original sentence.'}));
let checks=0;
for (const [unexpected,expected] of [[[],[]],[['I26_P11'],ids.slice(1)],[['I10_P7'],ids.slice(0,1)],
 [['I10_P7','I26_P11'],ids],[['I90_P0'],ids],[['P0'],ids],[['I26_P23'],[]]]) {
 assert.deepEqual(uncertainRepairIds(ids,unexpected),expected); checks++;
}
assert.deepEqual(uncertainRepairIds(['P0','P5'],['P4']),['P0','P5']);checks++;
const rawAnswer={translations:ids.map(id=>({id,text:'คำแปลภาษาไทย'})),
 meta:{contractDiagnostics:{ignoredUnknownIds:['I26_P11']}}};
const checked=repairValidation(rawAnswer,units,'th');
assert.deepEqual(checked.accepted,ids.slice(0,1));checks++;
assert.deepEqual(checked.alignmentUncertainIds,ids.slice(1));checks++;
const aliasUnits=units.map((unit,i)=>({...unit,id:`R${i}`}));
const wireToAlias=new Map(ids.map((id,i)=>[id,`R${i}`]));
const aliasAnswer=structuredClone(rawAnswer);
aliasAnswer.translations=aliasAnswer.translations.map((row,i)=>({...row,id:`R${i}`}));
assert.deepEqual(repairValidation(aliasAnswer,aliasUnits,'th',wireToAlias).accepted,['R0']);checks++;
aliasAnswer.meta.alignmentUncertainIds=['R1','R2','R3','R4'];
// Recoverable receipt without page checkpoint remapping preserves quarantine.
assert.deepEqual(repairValidation(aliasAnswer,aliasUnits,'th').accepted,['R0']);checks++;
const valid=structuredClone(rawAnswer);valid.meta.contractDiagnostics.ignoredUnknownIds=[];
assert.deepEqual(repairValidation(valid,units,'th').accepted,ids);checks++;
const missing=structuredClone(valid);missing.translations.pop();
assert.deepEqual(repairValidation(missing,units,'th').accepted,ids.slice(0,-1));checks++;
let payloads=0;
const oldFetch=globalThis.fetch;
try {
 for(const spec of localProviderCatalog()) for (const corrupt of [false,true]) {
  const history=[{anchor:true,user:'UNCHANGED_SOURCE\n<<I1_P0:Hello>>',assistant:'<<I1_P0:สวัสดี>>'}];
  const copy=structuredClone(history);const calls=[];
  const ai={provider:spec.id,model:'alignment-fixture',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
   prompt:'',translation_mode:'conversation',style_examples:false,thinking:'off',
   model_capabilities:{limits:{contextTokens:65536},structuredOutput:{supported:false},reasoning:{supported:false,control:'none'}},
   conversation:{branch:'repair',origins:[10,26].map(order=>{const unitIds=ids.filter(id=>id.startsWith(`I${order}_`));
    return {pageId:`page-I${order}`,pageOrder:order,unitIds,originalIds:unitIds.map(id=>'original-'+id)};})}};
  globalThis.fetch=async(url,init)=>{
   calls.push(JSON.parse(init.body));const content=[...ids.map(id=>`<<${id}:คำแปลภาษาไทย>>`),
    ...(corrupt?['<<I26_P11:ข้อความบริบทที่ไม่ควรตอบ>>']:[])].join('\n');
   const data=spec.protocol==='ollama'?{message:{content},done:true,done_reason:'stop',prompt_eval_count:100,eval_count:20}:
    {choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
   return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
  };
  const answer=await translateWithLocalOpenAi(units,{ai,canonicalPrompt:BUNDLED_CANONICAL_PROMPT_PLANS.th,
   targetLang:'th',sourceLang:'en',conversationContext:{prepare:input=>prepareConversation({...input,ai,
    state:{history,revision:1,scope:'alignment-fixture',storage:'memory'}}),messages:appendPreparedMessages,capture(){}}});
  assert.equal(calls.length,1,'one generation even when alignment fails');checks++;
  assert.deepEqual(history,copy);checks++;
  assert.deepEqual(calls[0].messages.slice(1,3),[{role:'user',content:copy[0].user},{role:'assistant',content:copy[0].assistant}]);checks++;
  assert.deepEqual(answer.meta.alignmentUncertainIds,corrupt?ids.slice(1):[]);checks++;
  assert.deepEqual(repairValidation(answer,units,'th').accepted,corrupt?ids.slice(0,1):ids);checks++;
  assert.equal(answer.meta.usage.inputTokens,100);assert.equal(answer.meta.usage.outputTokens,20);checks++;
  if(corrupt){assert.deepEqual(answer.missing,ids.slice(1));assert.deepEqual(answer.meta.omittedIds,ids.slice(1));checks++;}
  payloads++;
 }
} finally {globalThis.fetch=oldFetch;}
console.log(`PASS ${checks} checks; ${payloads} actual Direct Local fetch payloads across ${localProviderCatalog().length} runtimes, no added calls, unchanged committed history, repair quarantine/valid sparse IDs, receipt alias replay`);
