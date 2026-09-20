import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createAiProfileController } from '../src/popup/controllers/ai-profile-controller.js';
import { createProviderMetaController } from '../src/popup/controllers/provider-meta-controller.js';
import { createPopupUiController } from '../src/popup/controllers/popup-ui-controller.js';
import { createResetDefaultsController } from '../src/popup/controllers/reset-defaults-controller.js';
import { createAiProfiles, resolveAiProfile } from '../src/shared/ai-profiles.js';
import { normalizeUserReasoningPreference, reasoningOptionsForCapability, resolveReasoningPreference } from '../src/shared/reasoning-preference.js';

let checks = 0;
const eq = (a,b,message) => { assert.deepEqual(a,b,message); checks++; };
const ok = (value,message) => { assert.ok(value,message); checks++; };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const value = v => ({value:v});
const tick = () => new Promise(resolve => setImmediate(resolve));
const CAP = {reasoning:{supported:true, mandatory:true, control:'levels', supported_efforts:['high']}};
const pass = {ok:true,status:'passed',model_capabilities:CAP};
const endpoint = provider => provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://openrouter.ai/api/v1';

async function fixture({stored=null, fetchJson=async()=>pass}={}) {
  const els = {mode:value('lens_text'), sources:value('ai'), lang:value('th'), apiUrl:value('http://localhost:7860'),
    aiProvider:value('openrouter'), aiBaseUrl:value(endpoint('openrouter')), aiKey:value('fixture-key-A'),
    aiModel:value('old-model'), aiThinking:value('minimum'), aiModelWrap:{},aiProviderWrap:{},aiKeyWrap:{style:{display:''}}};
  const state = {aiMetaSeq:1,aiProbeSeq:0,lastAiProbe:null,aiModelBlocked:true,desiredAiModel:'old-model'};
  const storage = structuredClone(stored || {aiProvider:'openrouter',aiBaseUrl:els.aiBaseUrl.value,
    aiModel:'old-model',aiKey:'fixture-key-A',aiCloudKey:'fixture-key-A'});
  const writes=[], capabilities=[], requests=[], messages=[];
  const profile=createAiProfileController({els,state,setStorage:async patch=>{
    writes.push(structuredClone(patch));Object.assign(storage,structuredClone(patch));}});
  await profile.initialize(storage);
  const resolved = () => ({provider:els.aiProvider.value,model:els.aiModel.value,backend_supported:true,key_status:'valid',
    models_verified:true,models:[els.aiModel.value],model_candidates:[{id:els.aiModel.value,eligibility:'usable'}]});
  state.lastAiResolve=resolved();
  const wrappedProfile={saveModelCapabilities:async (...args)=>{capabilities.push(args);return profile.saveModelCapabilities(...args);}};
  const controller=createProviderMetaController({els,state,api:{fetchJson:(url,body)=>{
    requests.push({url,body:structuredClone(body)});return fetchJson(url,body);}},
    constants:{paths:{AI_RESOLVE:'/resolve',AI_PROBE:'/probe'},metaTimeout:1000,probeTimeout:1000},
    provider:{isLocal:()=>false,label:x=>x,protocolLabel:()=>''},profile:wrappedProfile,
    normalizeUrl:x=>x,setModelOptions:(models,{keepValue='',selectFirst=true}={})=>{
      const ids=models.map(v=>String(v?.id??v));els.aiModel.options=ids;
      els.aiModel.value=ids.includes(keepValue)?keepValue:selectFirst&&ids.length?ids[0]:'';
    },setFieldMessage:(wrap,type,text)=>messages.push({wrap,type,text}),setStatus:()=>{},toggleUi:()=>{}});
  const change=async (field,v,{revision=true}={})=>{
    els[field].value=v;
    if(revision){state.aiMetaSeq++;state.aiProbeSeq++;}
    state.aiModelBlocked=true;state.lastAiResolve=null;state.lastAiProbe=null;
    if(field==='aiProvider') {els.aiBaseUrl.value=endpoint(v);els.aiModel.value='new-model';}
    state.desiredAiModel=els.aiModel.value;
    profile.bindConnection({provider:els.aiProvider.value,endpoint:els.aiBaseUrl.value});
    profile.selectModel(els.aiModel.value);
    await profile.saveProfile({});
    state.lastAiResolve=resolved();
  };
  writes.length=0;
  return {els,state,profile,controller,storage,writes,capabilities,requests,messages,change};
}

// New and reset profiles store a policy, never the lowest concrete option.
for (const input of [undefined,null,'','invalid','auto','default'])
  eq(normalizeUserReasoningPreference(input),'minimum','missing/invalid policy');
for (const explicit of ['minimum','off','on','minimal','low','medium','high'])
  eq(normalizeUserReasoningPreference(explicit),explicit,'explicit user preference preserved');
