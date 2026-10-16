/** Real settings reader -> job payload builders -> Cloud transport; fake HTTP only.
 * .54 adds real popup events/profile persistence/immutable snapshots below.
 * Browser DOM, storage and HTTP are synthetic; no installed-browser or upstream
 * provider inference success is claimed by this API-boundary suite. */
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const {seriesMemoryKey}=await import('../src/shared/series.js');
const SERIES='reader.invalid/manga/settings-fixture';
const memoryFor=lang=>({glossary:[{src:'name',tgt:lang==='th'?'ชื่อ':'Name'}],characters:[{name:lang==='th'?'บทบาท':'Role'}],state:lang==='th'?'ฉากภาษาไทย':'English scene',prevContext:[{src:'source',tgt:lang==='th'?'เนื้อเรื่องภาษาไทย':'English story'}]});
const state={tpDataConsentV1:{version:1,granted:true,at:1}},requests=[]; // 10494: Paid/Login user allowed account data
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
globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);requests.push({url,body,headers:init.headers});
 const result={schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'คำตอบ'})),missing:[],meta:{resolvedProvider:body.provider.id,resolvedModel:body.provider.model,generationAttempts:1,providerAttempts:1}};
 const progressive=init.headers.Accept==='application/x-ndjson';
 return new Response(progressive?JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n':JSON.stringify(result),
  {status:200,headers:{'content-type':progressive?'application/x-ndjson':'application/json'}});};
