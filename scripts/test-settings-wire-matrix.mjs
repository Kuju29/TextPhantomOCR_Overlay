/** Real settings reader -> job payload builders -> Cloud transport; fake HTTP only.
 * Canonical profile activation/snapshot is exercised separately by the existing
 * profile and execution-plan suites, not mislabelled as a full installed UI E2E. */
import assert from 'node:assert/strict';
const state={},requests=[];
globalThis.chrome={runtime:{getManifest:()=>({version:'test'})},storage:{local:{
 get(keys,cb){cb(Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,structuredClone(state[k])])):typeof keys==='string'?{[keys]:structuredClone(state[keys])}:{...keys,...structuredClone(state)});},
 set(p,cb){Object.assign(state,structuredClone(p));cb?.();}}},contextMenus:{removeAll(){},create(){}}};
const {readFullSettings}=await import('../src/shared/settings.js');
const {buildAiPayload,buildLayoutPayload,buildLimitsPayload,buildRatePayload}=await import('../src/background/context-menu.js');
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
const {resolveEffectiveAiProfile}=await import('../src/shared/ai-profile-activation.js');
const {migrateAiProfiles}=await import('../src/shared/ai-profiles.js');
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
const {buildOllamaGeneration}=await import('../src/shared/ai/providers/local-ollama.js');
const {createRateSettingsController}=await import('../src/popup/controllers/rate-settings-controller.js');
globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);requests.push({url,body,headers:init.headers});
 const result={schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'คำตอบ'})),missing:[],meta:{resolvedProvider:body.provider.id,resolvedModel:body.provider.model,generationAttempts:1,providerAttempts:1}};
 const progressive=init.headers.Accept==='application/x-ndjson';
 return new Response(progressive?JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n':JSON.stringify(result),
  {status:200,headers:{'content-type':progressive?'application/x-ndjson':'application/json'}});};