eq(resolveAiProfile(createAiProfiles(),{provider:'openrouter',model:'fixture'}).profile.thinking,'minimum');
{
  const f=await fixture();
  eq(f.els.aiThinking.value,'minimum');
  await f.profile.saveProfile({thinking:'low'});
  const before=await fixture({stored:f.storage});
  eq(before.els.aiThinking.value,'low','existing explicit choice survives upgrade/reopen');
  const reset=createResetDefaultsController({els:{},confirmReset:()=>true,
    remove:async keys=>{for(const key of keys) delete f.storage[key];},reload:()=>{}});
  ok(await reset.reset());
  const after=await fixture({stored:f.storage});
  eq(after.els.aiThinking.value,'minimum','actual Reset keys -> initialize selects Lowest available');
  const saved=after.storage.aiProfilesV1;
  eq(saved.providers[saved.active.providerIdentity].models[saved.active.model].profile.thinking,'minimum');
}
const caps = [null,{supported:false},{supported:true,control:'toggle'},
  {supported:true,mandatory:true,control:'levels',supported_efforts:['minimal','low','high']},
  {supported:true,mandatory:true,control:'levels',supported_efforts:['low','high']}];
for (const cap of caps) ok(reasoningOptionsForCapability(cap).some(option=>option.value==='minimum'));
eq(resolveReasoningPreference('minimum',caps[2]),'off');
eq(resolveReasoningPreference('minimum',caps[3]),'minimal');
eq(resolveReasoningPreference('minimum',caps[4]),'low');
const oldDocument=globalThis.document;
globalThis.document={createElement:()=>({value:'',textContent:''})};
try {
  for (const cap of caps) for (const preference of ['minimum','off','low']) {
    const select={value:preference,options:[],replaceChildren(...v){this.options=v;},append(v){this.options.push(v);}};
    const els={aiProvider:value('ollama'),aiBaseUrl:value('http://localhost:11434'),aiModel:value('fixture'),
      aiKey:value(''),mode:value('lens_text'),sources:value('ai'),aiThinkingWrap:{style:{}},aiThinking:select,aiThinkingHint:{}};
    const ui=createPopupUiController({els,state:{localAiCapability:{provider:'ollama',baseUrl:els.aiBaseUrl.value,
      models:{fixture:cap?{reasoning:cap}:{}}}},isLocalProvider:()=>true,toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}});
    ui.toggle();ui.toggle();
    eq(select.value,preference,'capability refresh must not change the selection');
    ok(select.options.some(option=>option.value==='minimum'));
  }
} finally {globalThis.document=oldDocument;}
const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
ok(/<option value="minimum" selected>Lowest available<\/option>/.test(html),'HTML fresh popup default');