state.aiSeriesMemory=Object.fromEntries(['th','en'].map(lang=>[seriesMemoryKey(SERIES,lang),memoryFor(lang)]));
let checks=0;
for(const engineMode of ['extension','api'])for(const aiMemoryMode of ['off','terms','full'])for(const enabled of [false,true]){
 Object.assign(state,{mode:'lens_text',sources:'ai',engineMode,lang:enabled?'th':'en',aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',aiModel:enabled?'model-b':'model-a',aiCloudKey:'FIXTURE_ONLY_SECRET',aiPromptByLang:{th:'STYLE_TH',en:'STYLE_EN'},aiThinking:enabled?'on':'off',aiPageImage:enabled?'always':'off',aiMemoryMode,rateLimitEnabled:enabled,rateRpm:42,rateBurst:3,relayoutTranslated:enabled});
 const settings=await readFullSettings();const caps={structured_output:{supported:enabled},reasoning:{supported:true},limits:{maxOutputTokens:4096}};
 // Capability is supplied by the existing canonical-profile resolution stage,
 // not invented by readFullSettings (which intentionally does not own it).
 settings.aiModelCapabilities=caps;
 const ai=await buildAiPayload('lens_text','ai',settings,SERIES);
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
  assert.equal(b.memory.enabled,aiMemoryMode==='full');// .68 retired the request-rate cap (replaced by the token ceiling): never sent as enabled.
  assert.equal(b.rate.enabled,false);assert.equal(b.rate.rpm,0);
  assert.equal(b.repair.enabled,false);if(repair){assert.equal(b.repair.reason,'wrong_target_script');assert.match(q.url,/tasks\/task\/translate$/);}else assert.equal(b.repair.reason,undefined);
 }
}
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',aiModel:'local-fixture',aiLocalThinking:'on',aiLocalCapacityMode:'manual',aiLocalManualConcurrency:3,rateLimitEnabled:true,rateRpm:500});
let s=await readFullSettings();let local=await buildAiPayload('lens_text','ai',s,SERIES);
assert.equal(local.api_key,'');assert.equal(local.thinking,'on');assert.equal(local.local_adapter.protocol,'ollama');assert.equal(buildRatePayload('lens_text','ai',s).enabled,false);assert.equal(buildLimitsPayload(s).manualConcurrency,3);checks++;
// Browser restart: an identity-bound exact-model capability must survive the
// settings reader and reach the Direct Local request decision. Stale identity
// hints must never authorize a native thinking field.
Object.assign(state,{aiLocalThinking:'off',aiLocalCapabilityHint:{provider:'ollama',
 baseUrl:'http://127.0.0.1:11434',model:'local-fixture',recommendedMax:1,
 modelCapabilities:{reasoning:{supported:true,control:'boolean',source:'ollama-api-show'},
 structuredOutput:{supported:true},limits:{contextTokens:8192}}}});
s=await readFullSettings();local=await buildAiPayload('lens_text','ai',s,SERIES);
assert.equal(local.model_capabilities.reasoning.control,'boolean');
assert.equal(buildOllamaGeneration({model:local.model,messages:[],outputTokens:64,
 thinkingMode:local.thinking}).think,false);checks++;
for(const mismatch of [
 {aiProvider:'lmstudio'}, {aiBaseUrl:'http://127.0.0.1:1234'}, {aiModel:'other-model'}]){
 const stale=await buildAiPayload('lens_text','ai',{...s,...mismatch},SERIES);
 assert.deepEqual(stale.model_capabilities,{});
 assert.equal(Object.hasOwn(buildOllamaGeneration({model:stale.model,messages:[],outputTokens:64,
  thinkingMode:stale.model_capabilities.reasoning?.control==='boolean'?stale.thinking:'default'}),'think'),false);
 checks++;
}
assert.equal(await buildAiPayload('lens_text','original',s,SERIES),null);assert.equal(buildLayoutPayload('lens_images',s),null);assert.equal(buildRatePayload('lens_text','original',s),null);checks++;
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
const autoJobAi=await buildAiPayload('lens_text','ai',autoSnapshot.settings,SERIES);
assert.equal(autoJobAi.thinking,'minimum');
await translateViaServer([{id:'g0',text:'Auto'}],{base:'http://fixture.invalid',capabilities:{aiConversation:'tp.conversation/1'},ai:autoJobAi,
 targetLang:'th',sourceLang:'ja',operationId:`settings-${++checks}`});
assert.equal(requests.at(-1).body.provider.thinking,'minimum');
Object.assign(state,{rateLimitEnabled:true,rateProfile:'custom',rateRpm:0,rateBurst:1});
const incompleteRate=await readFullSettings();
assert.equal(incompleteRate.rateRpm,0,'Empty saved RPM must not become a hidden default');
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',incompleteRate).enabled,false,'An incomplete Cloud manual cap must fail before request dispatch');
Object.assign(state,{rateRpm:42,rateBurst:0});
const missingCloudBurst=await readFullSettings();
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',missingCloudBurst).enabled,false,'An empty burst must not silently fall back to provider-managed');
Object.assign(state,{rateRpm:'bad',rateBurst:4});
const malformedCloudRpm=await readFullSettings();
assert.equal(malformedCloudRpm.rateRpm,0);
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',malformedCloudRpm).enabled,false,'An invalid saved Cloud RPM must not become a hidden 30 RPM cap');
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',
 aiLocalRateLimitEnabled:true,aiLocalRateRpm:0,aiLocalRateBurst:1});
const missingLocalRpm=await readFullSettings();
assert.equal(missingLocalRpm.aiLocalRateRpm,0,'A saved empty Local RPM must remain empty');
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',missingLocalRpm).enabled,false,'An empty Local RPM must fail before request dispatch');
Object.assign(state,{aiLocalRateRpm:6,aiLocalRateBurst:0});
const missingLocalBurst=await readFullSettings();
assert.equal(missingLocalBurst.aiLocalRateBurst,0,'A saved empty Local burst must remain empty');
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',missingLocalBurst).enabled,false,'An empty Local burst must not silently turn off the selected cap');
Object.assign(state,{aiLocalRateRpm:'bad',aiLocalRateBurst:1});
const malformedLocalRpm=await readFullSettings();
assert.equal(malformedLocalRpm.aiLocalRateRpm,0);
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',malformedLocalRpm).enabled,false,'An invalid saved Local RPM must not become a hidden 6 RPM cap');
Object.assign(state,{aiLocalRateRpm:601,aiLocalRateBurst:1});
const excessiveLocalRpm=await readFullSettings();
assert.equal(excessiveLocalRpm.aiLocalRateRpm,601);
// .68 request-rate cap retired: saved cap values have no effect.
assert.equal(buildRatePayload('lens_text','ai',excessiveLocalRpm).enabled,false,'An out-of-range enabled Local RPM must not be silently clamped');
// The popup rate-cap controls were removed with the retired cap (.68). A cap an
// older popup saved (switch on, numbers set) still cannot throttle a job.
Object.assign(state,{aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',
 rateLimitEnabled:true,rateProfile:'custom',rateRpm:30,rateBurst:4});