state.aiSeriesMemory={fixture:{glossary:[{src:'name',tgt:'ชื่อ'}],characters:[{name:'role'}],state:'scene',prevContext:[{src:'source',tgt:'target'}]}};
let checks=0;
for(const engineMode of ['extension','api'])for(const aiMemoryMode of ['off','terms','full'])for(const enabled of [false,true]){
 Object.assign(state,{mode:'lens_text',sources:'ai',engineMode,lang:enabled?'th':'en',aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',aiModel:enabled?'model-b':'model-a',aiCloudKey:'FIXTURE_ONLY_SECRET',aiPromptByLang:{th:'STYLE_TH',en:'STYLE_EN'},aiThinking:enabled?'on':'off',aiPageImage:enabled?'always':'off',aiMemoryMode,rateLimitEnabled:enabled,rateRpm:42,rateBurst:3,relayoutTranslated:enabled});
 const settings=await readFullSettings();const caps={structured_output:{supported:enabled},reasoning:{supported:true},limits:{maxOutputTokens:4096}};
 // Capability is supplied by the existing canonical-profile resolution stage,
 // not invented by readFullSettings (which intentionally does not own it).
 settings.aiModelCapabilities=caps;
 const ai=await buildAiPayload('lens_text','ai',settings,'fixture');
 const rate=buildRatePayload('lens_text','ai',settings);
 assert.equal(settings.engineMode,engineMode);assert.equal(ai.prompt,enabled?'STYLE_TH':'STYLE_EN');
 assert.deepEqual(buildLayoutPayload('lens_text',settings),{relayout_translated:enabled});
 assert.equal(buildAiPayload.constructor.name,'AsyncFunction');
 for(const repair of [false,true]){
  await translateViaServer([{id:'g0',text:'Test'}],{base:'http://fixture.invalid',capabilities:{aiConversation:'tp.conversation/1'},ai:{...ai,...(repair?{repair_reason:'wrong_target_script'}:{})},rate,targetLang:settings.lang,sourceLang:'ja',imageDataUri:ai.send_image?'data:image/png;base64,AAAA':'',operationId:`settings-${++checks}`,repairClaim:repair?{runId:'fixture',taskId:'task',token:'LOCAL_TEST_TOKEN'}:null});
  const q=requests.at(-1);const b=q.body;
  assert.equal(b.targetLang,state.lang);assert.equal(b.provider.model,state.aiModel);assert.equal(b.provider.id,'openrouter');assert.equal(b.provider.baseUrl,state.aiBaseUrl);assert.equal(b.provider.thinking,state.aiThinking);assert.equal(b.provider.apiKey,'FIXTURE_ONLY_SECRET');
  assert.equal(b.provider.outputContract,'compact_markers_v1');assert.equal(b.provider.modelCapabilities.structured_output.supported,enabled);
  assert.equal(Boolean(b.image),enabled);assert.equal(b.memory.glossary.length,aiMemoryMode==='off'?0:1);assert.equal(b.memory.characters.length,aiMemoryMode==='full'?1:0);assert.equal(b.memory.previousContext.length,aiMemoryMode==='full'?1:0);
  assert.equal(b.memory.enabled,aiMemoryMode==='full');assert.equal(b.rate.enabled,enabled);assert.equal(b.rate.rpm,enabled?42:0);
  assert.equal(b.repair.enabled,false);if(repair){assert.equal(b.repair.reason,'wrong_target_script');assert.match(q.url,/tasks\/task\/translate$/);}else assert.equal(b.repair.reason,undefined);
 }
}
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',aiModel:'local-fixture',aiLocalThinking:'on',aiLocalCapacityMode:'manual',aiLocalManualConcurrency:3,rateLimitEnabled:true,rateRpm:500});
let s=await readFullSettings();let local=await buildAiPayload('lens_text','ai',s,'fixture');
assert.equal(local.api_key,'');assert.equal(local.thinking,'on');assert.equal(local.local_adapter.protocol,'ollama');assert.equal(buildRatePayload('lens_text','ai',s).enabled,false);assert.equal(buildLimitsPayload(s).manualConcurrency,3);checks++;
// Browser restart: an identity-bound exact-model capability must survive the
// settings reader and reach the Direct Local request decision. Stale identity
// hints must never authorize a native thinking field.
Object.assign(state,{aiLocalThinking:'off',aiLocalCapabilityHint:{provider:'ollama',
 baseUrl:'http://127.0.0.1:11434',model:'local-fixture',recommendedMax:1,
 modelCapabilities:{reasoning:{supported:true,control:'boolean',source:'ollama-api-show'},
 structuredOutput:{supported:true},limits:{contextTokens:8192}}}});
s=await readFullSettings();local=await buildAiPayload('lens_text','ai',s,'fixture');
assert.equal(local.model_capabilities.reasoning.control,'boolean');
assert.equal(buildOllamaGeneration({model:local.model,messages:[],outputTokens:64,
 thinkingMode:local.thinking}).think,false);checks++;
for(const mismatch of [
 {aiProvider:'lmstudio'}, {aiBaseUrl:'http://127.0.0.1:1234'}, {aiModel:'other-model'}]){
 const stale=await buildAiPayload('lens_text','ai',{...s,...mismatch},'fixture');
 assert.deepEqual(stale.model_capabilities,{});
 assert.equal(Object.hasOwn(buildOllamaGeneration({model:stale.model,messages:[],outputTokens:64,
  thinkingMode:stale.model_capabilities.reasoning?.control==='boolean'?stale.thinking:'default'}),'think'),false);
 checks++;
}
assert.equal(await buildAiPayload('lens_text','original',s,'fixture'),null);assert.equal(buildLayoutPayload('lens_images',s),null);assert.equal(buildRatePayload('lens_text','original',s),null);checks++;
assert.throws(()=>buildRatePayload('lens_text','ai',{...s,aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',rateLimitEnabled:true,rateProfile:'auto',rateRpm:42}),
  e=>e.code==='invalid_manual_rate_cap',
  'a checked cap with provider-managed profile must fail before request dispatch');checks++;
const unsupported=resolveEffectiveAiProfile({prompt:'STYLE',promptMode:'replace',profile:{temperature:.2,tokenPolicy:{mode:'manual',maxOutputTokens:1000}}});
assert(unsupported.unsupported.includes('temperature'));assert(unsupported.unsupported.includes('tokenPolicy'));checks++;

// A missing legacy selection uses the saved "lowest available" policy through
// activation, job construction, and the server-direct wire.
const autoMigrated=migrateAiProfiles({stored:undefined,legacy:{aiProvider:'openrouter',
 aiBaseUrl:'https://openrouter.ai/api/v1',aiModel:'auto-fixture',aiCloudKey:'AUTO_SECRET',
 aiPromptByLang:{th:'AUTO_STYLE'},lang:'th'}});
Object.assign(state,{aiProfileStorageVersion:4,aiProfilesV1:autoMigrated.state,
 aiProfileCredentialsV1:autoMigrated.credentials,aiProfilePromptsV1:autoMigrated.prompts,
 aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',aiModel:'auto-fixture',lang:'th'});
const autoSnapshot=await resolveJobAiProfile(await readFullSettings(),{language:'th'});
assert.equal(autoSnapshot.settings.aiThinking,'minimum');
const autoJobAi=await buildAiPayload('lens_text','ai',autoSnapshot.settings,'fixture');
assert.equal(autoJobAi.thinking,'minimum');
await translateViaServer([{id:'g0',text:'Auto'}],{base:'http://fixture.invalid',capabilities:{aiConversation:'tp.conversation/1'},ai:autoJobAi,
 targetLang:'th',sourceLang:'ja',operationId:`settings-${++checks}`});
assert.equal(requests.at(-1).body.provider.thinking,'minimum');
Object.assign(state,{rateLimitEnabled:true,rateProfile:'custom',rateRpm:0,rateBurst:1});
const incompleteRate=await readFullSettings();
assert.equal(incompleteRate.rateRpm,0,'Empty saved RPM must not become a hidden default');
assert.throws(()=>buildRatePayload('lens_text','ai',incompleteRate),
  e=>e.code==='invalid_manual_rate_cap',
  'An incomplete Cloud manual cap must fail before request dispatch');
Object.assign(state,{rateRpm:42,rateBurst:0});
const missingCloudBurst=await readFullSettings();
assert.throws(()=>buildRatePayload('lens_text','ai',missingCloudBurst),
  e=>e.code==='invalid_manual_rate_cap',
  'An empty burst must not silently fall back to provider-managed');
Object.assign(state,{rateRpm:'bad',rateBurst:4});
const malformedCloudRpm=await readFullSettings();
assert.equal(malformedCloudRpm.rateRpm,0);
assert.throws(()=>buildRatePayload('lens_text','ai',malformedCloudRpm),
  e=>e.code==='invalid_manual_rate_cap',
  'An invalid saved Cloud RPM must not become a hidden 30 RPM cap');
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',
 aiLocalRateLimitEnabled:true,aiLocalRateRpm:0,aiLocalRateBurst:1});
const missingLocalRpm=await readFullSettings();
assert.equal(missingLocalRpm.aiLocalRateRpm,0,'A saved empty Local RPM must remain empty');
assert.throws(()=>buildRatePayload('lens_text','ai',missingLocalRpm),
 e=>e.code==='invalid_manual_rate_cap',
 'An empty Local RPM must fail before request dispatch');
Object.assign(state,{aiLocalRateRpm:6,aiLocalRateBurst:0});
const missingLocalBurst=await readFullSettings();
assert.equal(missingLocalBurst.aiLocalRateBurst,0,'A saved empty Local burst must remain empty');
assert.throws(()=>buildRatePayload('lens_text','ai',missingLocalBurst),
 e=>e.code==='invalid_manual_rate_cap',
 'An empty Local burst must not silently turn off the selected cap');
Object.assign(state,{aiLocalRateRpm:'bad',aiLocalRateBurst:1});
const malformedLocalRpm=await readFullSettings();
assert.equal(malformedLocalRpm.aiLocalRateRpm,0);
assert.throws(()=>buildRatePayload('lens_text','ai',malformedLocalRpm),
 e=>e.code==='invalid_manual_rate_cap',
 'An invalid saved Local RPM must not become a hidden 6 RPM cap');
Object.assign(state,{aiLocalRateRpm:601,aiLocalRateBurst:1});
const excessiveLocalRpm=await readFullSettings();
assert.equal(excessiveLocalRpm.aiLocalRateRpm,601);
assert.throws(()=>buildRatePayload('lens_text','ai',excessiveLocalRpm),
 e=>e.code==='invalid_manual_rate_cap',
 'An out-of-range enabled Local RPM must not be silently clamped');
// The popup can show example numbers while a disabled cap has stored zeroes.
// When the user checks the switch, the numbers they saw must be stored in the
// SAME write as enabled=true, or the next job would fail after appearing ready.
const toggleEvents={};
const rateElement=(id,value='')=>({id,value,checked:false,
  addEventListener(type,handler){toggleEvents[`${id}:${type}`]=handler;}});
const cloudSwitch=rateElement('cloudSwitch');
const localSwitch=rateElement('localSwitch');
const cloudProfile=rateElement('cloudProfile','custom');
const cloudRpm=rateElement('cloudRpm','30');
const cloudBurst=rateElement('cloudBurst','4');
const localRpm=rateElement('localRpm','6');
const localBurst=rateElement('localBurst','1');
const rateController=createRateSettingsController({
 els:{rateLimitEnabled:cloudSwitch,rateProfile:cloudProfile,rateRpm:cloudRpm,
  rateBurst:cloudBurst,ratePresetHint:{textContent:'',dataset:{}},
  aiProvider:rateElement('provider','openrouter'),aiLocalRateEnabled:localSwitch,
  aiLocalRateRpm:localRpm,aiLocalRateBurst:localBurst,aiLocalRateHint:{textContent:''}},
 constants:{presets:{},fallback:{rpm:30,burst:4},rpmMin:1,rpmMax:600,burstMin:1,burstMax:60},
 persist:async patch=>Object.assign(state,structuredClone(patch)),toggleUi:()=>{},
});
rateController.bind();
Object.assign(state,{aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',
 rateLimitEnabled:false,rateProfile:'custom',rateRpm:0,rateBurst:0});
cloudSwitch.checked=true;
await toggleEvents['cloudSwitch:change']();
const toggledCloudRate=buildRatePayload('lens_text','ai',await readFullSettings());
assert.deepEqual(toggledCloudRate,{enabled:true,rpm:30,burst:4},
 'Cloud off+stored zero → visible defaults → check cap must persist the selected visible limit');
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',
 aiLocalRateLimitEnabled:false,aiLocalRateRpm:0,aiLocalRateBurst:0});
localSwitch.checked=true;
await toggleEvents['localSwitch:change']();
const toggledLocalRate=buildRatePayload('lens_text','ai',await readFullSettings());
assert.deepEqual(toggledLocalRate,{enabled:true,rpm:6,burst:1,unlimited:false},
 'Local off+stored zero → visible defaults → check cap must persist the selected visible limit');
checks++;
console.log(`PASS ${checks} settings boundary checks: reader/builders/initial+repair Cloud body, Local key/thinking/capacity/rate isolation, non-AI and explicitly unsupported profile fields; external HTTP mocked.`);
