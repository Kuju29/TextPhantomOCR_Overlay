import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {paidScope, PAID_PROFILE_KEY} from '../src/shared/paid-profile.js';
import {loginScope, LOGIN_PROFILE_KEY} from '../src/shared/login-profile.js';

Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});
const base = 'http://localhost:7860';
const sessionId = 'lgs_' + 'a'.repeat(48);
const style = 'SYNTHETIC CUSTOM STYLE: preserve the current scene and natural wording.';
const series = 'SYNTHETIC SERIES MEMORY: Established title is Dawn.';
const capabilities = {reasoning:{supported:false,mandatory:false}};
const providers = ['tp', 'login_gemini', 'login_deepseek', 'login_chatgpt',
  'login_claude', 'login_openrouter', 'login_huggingface'];
let store = {}, ram = {}, currentProvider = '', sent = [];
const area = source => ({
  get(keys, callback) {
    const values = source();
    const result = Object.fromEntries((Array.isArray(keys) ? keys : typeof keys === 'string'
      ? [keys] : Object.keys(keys || values)).map(k => [k, values[k] ?? keys?.[k]]));
    callback?.(result); return Promise.resolve(result);
  },
  set(patch, callback) {Object.assign(source(), structuredClone(patch)); callback?.(); return Promise.resolve();},
  remove(keys, callback) {for (const key of keys) delete source()[key]; callback?.();},
});
globalThis.chrome = {runtime:{id:'synthetic-human-examples',getManifest:()=>({version:'2026.10.4.42'})},
  storage:{local:area(()=>store),session:area(()=>ram),onChanged:{addListener(){}}}};
