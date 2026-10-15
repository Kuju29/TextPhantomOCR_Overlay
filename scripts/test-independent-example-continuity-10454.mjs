// Real Extension Local pipeline and provider transports against loopback-only
// synthetic Ollama / LM Studio servers. Source detection is not pool ownership.
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {webcrypto} from 'node:crypto';
import {createIndependentExampleStore} from '../src/background/ai/independent-example-store.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';
import {translateDirectLocal} from '../src/background/ai/transports/direct-local.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {makePageCheckpoint} from '../src/background/repair/page-checkpoint.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS} from '../src/generated/canonical-prompt-plans.js';

globalThis.crypto ||= webcrypto;
const disk = {}, packets = [], diagnostics = [], results = [];
const read = async key => ({[key]: structuredClone(disk[key])});
const write = async patch => Object.assign(disk, structuredClone(patch));
const examples = createIndependentExampleStore({read, write});
const workload = createWorkloadController({read, write, emit: () => {}});
let currentTarget = 'th', fixtureFailure = null;
const firstSource = 'Hello from the first English page';
const firstTranslation = 'สวัสดีจากหน้าแรก';

const server = http.createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const native = request.url === '/api/v1/chat';
    const user = native ? body.input : body.messages?.at(-1)?.content;
    const system = native ? body.system_prompt : body.messages?.[0]?.content;
    assert.equal(typeof user, 'string');
    assert.equal(typeof system, 'string');
    assert.match(user, /<<TP_P0:/);
    if (native) {
      assert.equal(body.store, false, 'Local Independent must remain stateless');
      assert.equal(body.previous_response_id, undefined);
    } else {
      assert.equal(request.url, '/v1/api/chat');
      assert.deepEqual(body.messages.map(message => message.role), ['system', 'user']);
      assert.equal(body.messages.length, 2, 'no accepted pairs may become chat history');
    }
    assert(!JSON.stringify(body).includes('image_url'), 'no prior image replay');
    packets.push({body, user, system, native});
    const answer = currentTarget === 'en' ? 'A new English translation'
      : user.includes(`<<TP_P0:${firstSource}>>`) ? firstTranslation : 'คำแปลในหน้าถัดไป';
    const content = `<<TP_P0:${answer}>>` + (user.includes("TP_MEMO") ? "\n<<TP_MEMO:ตัวละครทักทายกันในตอนนี้>>" : "");
    if (native) {
      const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify({type, ...value})}\n\n`;
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.end(event('chat.start', {model_instance_id: body.model}) +
        event('message.delta', {content}) +
        event('chat.end', {result: {model_instance_id: body.model,
          output: [{type: 'message', content}], stats: {input_tokens: 200,
            total_output_tokens: 22, reasoning_output_tokens: 0}}}));
    } else {
      response.writeHead(200, {'content-type': 'application/x-ndjson'});
      response.end(JSON.stringify({model: body.model,
        message: {role: 'assistant', content}, done: false}) + '\n' +
        JSON.stringify({model: body.model, done: true, done_reason: 'stop',
          prompt_eval_count: 200, eval_count: 22, total_duration: 1e7}) + '\n');
    }
  } catch (error) {
    fixtureFailure = error;
    response.writeHead(500, {'content-type': 'application/json'});
    response.end('{}');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
// Keep the endpoint identical when changing only the provider identity. The
// Ollama adapter accepts a proxy prefix; LM Studio requires a /v1 base URL.
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const service = createTranslationService({directLocal: (units, options) =>
  translateDirectLocal(units, {...options,
    canonicalPrompt: BUNDLED_CANONICAL_PROMPT_PLANS[options.targetLang],
    wireTrace: (event, value) => diagnostics.push([event, structuredClone(value)])})});
const defaults = {owner: 'tab-session-A', batch: 'batch-A',
  document: 'https://reader.invalid/story/1', provider: 'ollama',
  model: 'fixture-model', sourceLang: 'en', targetLang: 'th', enabled: true};
const capabilities = {limits: {scope: 'runtime', source: 'fixture', contextTokens: 16384,
  runtimeContextTokens: 16384, modelContextTokens: 32768, maxOutputTokens: 4096},
  reasoning: {supported: false}, structuredOutput: {supported: false}};
let serial = 0;
async function page(source, patch = {}, store = examples) {
  const options = {...defaults, ...patch};
  currentTarget = options.targetLang;
  const imageId = `continuity-${++serial}`;
  const units = [{id: `${imageId}-unit`, text: source, translatable: true, paragraphIds: ['p0']}];
  const before = packets.length, beforeDiagnostics = diagnostics.length;
  let checkpoint;
  const result = {lensDocument: {languages: {source: options.sourceLang}}, eraseBoxes: []};
  const out = await translateLensPage({base: 'http://fixture.invalid',
    payload: {lang: options.targetLang, source: 'ai',
      context: {series_key: 'reader.invalid', tp_tab_session: options.owner,
        batch_id: options.batch, page_url: options.document},
      metadata: {image_id: imageId}, idempotency_key: crypto.randomUUID()},
    result, plan: {route: 'direct-local', ai: {provider: options.provider,
      model: options.model, base_url: endpoint,
      local_adapter: {protocol: options.provider === 'lmstudio' ? 'openai' : 'ollama', baseUrl: endpoint},
      prompt: '', translation_mode: 'independent', style_examples: options.enabled,
      memory_mode: options.memoryMode || 'off',
      thinking: 'off', model_capabilities: capabilities}},
    onCheckpoint: async data => {
      if (data.stage === 'prepared') checkpoint = await makePageCheckpoint({...data, ctx: {jobId: imageId}});
    }, dependencies: {workloadController: workload, independentExampleStore: store,
      refreshLocalAiCapabilities: async ai => ai,
      getSeriesMemory: async () => ({glossary:[],characters:[],state:options.prior || "",prevContext:[]}),
      requireAiLensDocument: value => value.lensDocument, translationUnits: () => units,
      requireTranslationConservation: () => ({eligibleParagraphCount: 1,
        excludedBlankParagraphCount: 0, unitCount: 1}),
      translateUnits: service, diagnoseTargetScripts: () => [], summarizeUnitScripts: () => [],
      applyTranslations: (doc, items) => ({document: {...doc, applied: items},
        report: {translated: 1, missing: [], complete: true}}),
      classifyAiTranslationReport: report => ({usable: true, ...report}),
      eraseBoxesForAiPartial: () => ({ok: true, eraseBoxes: []})}});
  if (fixtureFailure) throw fixtureFailure;
  assert.equal(out.complete, true);
  assert.equal(packets.length, before + 1, 'one page means one provider request, without retries');
  assert.equal(checkpoint.ai.independent_examples, undefined, 'pairs are not duplicated into page checkpoints');
  const contracts = diagnostics.slice(beforeDiagnostics).filter(([name]) => name === 'contractSelection');
  assert.equal(contracts.length, 1);
  return {packet: packets.at(-1), checkpoint, result, contract: contracts[0][1]};
}
async function check(name, run) {
  try { await run(); results.push({name, status: 'pass'}); }
  catch (error) { results.push({name, status: 'fail', error: error.message}); }
}

let first, second;
try {
  await check('ON first request uses four human examples', async () => {
    first = await page(firstSource);
    assert.equal(first.contract.independentExamples.source, 'human');
    assert.equal(first.contract.independentExamples.includedPairs, 4);
    assert.match(first.packet.user, /H01\nEN:/);
    assert.match(first.packet.user, /H04\nEN:/);
  });
  await check('detected English to Japanese retains accepted AI examples', async () => {
    second = await page('こんにちは、次のページです', {sourceLang: 'ja'});
    assert.equal(second.contract.independentExamples.source, 'story',
      'source detection must not reset the accepted example pool');
    assert.equal(second.checkpoint.ai.independent_scope.key, first.checkpoint.ai.independent_scope.key);
    assert(second.packet.user.includes(firstSource));
    assert(second.packet.user.includes(firstTranslation));
    assert.doesNotMatch(second.packet.user, /H01\nEN:/);
    assert.equal(second.packet.system, first.packet.system,
      'detected source must not choose a different translation instruction pack');
    assert.match(second.packet.user, /<<TP_P0:こんにちは、次のページです>>/);
    assert.equal(second.contract.independentExamples.includedPairs, 1);
  });
  await check('one OFF flag suppresses human and AI examples and all learning', async () => {
    const previous = structuredClone(disk.aiIndependentExamplesV1);
    const forbidden = {...examples,
      scope: async () => { assert.fail('OFF must not resolve an example storage scope'); },
      append: async () => { assert.fail('OFF must not learn accepted translations'); },
      select: async (_scope, _lang, enabled) => {
        assert.equal(enabled, false);
        return {source: 'none', pairs: [], scopeStatus: 'disabled', storageStatus: 'disabled'};
      }};
    for (const batch of ['batch-A', 'fresh-off-batch']) {
      const off = await page('無効な例の入力', {sourceLang: 'ja', batch, enabled: false}, forbidden);
      assert.equal(off.contract.independentExamples.source, 'none');
      assert.equal(off.contract.independentExamples.exampleChars, 0);
      assert(!off.packet.user.includes(firstSource));
      assert.doesNotMatch(off.packet.user, /H01\nEN:/);
    }
    assert.deepEqual(disk.aiIndependentExamplesV1, previous);
    const enabledAfterOff = await page('Examples enabled after OFF', {batch: 'fresh-off-batch'});
    assert.equal(enabledAfterOff.contract.independentExamples.source, 'human',
      'OFF results must not become the next ON request\'s story examples');
    assert(!enabledAfterOff.packet.user.includes('無効な例の入力'));
  });
  for (const [dimension, patch] of Object.entries({
    target: {targetLang: 'en'}, provider: {provider: 'lmstudio'},
    model: {model: 'another-model'}, owner: {owner: 'tab-session-B'},
    batch: {batch: 'batch-B'}, document: {document: 'https://reader.invalid/story/2'},
  })) {
    await check(`${dimension} boundary starts with human examples`, async () => {
      const result = await page(`Fresh ${dimension} boundary`, {...patch, sourceLang: 'ja'});
      assert.equal(result.contract.independentExamples.source, 'human');
      assert.notEqual(result.checkpoint.ai.independent_scope.key, first.checkpoint.ai.independent_scope.key);
      assert(!result.packet.user.includes(firstSource), 'accepted English source must not cross ownership boundaries');
      assert(!result.packet.user.includes('こんにちは、次のページです'), 'accepted Japanese source must not cross ownership boundaries');
    });
  }
  await check('Full Independent receives same-call summary and repeats prior-chapter seed', async () => {
    for (const provider of ['ollama','lmstudio']) {
      for (let request=0;request<2;request++) {
        const r=await page('Current chapter greeting',{provider,memoryMode:'full',enabled:false,prior:'PRIOR_CHAPTER_SEED'});
        assert.match(r.packet.user,/TP_MEMO/);
        assert.match(r.packet.user,/PRIOR_CHAPTER_SEED/);
        assert.equal(r.result.Ai.meta.seriesSummaryRecords.length,1);
        assert.equal(r.result.Ai.meta.seriesSummaryRecords[0].text,'ตัวละครทักทายกันในตอนนี้');
        assert(!JSON.stringify(r.result.lensDocument).includes('TP_MEMO'));
      }
    }
  });
  const failed = results.filter(result => result.status === 'fail');
  console.log(JSON.stringify({suite: 'independent-example-continuity-10454',
    passed: results.length - failed.length, total: results.length,
    providerRequests: packets.length, failures: failed, cases: results}, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  await new Promise(resolve => server.close(resolve));
}
