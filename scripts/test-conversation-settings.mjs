import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAiProfiles,updateAiProfile,resolveAiProfile} from '../src/shared/ai-profiles.js';
import {createAiProfileActivationController,resolveEffectiveAiProfile,buildEffectiveAiPayload} from '../src/shared/ai-profile-activation.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {localAiPreset,localProviderCatalog,localProviderContinuationStrategy,localProviderTranslationMode,resolveLocalProvider} from '../src/shared/ai/providers/local-registry.js';
import {cloudProviderCatalog} from '../src/shared/ai/providers/cloud-registry.js';
import {createAiProfileController} from '../src/popup/controllers/ai-profile-controller.js';
import {resolveJobAiProfile} from '../src/background/ai-profile-resolver.js';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {getCanonicalPrompt} from '../src/background/ai/prompt-cache.js';
import {createAiWireRecorder} from '../src/background/ai/wire-trace.js';
const defaults={thinking:'off',memoryMode:'off',styleExamples:true,translationMode:'conversation',conversationReset:'0'};
const target={provider:'huggingface',model:'fixture',endpoint:'https://router.huggingface.co/v1',runtime:'cloud'};
let state=createAiProfiles();
assert.equal(resolveAiProfile(state,{...target,defaults:{}}).profile.translationMode,'conversation','migrate missing option to new default');
state=updateAiProfile(state,{...target,defaults,patch:{translationMode:'independent'},select:true,now:1});
assert.equal(resolveAiProfile(state,{...target,defaults}).profile.translationMode,'independent','stored Independent preference must remain frozen for later re-enable');
assert.equal(resolveAiProfile(state,{...target,model:'another',defaults}).profile.translationMode,'conversation');
let controller=createAiProfileActivationController({state,defaults});
let selected=resolveEffectiveAiProfile(controller.select(target,{language:'th'}));
for(const engine of ['runsextension','runsapi']) assert.equal(buildEffectiveAiPayload(selected,{engine}).ai.translation_mode,'conversation');
state=updateAiProfile(state,{...target,defaults,patch:{translationMode:'conversation',conversationReset:'new-session'},select:true,now:2});
controller=createAiProfileActivationController({state,defaults});selected=resolveEffectiveAiProfile(controller.select(target,{language:'th'}));
const a=buildEffectiveAiPayload(selected,{engine:'runsextension'}),b=buildEffectiveAiPayload(selected,{engine:'runsapi'});
assert.deepEqual(a,b);assert.equal(a.ai.conversation_reset,'new-session');assert.equal(a.ai.translation_mode,'conversation');
assert.equal(a.ai.style_examples,true,'Conversation must report its fixed twenty-example anchor');assert.equal(a.ai.memory_mode,'off','session history setting does not rewrite Series memory');
const localTarget={provider:'ollama',model:'fixture-local',endpoint:'http://127.0.0.1:11434',runtime:'local'};
state=updateAiProfile(state,{...localTarget,defaults,patch:{translationMode:'conversation',styleExamples:true},select:true,now:3});
const local=resolveEffectiveAiProfile(createAiProfileActivationController({state,defaults}).select(localTarget,{language:'th'}));
assert.equal(buildEffectiveAiPayload(local).ai.translation_mode,'independent');
assert.equal(buildEffectiveAiPayload(local).ai.style_examples,true);
const nativeTarget={provider:'lmstudio',model:'fixture-native',endpoint:'http://127.0.0.1:1234/v1',runtime:'local'};
state=updateAiProfile(state,{...nativeTarget,defaults,patch:{translationMode:'conversation'},select:true,now:4});
assert.equal(resolveAiProfile(state,{...nativeTarget,defaults}).profile.translationMode,'conversation',
  'a saved LM Studio Conversation profile is not rewritten during activation');
const native=resolveEffectiveAiProfile(createAiProfileActivationController({state,defaults}).select(nativeTarget,{language:'th'}));
assert.equal(native.translationMode,'independent','saved LM Studio Conversation never overrides the assigned Local mode');
assert.equal(buildEffectiveAiPayload(native).ai.translation_mode,'independent');
const localChoices=[...localProviderCatalog().map(spec=>({id:spec.id,endpoint:spec.baseUrl})),
  {id:'customlocal',endpoint:'http://127.0.0.1:4567/v1'}];