const toggledCloudRate=buildRatePayload('lens_text','ai',await readFullSettings());
// .68: the request-rate cap is retired; a stored switch can no longer throttle jobs.
assert.equal(toggledCloudRate.enabled,false,'Cloud request-rate cap retired');
Object.assign(state,{aiProvider:'ollama',aiBaseUrl:'http://127.0.0.1:11434',
 aiLocalRateLimitEnabled:true,aiLocalRateRpm:6,aiLocalRateBurst:1});
const toggledLocalRate=buildRatePayload('lens_text','ai',await readFullSettings());
assert.equal(toggledLocalRate.enabled,false,'Local request-rate cap retired');
checks++;
console.log(`PASS ${checks} settings boundary checks: reader/builders/initial+repair Cloud body, Local key/thinking/capacity/rate isolation, non-AI and explicitly unsupported profile fields; external HTTP mocked.`);

// Exercise the actual popup event/controller/storage path before resolving a
// frozen job. Capture fetch's final serialized extension -> API body. Backend
// provider HTTP generation is a separate Python boundary and is not fabricated.
const {createAiProfileController}=await import('../src/popup/controllers/ai-profile-controller.js');
const {createAiProfileStorageWriter}=await import('../src/popup/controllers/ai-profile-storage-writer.js');
const {createSettingsPersistenceController}=await import('../src/popup/controllers/settings-persistence-controller.js');
const {createPromptController}=await import('../src/popup/controllers/prompt-controller.js');
const {bindPopupEvents}=await import('../src/popup/controllers/popup-event-controller.js');
const {writeProfileChanges}=await import('../src/shared/profile-storage.js');
const {paidEntry}=await import('../src/shared/paid-profile.js');
const {loginEntry}=await import('../src/shared/login-profile.js');
const API='https://settings-api.invalid', MANUAL_MODEL='manual-fixture-model', PAID_MODEL='paid-fixture-model';
const LOGIN_MODEL='web-fixture-model', LOGIN_PROVIDER='login_gemini', ACCOUNT='synthetic-account-scope';
const LOGIN_SESSION='lgs_'+'a'.repeat(48);
const MANUAL_TOKEN='SYNTHETIC_MANUAL_TOKEN', CENTER_TOKEN='SYNTHETIC_CENTER_TOKEN';
const caps={structured_output:{supported:true},reasoning:{supported:true},limits:{maxOutputTokens:4096}};
const uiResults=[], matrix=[], preflight=[];
const sessionState={};
const noOp=()=>{}, settle=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve));};
function element(value='') {
  const handlers=new Map();
  return {value,checked:false,disabled:false,style:{display:''},dataset:{},options:[],textContent:'',
    addEventListener(type,handler){const list=handlers.get(type)||[];list.push(handler);handlers.set(type,list);},
    async emit(type){for(const handler of handlers.get(type)||[])await handler({target:this});},
    replaceChildren(...items){this.options=items;},setAttribute:noOp,removeAttribute:noOp,focus:noOp,
    classList:{toggle:noOp,add:noOp,remove:noOp},querySelector:()=>null};
}
globalThis.document={createElement:()=>element()};
globalThis.window={addEventListener:noOp};
chrome.runtime.id='synthetic-extension-id';
chrome.runtime.sendMessage=(message,callback)=>{
  if(message.type==='AI_PROFILE_PATCH')writeProfileChanges(message.changes).then(
    ()=>callback?.({ok:true}),error=>callback?.({ok:false,error:error.message}));
  else callback?.({ok:true});
};
chrome.storage.onChanged={addListener:noOp};
chrome.storage.local.remove=(keys,callback)=>{for(const key of Array.isArray(keys)?keys:[keys])delete state[key];callback?.();};
chrome.storage.session={
  get(keys,callback){callback(Object.fromEntries(keys.filter(key=>Object.hasOwn(sessionState,key))
    .map(key=>[key,structuredClone(sessionState[key])])));},
  set(patch,callback){Object.assign(sessionState,structuredClone(patch));callback?.();},
};

