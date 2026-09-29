import assert from 'node:assert/strict';
import { withRequestSlot } from '../src/background/ai/translation-paths/request-slot.js';
import { laneKeyFor, describe, reset } from '../src/background/scheduler.js';
import { waitForLocalRequest } from '../src/background/ai/local-request-rate.js';
import { translateDirectLocal } from '../src/background/ai/transports/direct-local.js';
import { buildRatePayload, buildLimitsPayload } from '../src/background/context-menu.js';
import { localProviderCatalog, localProviderWebsite, localAiPreset } from '../src/shared/ai/providers/local-registry.js';
import { getCanonicalPrompt } from '../src/background/ai/prompt-cache.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';

const payload = {mode:'lens_text',source:'ai',engine:'extension',
  ai:{provider:'groq',model:'openai/gpt-oss-20b',api_key:'fixture'}};
const key = laneKeyFor(payload);
async function fail(code, extra={}) {
  const error = Object.assign(new Error(code), {code, ...extra});
  await assert.rejects(withRequestSlot({payload,unitCount:4},null,async()=>{throw error}),
    candidate=>candidate===error);
  return describe(key);
}
reset();
const provider = await fail('provider_rate_limited', {status:429, upstreamStatus:429,
  requestDispatched:true, providerAttempts:1, generationAttempts:0, retryAfterMs:27000});
assert.equal(provider.rejected,1,'Conversation must pause the next provider request');
assert.ok(provider.pausedMs>25000,'Groq Retry-After must reach the provider lane');
reset();
const gate = await fail('api_rate_gate_timeout', {status:429,
  providerAttempts:0,generationAttempts:0,retryAfterMs:1000});
assert.equal(gate.rejected,0,'API admission must not narrow provider capacity');
assert.ok(gate.deferred>0 && gate.pausedMs>0,'API admission keeps its own cooldown');

const local = {aiProvider:'lmstudio',aiBaseUrl:'http://localhost:1234/v1',
  aiLocalRateLimitEnabled:true,aiLocalRateRpm:600,aiLocalRateBurst:1,
  rateLimitEnabled:true,rateProfile:'custom',rateRpm:2,rateBurst:2};
const rate = buildRatePayload('lens_text','ai',local);
assert.equal(localProviderCatalog().length,9);
assert.equal(localAiPreset('localai'),null,'removed named preset cannot be selected');
for (const spec of localProviderCatalog()) assert.match(localProviderWebsite(spec.id),/^https:\/\//);
assert.equal(localProviderWebsite('customlocal'),'','custom endpoints must not become website links');
assert.deepEqual(rate,{enabled:true,rpm:600,burst:1,unlimited:false});
assert.equal(buildLimitsPayload(local).aiUnlimited,false);
const ai = {provider:'lmstudio',base_url:'http://localhost:1234/v1',model:'test'};
await waitForLocalRequest(ai,rate);
const aborter = new AbortController();
const cancelled = waitForLocalRequest(ai,rate,aborter.signal);
aborter.abort();
await assert.rejects(cancelled, error=>error?.name==='AbortError');
const started = performance.now();
await waitForLocalRequest(ai,rate);
assert.ok(performance.now()-started>=65,'the next initial or repair request must wait for a token');
const other = performance.now();
await waitForLocalRequest({...ai,base_url:'http://localhost:1337/v1'},rate);
assert.ok(performance.now()-other<65,'a different Local endpoint has its own cap');
const off = buildRatePayload('lens_text','ai',{...local,aiLocalRateLimitEnabled:false});
assert.equal(off.enabled,false,'disabling Local must not activate the Cloud cap');
// A rejected preflight must not spend a token or make the next error wait a
// full minute; only the actual Local provider POST consumes the cap.
const invalid = {provider:'lmstudio',model:'auto',base_url:'http://localhost:1234/v1'};
for (let n=0;n<2;n++) {
  const aborter = new AbortController();
  const timer = setTimeout(()=>aborter.abort(),150);
  try {
    await assert.rejects(translateDirectLocal([{id:'P0',text:'OCR'}],{
      ai:invalid,rate:{enabled:true,rpm:1,burst:1},signal:aborter.signal,targetLang:'th',sourceLang:'en'}),
      error=>error?.code==='local_model_missing');
  } finally { clearTimeout(timer); }
}
// Cancellation during async request preparation must never reach the provider.
// An abort before the listener is installed and one during the admission hook
// exercise both sides of the actual POST boundary.
const plan = await getCanonicalPrompt('', 'th', {wantMemo:false});
const localAi = {provider:'lmstudio',base_url:'http://localhost:1234/v1',model:'test',thinking:'default'};
const originalFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = async () => {fetches++; throw new Error('provider POST should not happen');};
try {
  await assert.rejects(translateWithLocalOpenAi([{id:'P0',text:'OCR'}],{
    ai:localAi,canonicalPrompt:plan,targetLang:'th',
    beforeDispatch:signal=>waitForLocalRequest(localAi,{enabled:true,rpm:0,burst:1},signal),
  }),error=>error?.code==='invalid_local_request_rate' && error?.requestDispatched===false);
  assert.equal(fetches,0,'invalid enabled Local cap must fail before provider POST');
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const midPreparation = new AbortController();
  const duringPreparation = translateWithLocalOpenAi([{id:'P0',text:'OCR'}],{
    ai:localAi,canonicalPrompt:plan,targetLang:'th',signal:midPreparation.signal,
    wireTrace:async stage=>{if(stage==='systemPrompt'){entered.resolve();await released.promise;}},
  });
  await entered.promise;
  midPreparation.abort();
  released.resolve();
  await assert.rejects(duringPreparation,error=>error?.code==='cancelled');
  const midAdmission = new AbortController();
  await assert.rejects(translateWithLocalOpenAi([{id:'P0',text:'OCR'}],{
    ai:localAi,canonicalPrompt:plan,targetLang:'th',signal:midAdmission.signal,
    beforeDispatch:async()=>{midAdmission.abort();},
  }),error=>error?.code==='cancelled');
  assert.equal(fetches,0,'cancellation before provider dispatch must make zero HTTP requests');
} finally {globalThis.fetch=originalFetch;}
console.log('PASS Conversation provider 429 / API admission / independent Local request pacing');