assert.equal(localChoices.length,10,'all ten Local picker choices have a continuation policy');
for(const {id,endpoint} of localChoices){
  const active=resolveEffectiveAiProfile(createAiProfileActivationController({state,defaults}).select({
    provider:id,model:`${id}-fixture`,endpoint,runtime:'local'}, {language:'th'}));
  const mode='independent';
  assert.equal(localProviderTranslationMode(id),mode,`${id}: provider-owned wire strategy`);
  assert.equal(active.translationMode,mode,`${id}: effective profile mode`);
  for(const engine of ['runsextension','runsapi'])
    assert.equal(buildEffectiveAiPayload(active,{engine}).ai.translation_mode,mode,
      `${id}/${engine}: activation must match the selected provider's endpoint policy`);
  assert.equal(localProviderContinuationStrategy(id),id==='lmstudio'?'native_response_cursor':'message_replay',
    `${id}: the optional native cursor is separate from the assigned Local mode`);
}
assert.equal(cloudProviderCatalog().length,9,'all nine Cloud picker choices are covered');
for(const spec of cloudProviderCatalog()) {
  const cloud=resolveEffectiveAiProfile(createAiProfileActivationController({state,defaults}).select({
    provider:spec.id,model:`${spec.id}-fixture`,endpoint:spec.baseUrl,runtime:'cloud'}, {language:'th'}));
  assert.equal(cloud.translationMode,'conversation',`${spec.id}: Cloud assignment`);
  for(const engine of ['runsextension','runsapi'])
    assert.equal(buildEffectiveAiPayload(cloud,{engine}).ai.translation_mode,'conversation',
      `${spec.id}/${engine}: Cloud always dispatches Conversation`);
}
// Exercise the actual popup hydration and background activation boundaries. A
// stored LM Studio Conversation preference is retained but never dispatched.
for(const {id,endpoint} of localChoices) {
  const stored={aiProvider:id,aiBaseUrl:endpoint,aiModel:`${id}-fixture`};
  const els={aiProvider:{value:id},aiBaseUrl:{value:endpoint},aiModel:{value:stored.aiModel},
    aiTranslationMode:{value:'conversation',disabled:true},aiThinking:{value:'minimum'},
    aiPageImage:{checked:false},aiMemoryMode:{value:'off'},aiStyleExamples:{checked:true,disabled:false},
    aiStyleExamplesWrap:{style:{}},aiLocalCapacityMode:{value:'auto'},
    aiLocalManualConcurrency:{value:'1'},aiPrompt:{value:''}};
  const stateUi={desiredAiModel:stored.aiModel,desiredLang:'th'};
  const popup=createAiProfileController({els,state:stateUi,setStorage:async patch=>Object.assign(stored,structuredClone(patch))});
  await popup.initialize(stored);
  assert.equal(els.aiTranslationMode.value,'independent',`${id}: popup renders Independent`);
  assert.equal(els.aiStyleExamples.disabled,false,`${id}: Independent exposes style examples`);
  assert.equal(stored.aiProfilesV1.providers[stored.aiProfilesV1.active.providerIdentity]
    .models[stored.aiModel].profile.translationMode,'conversation',
    `${id}: migrating a saved flat preference leaves the original setting untouched`);
  els.aiModel.value=`${id}-new-model`;
  popup.selectModel(els.aiModel.value);
  await popup.saveProfile({});
  const identity=stored.aiProfilesV1.active.providerIdentity;
  assert.equal(stored.aiProfilesV1.providers[identity].models[els.aiModel.value].profile.translationMode,'independent',
    `${id}: fresh Local profile default is Independent`);
  const job=await resolveJobAiProfile(stored,{language:'th'});
  assert.equal(job.settings.aiTranslationMode,'independent',`${id}: background resolves Independent`);
}
const legacyJob=await resolveJobAiProfile({
  aiProvider:'lmstudio',aiBaseUrl:nativeTarget.endpoint,aiModel:nativeTarget.model,
  aiProfileStorageVersion:4,aiProfilesV1:state,aiProfileCredentialsV1:{},aiProfilePromptsV1:{},
},{language:'th'});
assert.equal(legacyJob.settings.aiTranslationMode,'independent',
  'an existing saved LM Studio Conversation preference cannot force the job to Conversation');