function jsonResponse(body){return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});}
globalThis.fetch=async(url,init={})=>{
  const parsed=new URL(url);
  assert.equal(parsed.origin,API,'All new HTTP must stay inside the synthetic API fixture');
  if(!init.body){
    preflight.push(parsed.pathname);
    if(parsed.pathname==='/meta')return jsonResponse({paid:{available:true}});
    if(parsed.pathname==='/paid/me')return jsonResponse({models:[{id:PAID_MODEL,model_capabilities:caps}],
      addons:{entitlements:[{code:'ai_login',status:'active'}]}});
    if(parsed.pathname===`/login/providers/${LOGIN_PROVIDER}/models`)return jsonResponse({
      session:{id:LOGIN_SESSION,provider:LOGIN_PROVIDER,account_id:ACCOUNT,transport:'web_endpoint'},
      models:[{id:LOGIN_MODEL,model_capabilities:caps}]});
    // .66 resolver rediscovers this owner's current Login session when none is stored.
    if(parsed.pathname==='/login/providers')return jsonResponse({providers:[{id:LOGIN_PROVIDER,
      session:{id:LOGIN_SESSION,provider:LOGIN_PROVIDER}}]});
    assert.fail('Unexpected synthetic discovery path');
  }
  const body=JSON.parse(init.body);requests.push({url,body,headers:init.headers});
  const result={schema:'tp.ai.result/1',translations:body.units.map(unit=>({id:unit.id,text:body.targetLang==='th'?'คำตอบ':'Answer'})),
    missing:[],meta:{resolvedProvider:body.provider.id,resolvedModel:body.provider.model,generationAttempts:1,providerAttempts:1}};
  return init.headers.Accept==='application/x-ndjson'
    ? new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n',
      {status:200,headers:{'content-type':'application/x-ndjson'}})
    : jsonResponse(result);
};

