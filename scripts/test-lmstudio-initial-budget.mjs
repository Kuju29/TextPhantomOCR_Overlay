import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ensureLocalAiBatchReady, refreshLocalAiCapabilities } from '../src/background/local-ai-preflight.js';
import { budgetDiagnostic } from '../src/shared/ai/request-diagnostics.js';
import { shortenValue } from '../src/shared/trace.js';
import { createWorkloadController } from '../src/background/ai/workload-controller.js';
import { estimateRequest, initialProfile } from '../src/shared/ai/workload/model.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { getCanonicalPrompt } from '../src/background/ai/prompt-cache.js';
import { openAiCompatibleCapabilityHints } from '../src/shared/ai/providers/local-openai-compatible.js';

const model = 'google/gemma-4-e4b';
const endpoint = 'http://localhost:1234/v1';
const rows = [
  { id: 'g0', text: 'AH, REIRIN.' },
  { id: 'g4', text: 'MY APOLOGIES FOR THE SUDDEN SUMMONS.' },
  { id: 'g7', text: 'Chapter 23: Reirin Gets Abducted' },
  { id: 'g8', text: 'WELL, I SUPPOSE...' },
];
const native = (context) => [{ type: 'llm', key: model,
  max_context_length: 131072,
  capabilities: {reasoning: {allowed_options:['off','on'],default:'on'}},
  loaded_instances: [{ id: model, config: { context_length: context } }] }];
const hint = openAiCompatibleCapabilityHints([model], native(8192)).models[model];
assert.equal(hint.limits.contextTokens, 8192);
assert.equal(hint.limits.runtimeContextTokens, 8192);
const coldJit = openAiCompatibleCapabilityHints([model], [{ ...native(8192)[0], loaded_instances: [] }])
  .models[model].limits;
assert.equal(coldJit.contextTokens, 131072,
  'the model-advertised JIT ceiling is available for planning; generation requests only the needed allocation');
assert.equal(coldJit.runtimeContextTokens, undefined,
  'a bounded JIT request is not the loaded allocation');
assert.equal(coldJit.scope, 'request');
assert.equal(openAiCompatibleCapabilityHints([model], native(8192).map(entry => ({ ...entry,
  loaded_instances: [{ id: 'another-instance', config: { context_length: 4096 } }] })))
  .models[model].limits, undefined, 'a different instance cannot supply this model ID\'s window');
assert.equal(openAiCompatibleCapabilityHints([model], native(8192).map(entry => ({ ...entry,
  loaded_instances: [{ id: model, config: { context_length: 8192 } },
    { id: model, config: { context_length: 4096 } }] })))
  .models[model].limits, undefined, 'conflicting instance metadata is not a verified window');

const originalFetch = globalThis.fetch;
let loadedContext = 8192;
let generations = 0;
const requests = [];
const reply = (payload) => new Response(JSON.stringify(payload),
  { status: 200, headers: { 'content-type': 'application/json' } });
const storage = {};
const get = async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
  .map(key => [key, storage[key]]));
const set = async values => Object.assign(storage, structuredClone(values));
const controller = createWorkloadController({ read: get, write: set, emit: () => {} });
const settings = { aiProvider: 'lmstudio', aiBaseUrl: endpoint, aiModel: model,
  aiLocalThinking: 'off' };
const style = 'ใช้ภาษาไทยให้เป็นธรรมชาติ '.repeat(280);
const aiOptions = { provider: 'lmstudio', model, base_url: endpoint, translation_mode: 'independent',
  thinking: 'off', style_examples: false, prompt: style, prompt_mode: 'replace' };
const canonicalPrompt = await getCanonicalPrompt(style, 'th', { wantMemo: false });
const translated = rows.map((_, i) => `<<TP_P${i}:คำแปล${i}>>`).join('\n');

globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  if (address.endsWith('/api/v1/models')) return reply({ models: native(loadedContext) });
  if (address.endsWith('/v1/models')) return reply({ data: [{ id: model }] });
  assert.ok(address.endsWith('/api/v1/chat'));
  const body = JSON.parse(init.body);
  requests.push(body);
  generations++;
  assert.equal(body.reasoning,'off');
  assert.equal(body.store,false);
  const enoughForAnswer = body.max_output_tokens >= 120;
  return reply({ model_instance_id:model,
    output: [{type:'message',content:enoughForAnswer ? translated : ''}],
    stats: {input_tokens:4757,total_output_tokens:enoughForAnswer ? 115 : body.max_output_tokens,
      reasoning_output_tokens:0},
  });
};

