import assert from 'node:assert/strict';

// Exercise the complete popup open path. An earlier test called only the
// profile-activation helper and missed a ReferenceError after activation.
class Field {
  constructor(value = '') { this.value = value; this.options = []; this.style = {}; this.dataset = {}; }
  set innerHTML(value) { if (value === '') { this.options = []; this.value = ''; } }
  appendChild(child) { this.options.push(child); }
}
const fields = new Map();
const field = (id, value = '') => {
  const item = new Field(value);
  fields.set(id, item);
  return item;
};
const els = {
  mode: field('mode', 'lens_text'), lang: field('lang', 'th'),
  sources: field('sources', 'ai'), aiProvider: field('ai-provider', 'ollama'),
  aiBaseUrl: field('ai-base-url', 'http://localhost:11434'),
  aiModel: field('ai-model'), aiKey: field('ai-key'),
  aiPrompt: field('ai-prompt'), apiUrl: field('api-url'),
  aiLocalAdapter: field('ai-local-adapter'),
};
field('api-status-emoji');
field('api-status-emoji-2');
globalThis.document = {
  getElementById: id => fields.get(id) || null,
  createElement: () => ({value:'', textContent:'', disabled:false, dataset:{}}),
};

const selected = 'qwen3.5:9b';
const storage = {
  mode:'lens_text', sources:'ai', lang:'th', aiProvider:'ollama',
  aiBaseUrl:'http://localhost:11434', aiModel:selected,
  customApiUrl:'http://localhost:7860',
  apiDefaultsFetchedAt:Date.now(),
};
const read = keys => Array.isArray(keys)
  ? Object.fromEntries(keys.filter(key => key in storage).map(key => [key, structuredClone(storage[key])]))
  : Object.fromEntries(Object.entries(keys).map(([key, fallback]) =>
    [key, key in storage ? structuredClone(storage[key]) : fallback]));
globalThis.chrome = {
  runtime: {lastError:null, sendMessage: (message, callback) =>
    callback(message.type === 'TP_GET_TRANSLATION_SESSIONS' ? {runs:[]} : null)},
  storage: {local: {
    get: (keys, callback) => callback(read(keys)),
    set: (patch, callback) => {Object.assign(storage, structuredClone(patch)); callback?.();},
  }},
};

const {createAiProfileController} = await import('../src/popup/controllers/ai-profile-controller.js');
const {createProviderMetaController} = await import('../src/popup/controllers/provider-meta-controller.js');
const {loadPopupSettings} = await import('../src/popup/controllers/settings-hydration-controller.js');
const {isLocalAiProvider} = await import('../src/shared/constants.js');
const {normalizeUrl} = await import('../src/shared/url.js');
const state = {desiredLang:'th', desiredAiModel:'', aiPromptByLang:{},
  aiMetaSeq:0, aiProbeSeq:0, localConnectInFlight:null};
const write = async patch => Object.assign(storage, structuredClone(patch));
const profileController = createAiProfileController({els,state,setStorage:write});
// Simulate an existing, valid saved canonical provider/model profile.
await profileController.initialize({...storage});
assert.ok(storage.aiProfilesV1);
els.aiModel.value = '';
state.desiredAiModel = '';
let connectCalls = 0;
const localConnectionController = {
  restoreSnapshot: () => false,
  connect: async () => {connectCalls++;},
};
const providerMetaController = createProviderMetaController({
  els,state, api:{}, constants:{},
  provider:{isLocal:isLocalAiProvider}, profile:profileController,
  prompt:{}, local:localConnectionController, usage:{},
  persist:write, normalizeUrl, setModelOptions:()=>{}, setFieldMessage:()=>{},
  setStatus:()=>{}, toggleUi:()=>{},
});
let usageCalls = 0, apiHealthChecks = 0;
await loadPopupSettings({
  els,state,profileController,
  fontScaleController:{render(){}}, seriesMemoryController:{refresh(){}},
  rateSettingsController:{renderHint(){},renderLocalHint(){}},
  usageViewController:{refresh:async()=>{usageCalls++;}},
  providerMetaController, apiHealthController:{acceptSnapshot:()=>false,
    check:()=>{apiHealthChecks++;}},
  refreshPromptHistoryButtons:()=>{}, toggleUi:()=>{},
  localConnectionController, isRemoteDefaultApiUrl:()=>false,
  canUseAiUi:()=>true, applyPromptForLang:()=>{},
});
await Promise.resolve();
assert.equal(state.desiredAiModel,selected);
assert.equal(els.aiModel.value,selected,'reopening shows the saved Local AI model');
assert.equal(storage.aiModel,selected,'hydration must not rewrite the saved model');
assert.equal(connectCalls,1,'reopening starts the Local AI connection check');
assert.equal(els.apiUrl.value,'http://localhost:7860');
assert.equal(apiHealthChecks,1,'reopening also resumes the configured API health check');
assert.equal(usageCalls,1,'the popup continues beyond Local model restoration');
console.log('PASS popup hydration restores a saved Local model and begins live connection');