async function popup(service,engineMode,targetLang) {
  for(const key of Object.keys(state))delete state[key];state.tpDataConsentV1={version:1,granted:true,at:1};
  for(const key of Object.keys(sessionState))delete sessionState[key];
  // Login identifiers belong to chrome.storage.session, not retired local auth.
  Object.assign(sessionState,{loginSessionId:LOGIN_SESSION,loginAccountId:ACCOUNT});
  const initialLang=targetLang==='th'?'en':'th';
  Object.assign(state,{mode:'lens_text',sources:'ai',engineMode,lang:initialLang,
    aiProvider:'openrouter',aiBaseUrl:'https://openrouter.ai/api/v1',aiModel:MANUAL_MODEL,
    aiCloudKey:MANUAL_TOKEN,aiThinking:'off',aiPageImage:'off',aiMemoryMode:'off',
    // Old forced true is not evidence of opt-in: canonical migration defaults OFF.
    aiStyleExamples:true,aiServiceMode:service==='manual'?'manual':'paid',
    paidTranslationSource:service==='login'?'login':'tp',customApiUrl:API,apiUrlDefault:API,
    apiDefaultsFetchedAt:Date.now(),paidApiBase:API,paidSessionToken:CENTER_TOKEN,paidModel:PAID_MODEL,
    loginProvider:LOGIN_PROVIDER,loginModel:LOGIN_MODEL,
    rateLimitEnabled:false,rateProfile:'custom',rateRpm:30,rateBurst:4,
    aiSeriesMemory:Object.fromEntries(['th','en'].map(lang=>[seriesMemoryKey(SERIES,lang),memoryFor(lang)]))});
  const els=new Proxy({}, {get(object,key){return object[key]??=(element());}});
  for(const [key,value] of Object.entries({aiProvider:'openrouter',aiBaseUrl:state.aiBaseUrl,aiModel:MANUAL_MODEL,
    aiKey:MANUAL_TOKEN,lang:initialLang,apiUrl:API,mode:'lens_text',sources:'ai'}))els[key].value=value;
  const uiState={desiredLang:initialLang,desiredAiModel:MANUAL_MODEL,desiredSources:'ai',
    aiPromptDirtyByLang:{},aiPromptByLang:{},paidActive:service!=='manual',
    paidTranslationSource:state.paidTranslationSource,loginModel:LOGIN_MODEL,loginProvider:LOGIN_PROVIDER,
    loginAccountId:ACCOUNT,paidModel:PAID_MODEL};
  const persist=createAiProfileStorageWriter(async patch=>Object.assign(state,structuredClone(patch)));
  const profile=createAiProfileController({els,state:uiState,setStorage:persist});
  await profile.initialize(structuredClone(state));
  const context={active:service!=='manual',source:service==='login'?'login':'tp',apiBase:API,
    model:service==='login'?LOGIN_MODEL:PAID_MODEL,provider:LOGIN_PROVIDER,accountScope:ACCOUNT,capabilities:caps};
  if(service!=='manual'){profile.setPaidContext(context);await persist.whenIdle();}
  assert.equal(els.aiStyleExamples.checked,false,`${service}: unseen/legacy profile must default OFF`);
  const common={els,state:uiState,profileController:profile,providerMetaController:{cancelSchedule:noOp,refresh:noOp,schedule:noOp},
    apiHealthController:{},persist,setStatus:noOp,setFieldMessage:noOp,toggleUi:noOp,canUseAiUi:()=>true,
    isRemoteDefaultApiUrl:()=>false,refreshPromptHistoryButtons:noOp};
  const persistence=createSettingsPersistenceController(common);
  const prompt=createPromptController({...common,setStorage:persist,broadcast:noOp,updatePromptCount:noOp,
    fieldMessageType:()=>'',keyForPrompt:(lang,model)=>profile.promptKey(lang,model),
    saveProfilePrompt:(...args)=>profile.savePrompt(...args)});
  bindPopupEvents({...common,profilePagehideFlush:persistence.profilePagehideFlush,
    localConnectionController:{refreshThinkingCompatibility:noOp},applyPromptForLang:prompt.applyForLang,
    updatePromptCount:noOp,updateAiPromptWarning:noOp,fieldMessageType:()=>'',refreshSeriesMemory:noOp,
    flushPromptForLang:persistence.flushPromptForLang,scheduleSaveAi:persistence.scheduleSaveAi});
  els.lang.value=targetLang;await els.lang.emit('change');
  assert.equal(state.lang,targetLang,'Actual language handler must persist selected target');
  if(service!=='manual'){profile.setPaidContext(context);await persist.whenIdle();}
  const text=`SYNTHETIC_STYLE_${service}_${targetLang}`;
  els.aiPrompt.value=text;await els.aiPrompt.emit('input');await els.aiPrompt.emit('blur');
  // Use the real pagehide flush to cancel its debounce and persist the current
  // textarea. No arbitrary sleeps or replacement prompt persistence logic.
  await persistence.profilePagehideFlush.flush({language:targetLang,model:MANUAL_MODEL,prompt:text,savePrompt:true});
  await persist.whenIdle();await settle();
  const defaultSnapshot=await resolveJobAiProfile(await readFullSettings(),{language:targetLang});
  assert.equal(defaultSnapshot.settings.aiStyleExamples,false,
    `${service}: default OFF must survive canonical profile -> job even without touching the switch`);
  return {els,profile,persist,text};
}