try {
  const ready = await ensureLocalAiBatchReady(settings, { get, set, emitTrace: () => {} });
  assert.equal(ready.settings.aiModelCapabilities.limits.contextTokens, 8192);
  const session = await controller.open({ ai: { ...aiOptions,
    model_capabilities: ready.settings.aiModelCapabilities }, route: 'direct-local',
    targetLang: 'th' });
  const explicitlyNonReasoning = estimateRequest(rows, initialProfile(), {
    contract: 'compact_records', fixedInput: 300, provider: 'lmstudio',
    reasoningSupported: false, reasoningActive: false, limits: { contextTokens: 8192 },
  });
  assert.equal(explicitlyNonReasoning.reasoningReserve, 0,
    'confirmed non-reasoning Local models must not inherit the LM Studio cold reserve');
  const userCapped = await controller.open({ ai: { ...aiOptions, max_output_tokens: 500,
    model_capabilities: ready.settings.aiModelCapabilities }, route: 'direct-local', targetLang: 'th' });
  assert.equal(userCapped.next(rows,0).estimate.completionAvailable,500,
    'a user-selected 500-token output ceiling is never enlarged');
  assert.equal(generations, 0, 'a user-selected output limit is never enlarged silently');
  const chunk = session.next(rows, 0);
  assert.equal(chunk.estimate.inputUnverified, true);
  const coldBudget = shortenValue(budgetDiagnostic(chunk, {pageUnits: rows.length}));
  assert.equal(coldBudget.planned.inputCountStatus, 'runtime_count_pending');
  assert.equal(coldBudget.planned.inputSampleCount, 0);
  const crossRuntime = spawnSync('python', ['-c',
    'import json,sys;from backend.diagnostic_schema import sanitize_audit;print(json.dumps(sanitize_audit(json.load(sys.stdin))))'],
  {cwd:process.cwd(),env:{...process.env,PYTHONPATH:'api'},encoding:'utf8',input:JSON.stringify(budgetDiagnostic(chunk,{pageUnits:rows.length}))});
  assert.equal(crossRuntime.status, 0, crossRuntime.stderr);
  assert.equal(JSON.parse(crossRuntime.stdout).planned.inputCountStatus, 'runtime_count_pending');
  assert.equal(chunk.estimate.reasoningReserve,0,
    'verified native Thinking off must not reserve thousands of hidden tokens');
  assert.ok(chunk.estimate.target > 160,
    'verified native context must not inherit the legacy cold 160-token target');
  assert.ok(chunk.estimate.rawEstimatedInput > 8192,
    'the multilingual script heuristic must reproduce the observed overestimate');
  const workload = { version: 1, ...chunk.estimate };
  const answer = await translateWithLocalOpenAi(chunk.units, { canonicalPrompt,
    targetLang: 'th', ai: { ...session.ai, workload } });
  assert.equal(generations, 1, 'the first generation must produce a real answer without repair');
  assert.ok(requests[0].max_output_tokens >= 120 && requests[0].max_output_tokens <= Math.floor(8192*.4));
  assert.equal(answer.translations.length, rows.length);
  assert.deepEqual(answer.missing, []);
  session.observe({ units: chunk.units, answer, plan: chunk.estimate });
  assert.equal(session.snapshot().inputSamples.length, 1,
    'the next request may calibrate from reported prompt tokens');

  loadedContext = 4096;
  const justBeforeNext = await refreshLocalAiCapabilities({ ...aiOptions,
    model_capabilities: ready.settings.aiModelCapabilities }, 'direct-local',
  {get,set,emitTrace:()=>{}});
  assert.equal(justBeforeNext.model_capabilities.limits.contextTokens,4096,
    'an in-progress job must see the new loaded instance, even when the saved profile did not change');
  const smaller = await ensureLocalAiBatchReady(settings, { get, set, emitTrace: () => {} });
  assert.equal(smaller.audit.source, 'live_metadata');
  assert.equal(smaller.settings.aiModelCapabilities.limits.contextTokens, 4096);
  const limited = await controller.open({ ai: { ...aiOptions,
    model_capabilities: smaller.settings.aiModelCapabilities }, route: 'direct-local', targetLang: 'th' });
  assert.equal(limited.key, session.key, 'runtime resize keeps exact-model token measurements');
  assert.throws(() => limited.next(rows, 0), e => e.code === 'ai_workload_budget_insufficient');
  assert.equal(generations, 1, 'a proven too-small window is rejected before sending AI');

  loadedContext = 16384;
  const larger = await ensureLocalAiBatchReady(settings, { get, set, emitTrace: () => {} });
  const expanded = await controller.open({ ai: { ...aiOptions,
    model_capabilities: larger.settings.aiModelCapabilities }, route: 'direct-local', targetLang: 'th' });
  assert.equal(expanded.next(rows, 0).estimate.limits.contextTokens, 16384);
  assert.equal(expanded.next(rows, 0).estimate.inputUnverified, false);
  assert.equal(shortenValue(budgetDiagnostic(expanded.next(rows,0),{pageUnits:rows.length})).planned.inputCountStatus,
    'provider_usage_calibrated');
  console.log('PASS LM Studio loaded window + first reasoning answer + runtime resize across batch admission');
} finally {
  globalThis.fetch = originalFetch;
}