for(const spec of cloudProviderCatalog()) {
  const stored={aiProvider:spec.id,aiBaseUrl:spec.baseUrl,aiModel:`${spec.id}-fixture`,aiKey:'fixture-key'};
  const els={aiProvider:{value:spec.id},aiBaseUrl:{value:spec.baseUrl},aiModel:{value:stored.aiModel},
    aiTranslationMode:{value:'independent',disabled:true},aiThinking:{value:'minimum'},
    aiPageImage:{checked:false},aiMemoryMode:{value:'off'},aiStyleExamples:{checked:true,disabled:false},
    aiStyleExamplesWrap:{style:{}},aiLocalCapacityMode:{value:'auto'},
    aiLocalManualConcurrency:{value:'1'},aiPrompt:{value:''}};
  const popup=createAiProfileController({els,state:{desiredAiModel:stored.aiModel,desiredLang:'th'},
    setStorage:async patch=>Object.assign(stored,structuredClone(patch))});
  await popup.initialize(stored);
  assert.equal(els.aiTranslationMode.value,'conversation',`${spec.id}: popup renders Conversation`);
  assert.equal(els.aiStyleExamples.disabled,true,`${spec.id}: Conversation hides style examples`);
  const job=await resolveJobAiProfile(stored,{language:'th'});
  assert.equal(job.settings.aiTranslationMode,'conversation',`${spec.id}: background resolves Conversation`);
}
const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
assert.ok(html.indexOf('ai-translation-mode')>html.indexOf('Optional Cloud-only request-rate cap'));
assert.ok(html.indexOf('ai-translation-mode')<html.indexOf('<section class="panel" id="panel-tools"'));
assert.ok(html.includes('value="conversation" selected'));assert.ok(html.includes('value="independent">Independent</option>'));assert.match(html,/id="ai-translation-mode"\s+disabled/);
assert.match(html,/All Local AI providers, including LM Studio, use Independent/);
let called=0;const oldFetch=globalThis.fetch;
try{
 globalThis.fetch=()=>{called++;throw new Error('Unexpected network');};
 await assert.rejects(translateViaServer([{id:'p',text:'Hello'}],{ai:{translation_mode:'conversation'},base:'http://localhost:7860',targetLang:'th',capabilities:{}}),{code:'ai_conversation_unsupported'});
 assert.equal(called,0,'unsupported API must reject before spending a generation');
} finally{globalThis.fetch=oldFetch;}
const nativeAdapter=resolveLocalProvider(localAiPreset('lmstudio'),'lmstudio');
const requests=[];
try {
  globalThis.fetch=async (url,init)=>{
    assert.match(String(url),/\/api\/v1\/chat$/);
    requests.push(JSON.parse(init.body));
    return Response.json({model_instance_id:'fixture-native',output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],
      stats:{input_tokens:44,total_output_tokens:9,reasoning_output_tokens:0}});
  };
  for(const current of ['Translate the first sentence','Translate the next sentence'])
    await nativeAdapter.generate({model:'fixture-native',messages:[
      {role:'system',content:'Translate to Thai'},{role:'user',content:current}],
      outputTokens:96,thinkingMode:'off',thinkingCapability:{supported:false,
        supported_efforts:[],source:'lmstudio_native_loaded_instance'}},{});
  const claimsSchema={supported:true,contract:'tp.translation.schema-object/1',source:'stale_profile'};
  const contracts=[];
  const result=await translateWithLocalOpenAi([{id:'raw-0',text:'Hello'}],{
    ai:{provider:'lmstudio',model:'fixture-native',base_url:'http://localhost:1234/v1',
      local_adapter:localAiPreset('lmstudio'),thinking:'off',translation_mode:'independent',
      style_examples:false,prompt:'',model_capabilities:{reasoning:{supported:false,
        supported_efforts:[],source:'lmstudio_native_loaded_instance'},structuredOutput:claimsSchema}},
    canonicalPrompt:await getCanonicalPrompt('','th',{wantMemo:false}),targetLang:'th',sourceLang:'en',
    wireTrace:(stage,record)=>{if(stage==='contractSelection')contracts.push(record);},
  });
  assert.equal(result.translations[0].text,'สวัสดี');
  assert.equal(requests.at(-1).store,false);
  assert.equal(contracts.at(-1).requested,'tp.translation.schema-object/1',
    'diagnostics preserve a stale capability claim');
  assert.equal(contracts.at(-1).selected,'tp.translation.compact-records/1',
    'native LM Studio always uses the only supported translation envelope');
  const beforeUnsupported=requests.length;
  await assert.rejects(nativeAdapter.generate({model:'fixture-native',messages:[
    {role:'system',content:'Translate'},{role:'user',content:'Hello'}],
    outputTokens:96,thinkingMode:'off',thinkingCapability:{supported:false},
    responseSchema:{type:'object'}},{}),error=>
    error.code==='local_provider_response_contract'&&error.requestDispatched===false);
  assert.equal(requests.length,beforeUnsupported,
    'an explicitly requested unsupported schema rejects before any provider POST');
  const unexpectedCursor='resp_private_unexpected';
  const badBodies=[],relayCalls=[];
  const recorder=createAiWireRecorder({enabled:true,operationId:'stateless-lmstudio',
    identity:{route:'direct-local',provider:'lmstudio'},apiBase:'http://fixture.invalid',
    relay:{path:'/relay',token:'fixture-token'},fetchImpl:async (_url,init)=>{
      relayCalls.push(JSON.parse(init.body));return {ok:true,status:202};
    }});
  const statelessRequest={model:'fixture-native',messages:[
    {role:'system',content:'Translate to Thai'},{role:'user',content:'Hello'}],
    outputTokens:96,thinkingMode:'off',thinkingCapability:{supported:false,
      supported_efforts:[],source:'lmstudio_native_loaded_instance'}};
  await assert.rejects(nativeAdapter.generate({...statelessRequest,
    providerConversation:{enabled:false,previousResponseId:'resp_unexpected_stale'}},{}),error=>
    error.code==='local_provider_response_contract'&&error.requestDispatched===false,
    'a disabled/stale Conversation object cannot put a cursor on Independent wire');
  assert.equal(requests.length,3,'the stray cursor is rejected before any provider POST');
  for(const transport of ['stream','json']) {
    globalThis.fetch=async (url,init)=>{
      assert.match(String(url),/\/api\/v1\/chat$/);
      badBodies.push(JSON.parse(init.body));
      const result={model_instance_id:'fixture-native',response_id:unexpectedCursor,
        output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],
        stats:{input_tokens:44,total_output_tokens:9}};
      if(transport==='json') return Response.json(result);
      const frame=(type,data)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;
      return new Response(frame('chat.start',{model_instance_id:'fixture-native'})+
        frame('message.delta',{content:'<<TP_P0:สวัสดี>>'})+
        frame('chat.end',{result}),{headers:{'content-type':'text/event-stream'}});
    };
    await assert.rejects(nativeAdapter.generate(statelessRequest,{wireTrace:recorder}),error=>
      error.code==='local_provider_response_contract'&&error.requestDispatched===true&&
      error.providerResponded===true&&error.diagnostics?.validatorSubtype==='unexpected_stateless_response_id'&&
      !JSON.stringify({message:error.message,diagnostics:error.diagnostics}).includes(unexpectedCursor),
      `${transport}: a provider cursor returned for store:false is an explicit protocol error`);
  }
  assert.equal(badBodies.length,2,'unexpected cursor never causes a retry');
  assert.ok(badBodies.every(body=>body.store===false&&!Object.hasOwn(body,'previous_response_id')));
  assert.equal(await recorder.flush(1000),true);
  assert.ok(relayCalls.some(event=>event.stage==='providerResponse'),
    'opt-in wire trace records the rejected stream without relaying its raw bytes');
  assert.ok(!JSON.stringify(relayCalls).includes(unexpectedCursor),
    'opt-in Local diagnostic relay redacts the unexpected provider cursor');
} finally {globalThis.fetch=oldFetch;}
assert.equal(requests.length,3);
for(const [index,body] of requests.slice(0,2).entries()) {
  assert.equal(body.store,false,'Independent never retains an LM Studio response thread');
  assert.equal(body.system_prompt,'Translate to Thai','Independent repeats only the current System prompt');
  assert.equal(body.input,index===0?'Translate the first sentence':'Translate the next sentence');
  assert.equal(Object.hasOwn(body,'previous_response_id'),false,'Independent never sends a response cursor');
}
console.log('PASS 10 Local Independent / 9 Cloud Conversation popup, profile, job and LM Studio native HTTP routing');