const matrixStart=requests.length;
for(const service of ['manual','paid','login'])for(const engineMode of ['extension','api'])
for(const targetLang of ['th','en'])for(const enabled of [false,true])for(const memoryMode of ['off','terms','full']){
  const {els,profile,persist,text}=await popup(service,engineMode,targetLang);
  els.aiStyleExamples.checked=enabled;await els.aiStyleExamples.emit('change');
  els.aiMemoryMode.value=memoryMode;await els.aiMemoryMode.emit('change');
  els.aiPageImage.checked=enabled;await els.aiPageImage.emit('change');
  els.aiThinking.value=enabled?'on':'off';await els.aiThinking.emit('change');
  // .69 token ceiling through the real popup controls, per service (Login included).
  const ceilingValue=enabled?{manual:12000,paid:13000,login:14000}[service]:null;
  els.aiTokenCeiling.value=enabled?String(ceilingValue):'';
  els.aiTokenCeilingEnabled.checked=enabled;await els.aiTokenCeilingEnabled.emit('change');
  await persist.whenIdle();
  const storedEntry=service==='login'?loginEntry(state,API,LOGIN_PROVIDER,ACCOUNT,LOGIN_MODEL,targetLang)
    :service==='paid'?paidEntry(state,API,PAID_MODEL,targetLang):null;
  if(storedEntry){assert.equal(storedEntry.profile.styleExamples,enabled);assert.equal(storedEntry.profile.memoryMode,memoryMode);
    assert.equal(storedEntry.prompts[targetLang].text,text);}
  const snapshot=await resolveJobAiProfile(await readFullSettings(),{language:targetLang});
  assert(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.settings),'A job settings snapshot must be immutable');
  assert.equal(snapshot.settings.aiStyleExamples,enabled);
  assert.equal(snapshot.settings.aiMemoryMode,memoryMode);
  assert.equal(snapshot.settings.aiPrompt,text);
  assert.equal(snapshot.settings.aiTokenCeiling,ceilingValue,`${service}: token ceiling reaches the job`);
  assert.equal(snapshot.settings.aiThinking,service==='login'?'default':enabled?'on':'off',
    'Consumer Login uses website-default reasoning; do not invent a controllable thinking field');
  const originalHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  // Editing the active popup after resolution must affect a future job only.
  els.aiStyleExamples.checked=!enabled;await els.aiStyleExamples.emit('change');
  els.aiMemoryMode.value=memoryMode==='off'?'full':'off';await els.aiMemoryMode.emit('change');
  await persist.whenIdle();
  assert.equal(createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),originalHash);
  const future=await resolveJobAiProfile(await readFullSettings(),{language:targetLang});
  assert.equal(future.settings.aiStyleExamples,!enabled,'A future job must observe the later real UI toggle');
  assert.equal(future.settings.aiMemoryMode,memoryMode==='off'?'full':'off');
  const ai=await buildAiPayload('lens_text','ai',snapshot.settings,SERIES,targetLang);
  assert.equal(ai.style_examples,enabled);assert.equal(ai.memory_mode,memoryMode);
  assert.equal(ai.token_ceiling,ceilingValue??undefined,'planning-only ceiling in the job AI settings');
  const expectedMemory=memoryFor(targetLang), before=requests.length;
  for(const repair of [false,true]){
    const claim=repair?{runId:'synthetic-run',taskId:'synthetic-task',token:'SYNTHETIC_REPAIR_TOKEN'}:null;
    await translateViaServer([{id:'settings-unit',text:'Synthetic source'}],{base:API,capabilities:{aiConversation:'tp.conversation/1'},
      ai:{...ai,...(repair?{repair_reason:'wrong_target_script'}:{})},targetLang,sourceLang:'ja',
      rate:buildRatePayload('lens_text','ai',snapshot.settings),imageDataUri:ai.send_image?'data:image/png;base64,AAAA':'',
      operationId:`matrix-${matrix.length}-${repair}`,batchId:'synthetic-batch',repairClaim:claim});
    const {body,headers,url}=requests.at(-1);
    assert.equal(body.provider.id,service==='manual'?'openrouter':service);
    assert.equal(body.provider.model,service==='manual'?MANUAL_MODEL:service==='paid'?PAID_MODEL:LOGIN_SESSION+'/'+LOGIN_MODEL);
    assert.equal(body.provider.apiKey,service==='manual'?MANUAL_TOKEN:CENTER_TOKEN);
    assert.equal(body.provider.baseUrl,service==='manual'?'https://openrouter.ai/api/v1':'auto');
    assert.equal(body.provider.thinking,snapshot.settings.aiThinking);
    assert.equal(body.targetLang,targetLang);assert.equal(body.sourceLang,'ja');
    assert(!JSON.stringify(body).includes('token_ceiling'),'the ceiling is planning-only, never sent to the API');
    assert.equal(body.prompt,text);assert.equal(body.prompt_mode,'replace');
    assert.equal(body.memory.styleExamples,enabled);assert.equal(body.memory.mode,memoryMode);
    assert.deepEqual(body.memory.glossary,memoryMode==='off'?[]:expectedMemory.glossary);
    assert.deepEqual(body.memory.characters,memoryMode==='full'?expectedMemory.characters:[]);
    assert.equal(body.memory.seriesState,memoryMode==='full'?expectedMemory.state:'');
    assert.deepEqual(body.memory.previousContext,memoryMode==='full'?expectedMemory.prevContext:[]);
    assert.equal(body.memory.enabled,memoryMode==='full');assert.equal(Boolean(body.image),enabled);
    if(enabled)assert.deepEqual(body.image,{dataUri:'data:image/png;base64,AAAA'});
    assert.equal(body.translationMode,'conversation');assert.equal(body.provider.outputContract,'compact_markers_v1');
    assert.equal(body.repair.enabled,false);
    if(repair){assert.equal(body.repair.reason,'wrong_target_script');assert.match(url,/tasks\/synthetic-task\/translate$/);
      assert.equal(headers['X-TP-Run-Token'],'SYNTHETIC_REPAIR_TOKEN');}
    else{assert.equal(body.repair.reason,undefined);assert.equal(headers.Accept,'application/x-ndjson');}
    if(service==='login')assert.equal(body.conversation.webchatRunId,'synthetic-batch');
    matrix.push({service,engineMode,targetLang,memoryMode,examples:enabled,image:enabled,repair,
      requestSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
  }
  assert.equal(requests.length,before+2,'Each initial/repair operation dispatches once without fallback');
  uiResults.push({service,engineMode,targetLang,memoryMode,examples:enabled,passed:true});
}
assert.equal(matrix.length,144);assert.equal(requests.length-matrixStart,144);
console.log(JSON.stringify({suite:'settings-wire-matrix-10454',legacyBoundaryChecks:checks,
  popupProfileSnapshotCases:uiResults.length,apiRequestBodies:matrix.length,
  services:Object.fromEntries(['manual','paid','login'].map(service=>[service,matrix.filter(row=>row.service===service).length])),
  matrixSha256:createHash('sha256').update(JSON.stringify(matrix)).digest('hex'),
  scope:'Actual popup handlers, profile writer, immutable job resolver, payload builder and captured extension-to-API fetch body; synthetic DOM/storage/discovery/response. No live auth or backend-to-provider success claim.'},null,2));
