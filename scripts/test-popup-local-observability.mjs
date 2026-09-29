import assert from "node:assert/strict";
import {
  classifyLocalEndpointForTrace,
  createLocalConnectionController,
  localPickerOptions,
} from "../src/popup/controllers/local-connection-controller.js";

assert.equal(classifyLocalEndpointForTrace(""), "empty");
assert.equal(classifyLocalEndpointForTrace("http://localhost:11434"), "loopback");
assert.equal(classifyLocalEndpointForTrace("http://192.168.1.8:1234/v1"), "private");
assert.equal(classifyLocalEndpointForTrace("https://example.invalid/v1"), "public");
assert.equal(classifyLocalEndpointForTrace("not a URL"), "invalid");

const element = (value = "") => ({
  value, textContent: "", disabled: false,
  handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
});
const events = [];
const els = {
  aiProvider: element("ollama"), aiBaseUrl: element("https://example.invalid/secret/path"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("model-secret"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const state = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 7,
  desiredAiModel: "model-secret", aiMetaSeq: 0,
};
const controller = createLocalConnectionController({
  els, state, profile: {}, persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => { throw new Error("must not dispatch"); },
  normalizeUrl: (v) => v, setModelOptions() {}, setFieldMessage() {},
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => events.push(structuredClone(event)),
});
controller.bind();
await els.aiLocalTest.handlers.click();

assert.deepEqual(events.map((event) => [event.status, event.stage]), [
  ["started", "normalize"], ["failed", "normalize"],
]);
assert.equal(events[1].endpointClass, "public");
assert.equal(events[1].endpointSource, "provider_field");
assert.equal(events[1].transitionRevision, 7);
assert.equal(events[1].errorCode, "INVALID_LOCAL_ADAPTER");
assert.equal(events[1].errorName, "Error");
const serialized = JSON.stringify(events);
assert.doesNotMatch(serialized, /secret\/path|model-secret|example\.invalid/);

const successEvents = [];
const successEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("qwen"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const successState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 8,
  desiredAiModel: "qwen", aiMetaSeq: 0, aiModelBlocked: true,
};
const successMessages = [];
const successController = createLocalConnectionController({
  els: successEls, state: successState, profile: { selectModel() {} },
  persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => ({
    ok: true, models: ["qwen"], capability: {},
    selectedModelVerification: { model: "qwen", status: "passed" },
  }),
  normalizeUrl: (v) => v,
  setModelOptions(models, { keepValue } = {}) { successEls.aiModel.value = keepValue || models[0] || ""; },
  setFieldMessage(_wrap, type, message) { successMessages.push({ type, message }); },
  renderPrompt: async () => {}, scheduleSave() {},
  clearResolveTimer() {}, clearCapacity() {}, renderCapacity() {},
  persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => successEvents.push(structuredClone(event)),
});
successController.bind();
await successEls.aiLocalTest.handlers.click();
assert.equal(successState.aiModelBlocked, false);
assert.equal(successMessages.at(-1).type, "info");
assert.match(successMessages.at(-1).message, /listed and its metadata was checked.*start translation/i);
assert.match(successEls.aiLocalStatus.textContent, /Model selected/);
assert.doesNotMatch(successEls.aiLocalStatus.textContent, /chat.*unverified|Ready to try/i);
const lmEls = {aiProvider:element('lmstudio'),aiBaseUrl:element('http://localhost:1234/v1'),
  aiThinking:element('off'),aiLocalStatus:element(),aiLocalTest:element(),
  aiModel:element('main'),apiUrl:element('http://localhost:7860'),aiModelWrap:{}};
const lmState={localConnectSeq:0,localConnectInFlight:null,providerTransitionRevision:1,
  desiredAiModel:'main',aiMetaSeq:0,aiModelBlocked:true};
const lmMessages=[];
assert.deepEqual(localPickerOptions('lmstudio',['main','second'],{models:{
  main:{loaded:true,limits:{runtimeContextTokens:8192}},second:{loaded:false}}}),[
  {id:'main',label:'main — loaded',eligibility:'usable'},
  {id:'second',label:'second — downloaded; load in LM Studio',eligibility:'unknown'},
]);
let lmListed=[];
const lmController=createLocalConnectionController({els:lmEls,state:lmState,
  profile:{selectModel(){}},persist:async()=>{},getStorage:async()=>({}),
  sendMessage:async()=>({ok:true,models:['main','second'],selectableModels:['main'],
    capability:{models:{main:{loaded:true,limits:{runtimeContextTokens:8192},reasoning:{supported_efforts:['on'],mandatory:true}},
      second:{loaded:false}}},
    selectedModelVerification:{model:'main',status:'passed'}}),normalizeUrl:v=>v,
  setModelOptions(models,{keepValue}={}){lmListed=models;lmEls.aiModel.value=keepValue||models[0]?.id||models[0]||'';},
  setFieldMessage(_wrap,type,message){lmMessages.push({type,message});},
  renderPrompt:async()=>{},scheduleSave(){},clearResolveTimer(){},clearCapacity(){},
  renderCapacity(){},persistCapacity:async()=>{},toggleUi(){},traceLocalConnection(){}});
await lmController.connect();
assert.equal(lmState.aiModelBlocked,true,'native mandatory reasoning blocks Off in popup before starting');
assert.match(lmMessages.at(-1).message,/thinking mode/i);
lmEls.aiThinking.value='minimum';lmController.refreshThinkingCompatibility();
assert.equal(lmState.aiModelBlocked,false,'changing to a supported mode reuses metadata without AI generation');
assert.match(lmEls.aiLocalStatus.textContent,/✓ Model selected/);
lmEls.aiThinking.value='off';lmController.refreshThinkingCompatibility();
assert.equal(lmState.aiModelBlocked,true);
assert.match(lmEls.aiLocalStatus.textContent,/does not support the selected Thinking mode/);
assert.deepEqual(lmState.lastAiResolve.models,['main','second'],'both downloaded LLMs remain in the picker');
assert.match(lmListed[1].label,/downloaded; load in LM Studio/);
const blankEls={aiProvider:element('lmstudio'),aiBaseUrl:element('http://localhost:1234/v1'),
  aiThinking:element('minimum'),aiLocalStatus:element(),aiLocalTest:element(),aiModel:element(''),
  apiUrl:element('http://localhost:7860'),aiModelWrap:{}};
const blankState={localConnectSeq:0,localConnectInFlight:null,providerTransitionRevision:2,
  desiredAiModel:'auto',aiModelBlocked:true};
let savedBlank=0,blankChoices=[];
const blankController=createLocalConnectionController({els:blankEls,state:blankState,
  profile:{selectModel(){savedBlank++}},persist:async()=>{},getStorage:async()=>({}),
  sendMessage:async()=>({ok:true,models:['download-a','download-b'],selectableModels:[],
    capability:{models:{'download-a':{loaded:false},'download-b':{loaded:false}}},
    selectedModelVerification:{model:'',status:'not_selected'}}),normalizeUrl:v=>v,
  setModelOptions(models,{keepValue,selectFirst,clearPrevious}={}){
    blankChoices=models;
    const ids=models.map(item=>item.id||item);
    const prev=keepValue||(!clearPrevious&&blankEls.aiModel.value)||'';
    blankEls.aiModel.value=ids.includes(prev)?prev:selectFirst?ids[0]||'':'';
  },setFieldMessage(){},renderPrompt:async()=>{},scheduleSave(){savedBlank++},
  clearResolveTimer(){},clearCapacity(){},renderCapacity(){},persistCapacity:async()=>{},
  toggleUi(){},traceLocalConnection(){}});
await blankController.connect();
assert.deepEqual(blankChoices.map(choice=>choice.id),['download-a','download-b']);
assert.equal(blankEls.aiModel.value,'','zero loaded models must not auto-select a downloaded LLM');
assert.equal(blankState.desiredAiModel,'auto','an unavailable downloaded LLM must not become saved preference');
assert.equal(savedBlank,0);
assert.equal(blankState.aiModelBlocked,true);

const pendingEls={aiProvider:element('lmstudio'),aiBaseUrl:element('http://localhost:1234/v1'),
  aiThinking:element('minimum'),aiLocalStatus:element(),aiLocalTest:element(),aiModel:element('main'),
  apiUrl:element('http://localhost:7860'),aiModelWrap:{}};
const pendingState={localConnectSeq:0,localConnectInFlight:null,providerTransitionRevision:3,
  desiredAiModel:'main',aiModelBlocked:false,
  localAiCapability:{models:{main:{loaded:true,limits:{runtimeContextTokens:8192},
    reasoning:{supported_efforts:['on']}}}},
  lastAiResolve:{model:'main',availability_verified:true,models:['main']}};
let startPending,resolvePending;
const pendingStarted=new Promise(resolve=>{startPending=resolve});
const pendingController=createLocalConnectionController({els:pendingEls,state:pendingState,
  profile:{selectModel(){}},persist:async()=>{},getStorage:async()=>({}),
  sendMessage:()=>new Promise(resolve=>{resolvePending=resolve;startPending()}),normalizeUrl:v=>v,
  setModelOptions(models,{keepValue}={}){pendingEls.aiModel.value=keepValue||models[0]?.id||''},
  setFieldMessage(){},renderPrompt:async()=>{},scheduleSave(){},clearResolveTimer(){},
  clearCapacity(){},renderCapacity(){},persistCapacity:async()=>{},toggleUi(){},traceLocalConnection(){}});
const pendingRefresh=pendingController.connect();
await pendingStarted;
pendingController.refreshThinkingCompatibility();
assert.equal(pendingState.aiModelBlocked,true,'old metadata must not unlock translation during refresh');
resolvePending({ok:true,models:['main','second'],selectableModels:[],
  capability:{models:{main:{loaded:false},second:{loaded:false}}},
  selectedModelVerification:{model:'main',status:'model_not_loaded'}});
await pendingRefresh;
assert.equal(pendingState.aiModelBlocked,true,'fresh unloaded metadata must keep the model blocked');

const promptEls={aiProvider:element('lmstudio'),aiBaseUrl:element('http://localhost:1234/v1'),
  aiThinking:element('minimum'),aiLocalStatus:element(),aiLocalTest:element(),aiModel:element(''),
  apiUrl:element('http://localhost:7860'),aiModelWrap:{}};
const promptState={localConnectSeq:0,localConnectInFlight:null,providerTransitionRevision:4,
  desiredAiModel:'auto',aiModelBlocked:true};
let releasePrompt,signalPrompt;
const promptStarted=new Promise(resolve=>{signalPrompt=resolve});
const promptController=createLocalConnectionController({els:promptEls,state:promptState,
  profile:{selectModel(){}},persist:async()=>{},getStorage:async()=>({}),
  sendMessage:async()=>({ok:true,models:['main','second'],selectableModels:['main'],
    capability:{models:{main:{loaded:true,limits:{runtimeContextTokens:8192},
      reasoning:{supported_efforts:['on'],mandatory:true}},second:{loaded:false}}},
    selectedModelVerification:{model:'main',status:'passed'}}),normalizeUrl:v=>v,
  setModelOptions(models,{keepValue}={}){promptEls.aiModel.value=keepValue||models[0]?.id||''},
  setFieldMessage(){},renderPrompt:()=>new Promise(resolve=>{releasePrompt=resolve;signalPrompt()}),
  scheduleSave(){},clearResolveTimer(){},clearCapacity(){},renderCapacity(){},
  persistCapacity:async()=>{},toggleUi(){},traceLocalConnection(){}});
const promptRefresh=promptController.connect();
await promptStarted;
promptEls.aiThinking.value='off';
promptState.aiModelBlocked=true;
promptController.refreshThinkingCompatibility();
assert.equal(promptState.aiModelBlocked,true,'thinking changes cannot unlock an in-flight model check');
releasePrompt();
await promptRefresh;
assert.equal(promptState.aiModelBlocked,true,'the final Thinking mode must be checked after awaiting the profile');
assert.match(promptEls.aiLocalStatus.textContent,/does not support the selected Thinking mode/);
assert.deepEqual(successEvents.map((event) => [event.status, event.stage]), [
  ["started", "normalize"], ["completed", "normalize"],
  ["started", "persist"], ["completed", "persist"],
  ["started", "message"], ["completed", "discovery"],
  ["completed", "model_verify"],
]);
assert.equal(successEvents.every((event) => event.endpointClass === "loopback"), true);
assert.doesNotMatch(JSON.stringify(successEvents), /qwen|localhost|11434/);

const unsupportedMessages = [];
const unsupportedEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("nomic-embed-text"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const unsupportedState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 10,
  desiredAiModel: "nomic-embed-text", aiMetaSeq: 0, aiModelBlocked: true,
};
const unsupportedController = createLocalConnectionController({
  els: unsupportedEls, state: unsupportedState, profile: { selectModel() {} },
  persist: async () => {}, getStorage: async () => ({}),
  sendMessage: async () => ({
    ok: true, models: ["qwen"], capability: {},
    selectedModelVerification: {
      model: "nomic-embed-text", status: "unsupported_model",
      evidence: "ollama-api-show",
    },
  }),
  normalizeUrl: (v) => v,
  setModelOptions(models, { keepValue, selectFirst = true } = {}) {
    const list = [...models];
    unsupportedEls.aiModel.value = list.includes(keepValue) ? keepValue : selectFirst ? list[0] || "" : "";
  },
  setFieldMessage(_wrap, type, message) { unsupportedMessages.push({ type, message }); },
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection() {},
});
unsupportedController.bind();
await unsupportedEls.aiLocalTest.handlers.click();
assert.equal(unsupportedState.aiModelBlocked, true);
assert.equal(unsupportedEls.aiModel.value, "", "an explicit unusable Local model must be cleared, not silently replaced");
assert.equal(unsupportedMessages.at(-1).type, "error");
assert.match(unsupportedMessages.at(-1).message, /cannot generate chat completions/i);
assert.doesNotMatch(unsupportedEls.aiLocalStatus.textContent, /CORS|runtime is running/i);

let releaseDiscovery;
let announceDiscovery;
const discoveryStarted = new Promise((resolve) => { announceDiscovery = resolve; });
const staleEvents = [];
const staleEls = {
  aiProvider: element("ollama"), aiBaseUrl: element("http://localhost:11434"),
  aiLocalStatus: element(), aiLocalTest: element(), aiModel: element("qwen"),
apiUrl: element("http://localhost:7860"), aiModelWrap: {},
};
const staleState = {
  localConnectSeq: 0, localConnectInFlight: null, providerTransitionRevision: 9,
  desiredAiModel: "qwen", aiMetaSeq: 0,
};
const staleController = createLocalConnectionController({
  els: staleEls, state: staleState, profile: {}, persist: async () => {},
  getStorage: async () => ({}),
  sendMessage: () => new Promise((resolve) => { releaseDiscovery = resolve; announceDiscovery(); }),
  normalizeUrl: (v) => v, setModelOptions() {}, setFieldMessage() {},
  renderPrompt: async () => {}, scheduleSave() {}, clearResolveTimer() {},
  clearCapacity() {}, renderCapacity() {}, persistCapacity: async () => {}, toggleUi() {},
  traceLocalConnection: (event) => staleEvents.push(structuredClone(event)),
});
staleController.bind();
const pending = staleEls.aiLocalTest.handlers.click();
await discoveryStarted;
staleController.invalidate("provider changed");
releaseDiscovery({ ok: true, models: ["qwen"], capability: {} });
await pending;
assert.equal(
  staleEvents.some((event) => event.stage === "discovery" && event.status === "completed"),
  false,
  "a stale discovery response must not be reported as completed",
);
assert.equal(staleState.localConnectInFlight, null);

console.log("PASS popup Local AI observability milestones are staged and sanitized");