// Old responses of either outcome cannot touch another provider/key/model/endpoint.
for (const [field,v] of [['aiProvider','gemini'],['aiKey','fixture-key-B'],['aiModel','new-model'],
                        ['aiBaseUrl','https://openrouter.ai/api/v1/changed'],['apiUrl','http://localhost:9999']]) {
  for (const result of [pass,{ok:false,status:'rejected',error:'old test failed'}]) {
    const request=deferred();const f=await fixture({fetchJson:()=>request.promise});
    const pending=f.controller.probeSelected();
    await f.change(field,v);
    const writesBefore=f.writes.length;
    request.resolve(result);await pending;
    eq(f.state.aiModelBlocked,true,field+' stale result unlocked gate');
    eq(f.state.lastAiProbe,null,field+' stale result replaced status');
    eq(f.capabilities.length,0,field+' stale result persisted capability');
    eq(f.writes.length,writesBefore,field+' stale result wrote storage');
  }
}
// Guard raw identity even before a field's event handler has run.
{
  const request=deferred();const f=await fixture({fetchJson:()=>request.promise});
  const pending=f.controller.probeSelected();
  f.els.aiKey.value='uncommitted-edit';
  request.resolve(pass);await pending;
  eq(f.capabilities.length,0);eq(f.state.aiModelBlocked,true);
}
// A -> B -> A is still a different generation.
{
  const request=deferred();const f=await fixture({fetchJson:()=>request.promise});
  const pending=f.controller.probeSelected();
  await f.change('aiKey','B');await f.change('aiKey','fixture-key-A');
  request.resolve(pass);await pending;
  eq(f.capabilities.length,0);eq(f.state.lastAiProbe,null);eq(f.state.aiModelBlocked,true);
}
// A stale explicit target is rejected again by the actual profile writer.
{
  const f=await fixture();const target={provider:'openrouter',endpoint:f.els.aiBaseUrl.value,model:'old-model'};
  await f.change('aiProvider','gemini');const before=f.writes.length;
  eq(await f.profile.saveModelCapabilities(CAP,'old-account',target),false);
  eq(f.writes.length,before);
}
// Live success updates only its exact profile and never rewrites Lowest available.
{
  const f=await fixture();const result=await f.controller.probeSelected();
  eq(result.status,'passed');eq(f.state.aiModelBlocked,false);eq(f.els.aiThinking.value,'minimum');
  const stored=f.storage.aiProfilesV1;const profile=stored.providers[stored.active.providerIdentity].models[stored.active.model].profile;
  eq(profile.thinking,'minimum');eq(profile.providerOptions.modelCapabilities.reasoning.supported_efforts,['high']);
  await f.controller.probeSelected();eq(f.requests.length,1,'same popup cache should not call native twice');
}
// Key/provider can change during hashing, even after the HTTP response arrived.
for (const cached of [false,true]) {
  const f=await fixture();if(cached) await f.controller.probeSelected();
  const digest=deferred();let hashing=false;
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{subtle:{digest:()=>{hashing=true;return digest.promise;}}}});
  try {
    const before=f.capabilities.length;const pending=f.controller.probeSelected();
    await tick();ok(hashing,'fixture reached awaited digest');
    await f.change('aiProvider','gemini');
    digest.resolve(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('fixture-key-A')));
    await pending;
    eq(f.capabilities.length,before,'late hash wrote capability');eq(f.state.lastAiProbe,null);eq(f.state.aiModelBlocked,true);
  } finally {Object.defineProperty(globalThis,'crypto',descriptor);}
}
// A settings change during storage completion must not unlock the new model.
{
  const f=await fixture();const saved=f.profile.saveModelCapabilities.bind(f.profile);const hold=deferred();const entered=deferred();
  f.profile.saveModelCapabilities=async(...args)=>{const result=await saved(...args);entered.resolve();await hold.promise;return result;};
  const pending=f.controller.probeSelected();
  await entered.promise;ok(true,'actual capability write started');
  await f.change('aiKey','new-account');hold.resolve();await pending;
  eq(f.state.aiModelBlocked,true);eq(f.state.lastAiProbe,null);
}
// The actual persistence completion cannot clear a newer profile error.
{
  const els={aiProvider:value('openrouter'),aiBaseUrl:value(endpoint('openrouter')),aiModel:value('fixture'),aiThinking:value('minimum')};
  const state={};const gate=deferred();let pause=false,started=false,current=true;
  const profile=createAiProfileController({els,state,setStorage:async()=>{if(pause){started=true;await gate.promise;}}});
  await profile.initialize({aiProvider:'openrouter',aiBaseUrl:els.aiBaseUrl.value,aiModel:'fixture',aiKey:'fixture-key'});
  pause=true;
  const pending=profile.saveModelCapabilities(CAP,'0123456789abcdef',{provider:'openrouter',endpoint:els.aiBaseUrl.value,model:'fixture'},()=>current);
  await tick();ok(started);
  current=false;state.aiProfileBlocked=true;state.aiProfileErrorCode='NEW_PROFILE_ERROR';
  gate.resolve();await pending;
  eq(state.aiProfileBlocked,true);eq(state.aiProfileErrorCode,'NEW_PROFILE_ERROR');
}
// Empty key is a pending form, not an API/provider failure.
{
  const f=await fixture({fetchJson:()=>{throw Error('must not call API without key');}});
  f.els.aiKey.value='';await f.controller.refresh();
  eq(f.requests.length,0);eq(f.state.lastAiResolve.configuration_status,'pending');eq(f.state.aiModelBlocked,true);
}
// 400/request rejection keeps the gate closed but is not a false model removal.
{
  const f=await fixture({fetchJson:async()=>({ok:false,status:'request_rejected',error:'Bad parameter',error_details:{provider_message:'Unsupported test field'}})});
  await f.controller.probeSelected();
  eq(f.state.aiModelBlocked,true);eq(f.els.aiModel.value,'old-model');
  eq(f.state.lastAiResolve.model_candidates[0].eligibility,'usable');
  ok(f.messages.some(item=>item.text.includes('Unsupported test field')));
}
// Billing is an account failure, not grounds for hiding a model.
{
  const f=await fixture({fetchJson:async()=>({ok:false,status:'billing_required',http_status:402,error:'Credits depleted'})});
  await f.controller.probeSelected();
  eq(f.state.aiModelBlocked,true);eq(f.els.aiModel.value,'old-model');
  eq(f.state.lastAiResolve.model_candidates[0].eligibility,'usable');
  ok(f.messages.some(item=>item.text.includes('credits exhausted')));
}
// Late catalogue responses must not update another selection or trigger its probe.
{
  const request=deferred();const f=await fixture({fetchJson:()=>request.promise});
  const pending=f.controller.refresh();await f.change('aiProvider','gemini');
  request.resolve({provider:'openrouter',model:'old-model',models_verified:true,models:['old-model'],
    model_candidates:[{id:'old-model',eligibility:'usable'}],model_capabilities:CAP});
  await pending;eq(f.els.aiModel.value,'new-model');eq(f.capabilities.length,0);eq(f.requests.length,1);eq(f.state.aiModelBlocked,true);
}
console.log(`PASS 19.20 popup/reset/probe: ${checks} assertions; real profile storage, mocked API; no live Provider calls`);