globalThis.fetch = async (url, options={}) => {
  const path = new URL(url).pathname;
  if (options.method === 'POST') {
    assert.match(path, /translate$/);
    const body = JSON.parse(options.body); sent.push(body);
    const result = {schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'คำแปล'})),
      missing:[],meta:{resolvedProvider:body.provider.id,resolvedModel:body.provider.model,
        generationAttempts:1,providerAttempts:1}};
    return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n',
      {headers:{'content-type':'application/x-ndjson'}});
  }
  if (path === '/meta') return Response.json({paid:{available:true}});
  if (path === '/paid/me') return Response.json({models:[{id:'qa/test',model_capabilities:capabilities}],
    addons:{entitlements:[{code:'ai_login',status:'active'}]}});
  if (path === `/login/providers/${currentProvider}/models`) return Response.json({
    models:[{id:'web-default',model_capabilities:capabilities}],session:{id:sessionId,provider:currentProvider,
      account_id:'synthetic-account-'+currentProvider,transport:'web_endpoint'}});
  // .66 resolver rediscovers this owner's current Login session when none is stored.
  if (path === '/login/providers') return Response.json({providers:[{id:currentProvider,
    session:{id:sessionId,provider:currentProvider}}]});
  throw new Error('Unexpected synthetic fixture request path');
};
const {readFullSettings} = await import('../src/shared/settings.js');
const {resolveJobAiProfile} = await import('../src/background/ai-profile-resolver.js');
const {buildAiPayload} = await import('../src/background/context-menu.js');
// .69: Series memory is verified per series/target and starts from the previous
// chapter (intentional since .60). Seed it the way the product records it.
const {accumulateSeriesMemory} = await import('../src/background/series-memory.js');
const seriesKey = 'reader.test/manga/dawn';
const chapterOne = 'https://reader.test/manga/dawn/chapter-1', chapterTwo = 'https://reader.test/manga/dawn/chapter-2';
const {translateViaServer} = await import('../src/background/ai/transports/server.js');
const {createAiProfileController} = await import('../src/popup/controllers/ai-profile-controller.js');
const fixtures = [], checks = [], failures = [];
for (const provider of providers) for (const kind of ['fresh', 'legacy-forced-off', 'saved-on']) {
  currentProvider = provider;
  store = {customApiUrl:base,apiUrlDefault:base,apiDefaultsFetchedAt:Date.now(),
    aiServiceMode:'paid',paidTranslationSource:provider === 'tp' ? 'tp' : 'login',
    paidSessionToken:'synthetic-customer-session',paidApiBase:base,paidModel:'qa/test',
    loginProvider:provider,loginModel:'web-default',lang:'th',aiStyleExamples:false};
  ram = {loginSessionId:sessionId};
  if (kind !== 'fresh') {
    const profile = {thinking:'default',memoryMode:'full',styleExamples:kind === 'saved-on',pageImage:'off',
      ...(kind === 'saved-on' ? {styleExamplesPreferenceVersion:1} : {})};
    const entry = {profile,prompts:{th:{text:style,mode:'replace'}}};
    if (provider === 'tp') store[PAID_PROFILE_KEY] = {version:1,entries:{[paidScope(base,'qa/test')]:entry}};
    else store[LOGIN_PROFILE_KEY] = {version:1,entries:{
      [loginScope(base,provider,'synthetic-account-'+provider,'web-default')]:entry}};
  }
  const snap = await resolveJobAiProfile(await readFullSettings(), {language:'th'});
  await accumulateSeriesMemory(seriesKey,{Ai:{meta:{pageIndex:0,seriesSummaryRecords:[{text:series,sourceIds:['P0']}]}}},'th',chapterOne);
  const ai = await buildAiPayload('lens_text','ai',snap.settings,seriesKey,'th',chapterTwo);
  ai.conversation = {documentId:`synthetic-${provider}-${kind}`,webchatRunId:`synthetic-${provider}-${kind}`,
    origins:[{pageId:'synthetic-page',pageOrder:1,unitIds:['I1_P0'],originalIds:['g0']}]};
  await translateViaServer([{id:'I1_P0',text:'こんにちは Hello 안녕하세요'}], {ai,base,targetLang:'th',sourceLang:'ja',
    batchId:`synthetic-${provider}-${kind}`,operationId:crypto.randomUUID(),tabSession:'synthetic-owner',
    capabilities:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}});
  const wire = structuredClone(sent.at(-1));
  wire.provider.apiKey = ''; // Only synthetic prompt/settings evidence crosses this test seam.
  fixtures.push({provider,kind,wire});
  const label = `${provider}/${kind}`;
  const enabled = kind === 'saved-on';
  const passed = snap.settings.aiStyleExamples === enabled && ai.style_examples === enabled && wire.memory.styleExamples === enabled;
  checks.push({case:label,passed,resolvedExamples:snap.settings.aiStyleExamples,wireExamples:wire.memory.styleExamples});
  if (!passed) failures.push(label);
  assert.equal(wire.memory.mode, kind === 'fresh' ? 'off' : 'full');
  if (kind !== 'fresh') assert.equal(wire.prompt,style,'Legacy style text must remain exact');
}
if (!process.argv.includes('--emit-fixtures')) console.log(JSON.stringify({scope:
  'Actual normal settings reader, Paid/Login resolver, job AI builder and HTTP serializer; synthetic account replies; no real generation',
  checks,total:checks.length},null,2));
assert.deepEqual(failures, [], 'Paid/Login examples default OFF and attach only after an explicit scoped opt-in');
for (const source of ['tp', 'login']) {
  const els = {aiProvider:{value:'openai'},aiModel:{value:'synthetic-manual-model'},
    aiPrompt:{value:''},lang:{value:'th'},aiStyleExamples:{checked:false,disabled:false},
    aiStyleExamplesWrap:{style:{}}};
  const popupStore = {};
  const popup = createAiProfileController({els,state:{desiredLang:'th'},
    setStorage:async patch=>Object.assign(popupStore,structuredClone(patch))});
  await popup.initialize(popupStore);
  popup.setPaidContext({active:true,source,apiBase:base,model:'qa/test',
    provider:'login_gemini',accountScope:'synthetic-account'});
  assert.equal(els.aiStyleExamples.checked,false,`${source}: visible checkbox starts OFF`);
  assert.equal(els.aiStyleExamples.disabled,false);
  assert.equal(els.aiStyleExamplesWrap.style.display,'');
}
if (process.argv.includes('--emit-fixtures')) console.log(JSON.stringify(fixtures));
