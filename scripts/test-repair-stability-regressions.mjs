import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
globalThis.crypto ||= webcrypto;
const root = pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
const from = p => import(new URL(p, root));
const { createTranslationSessionStore } = await from('src/background/translation-session-store.js');
const { makePageCheckpoint, buildPatchedResult } = await from('src/background/repair/page-checkpoint.js');
const { createRepairCoordinator } = await from('src/background/repair/coordinator.js');
const { executeRepairPool } = await from('src/background/repair/executor.js');
const { translationUnits } = await from('src/shared/lens-document.js');
const { ensureBatch, batchPassStats } = await from('src/background/batches.js');
const results = [];
async function check(name, work) {
  try { await work(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, pass: false, error: e.message }); console.error(`FAIL ${name}: ${e.message}`); }
}
function doc() { return { schema: 'tp.lens-document/1', image: { width: 100, height: 100 }, languages: { source: 'ja', target: 'th' }, paragraphs: [0,1].map(i => ({ id: `p${i}`, sourceText: `こんにちは ${i}`, items: [] })) }; }
function result() { return { backgroundMode: 'boxes', layout: { relayout_translated: false }, lensDocument: doc(), eraseBoxes: { schema: 'tp.erase-boxes/1', boxes: [0,1].map(i => ({ l: .1, t: .1 + i*.2, w: .3, h: .1, p: `p${i}` })) } }; }
async function page(id = 'page', aiOverrides = {}) {
  const d = result();
  return makePageCheckpoint({ payload: { metadata: { image_id: id }, lang: 'th' }, result: d, units: translationUnits(d.lensDocument), plan: { route: 'direct-local', ai: { provider: 'ollama', model: 'fixture', thinking: 'off', ...aiOverrides } }, ctx: { jobId: `gen:${id}` }, operationId: `op:${id}` });
}
function bridge() {
  const child = spawn('python', ['-u', 'scripts/repair-ledger-fixture.py'], { cwd: root, stdio: ['pipe','pipe','inherit'] });
  const queue = [];
  createInterface({ input: child.stdout }).on('line', s => { const q = queue.shift(), r = JSON.parse(s); r.ok ? q.resolve(r.value) : q.reject(Object.assign(new Error(r.code), r)); });
  child.on('error', error => { for (const q of queue.splice(0)) q.reject(error); });
  child.on('exit', code => { for (const q of queue.splice(0)) q.reject(new Error(`Ledger fixture exited ${code}`)); });
  return { api(run, action = '', body, options = {}) { return new Promise((resolve, reject) => { queue.push({ resolve, reject }); child.stdin.write(JSON.stringify({ run, action: options.method === 'DELETE' ? 'delete' : action, body }) + '\n'); }); }, close() { child.stdin.end(); } };
}
await check('checkpoint preserves erasure/rendering contract and accepted translation', async () => {
  const p = await page(); p.accepted = [{ id: 'g0', text: 'ของดีเดิม' }];
  const built = buildPatchedResult(p, [{ id: 'R0', unitId: 'g1', sourceHash: p.units[1].sourceHash, generationId: p.generationId, translation: 'ซ่อมแล้ว' }]);
  const TP = {};
  vm.runInNewContext(await readFile(new URL('src/content/overlay/background.js', root), 'utf8'), { window: { __TP: TP }, WeakMap });
  assert.equal(TP.overlayBackground.wants(built.result), true, 'repair must keep the clean-background renderer selected');
  assert.deepEqual(built.result.layout, { relayout_translated: false });
  assert.equal(built.result.lensDocument.paragraphs[0].aiText, 'ของดีเดิม');
  assert.equal(built.result.lensDocument.paragraphs[1].aiText, 'ซ่อมแล้ว');
  assert.deepEqual(built.result.eraseBoxes.boxes.map(b => b.p), ['p0', 'p1']);
});
async function runPool(abortAfterSecond = false, abortOnDispatch = false, wrongLanguage = false, options = {}) {
  const b = bridge(), ctrl = new AbortController();
  const calls = [], applications = [], progressEvents = [], observations = [], checkpoints = [];
  let capacityRunning = 0, translateRunning = 0, maxTranslateRunning = 0;
  const capacityWaiters = [];
  const capacityLimit = Math.max(1, Number(options.capacityLimit) || Number.MAX_SAFE_INTEGER);
  const withCapacity = async (_p, _a, signal, fn) => {
    if (capacityRunning >= capacityLimit) {
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject }; capacityWaiters.push(waiter);
        if (signal) signal.addEventListener('abort', () => {
          const index = capacityWaiters.indexOf(waiter); if (index >= 0) capacityWaiters.splice(index, 1);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once:true });
      });
    }
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    capacityRunning++;
    try { return await fn(); }
    finally {
      capacityRunning--;
      capacityWaiters.shift()?.resolve();
    }
  };
  try {
    const run = { id: `test:${crypto.randomUUID()}`, token: 'a'.repeat(64) };
    const pages = new Map(await Promise.all([0,1,2].map(async i => { const p = await page(`p${i}`, options.conversation ? {translation_mode:'conversation',conversation:{pageId:`p${i}`,pageOrder:i+1,pageIndex:i,documentId:'repair-fixture',owner:'owner'}} : {}); return [p.pageId, p]; })));
    await b.api(run, 'register', { manifest: [...pages.keys()] });
    for (const p of pages.values()) await b.api(run, 'pages', { pageId: p.pageId, generationId: p.generationId, groupKey: p.groupKey, status: 'finished', initialAccepted: 0, failed: (options.reverseUnits ? [...p.units].reverse() : p.units).map(u => ({ id: u.id, text: u.text, sourceHash: u.sourceHash, reason: 'missing' })) });
    let caught;
    try {
      await executeRepairPool({ run, snapshot: await b.api(run, 'seal', {}), executor: 'w', signal: ctrl.signal, api: b.api,
        getPage: async id => pages.get(id), resolveAi: async p => p.ai, checkpointTask: async task => { checkpoints.push(task); if (abortOnDispatch && task.state === 'dispatched') ctrl.abort(); },
        onProgress: event => progressEvents.push(event),
        applyResults: async rows => applications.push({ calls: calls.length, ids: rows.map(r => r.id) }),
        withCapacity, planner: { open: async () => ({
          nextRepair(rows) { return this.next(rows); },
          next: rows => ({ units: rows.slice(0, Number(options.planSize) || 2),
            estimate: { predictedOutput: 128, reasoningReserve: 0, estimatedInput: 128, completionAvailable: 1024 } }),
          observe: ({ error, defects = {} }) => {
            const outcome = error
              ? (/output_budget_exhausted|invalid_model_output|output_contract|invalid_result_schema/i.test(String(error.code || '')) ? 'length' : 'ignored')
              : defects.missing?.length ? 'structure'
                : defects.wrongLanguage?.length ? 'language' : 'ok';
            observations.push(outcome);
            return { outcome };
          },
        }) },
        translate: async units => {
          calls.push(units); translateRunning++; maxTranslateRunning = Math.max(maxTranslateRunning, translateRunning);
          try {
            if (abortAfterSecond && calls.length === 2) ctrl.abort();
            if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
            if (options.billingFailure) throw Object.assign(new Error('Credits depleted'), {
              code:'billing_required', failureKind:'billing_required', upstreamStatus:402,
              requestDispatched:true, providerAttempts:1, generationAttempts:0,
            });
            if (calls.length <= Number(options.capacityFailures || 0)) {
              const error = Object.assign(new Error('fixture output budget exhausted'), {
                code: 'output_budget_exhausted', requestDispatched: true, providerResponded: true,
                generationAttempts: 1, providerAttempts: 1,
                generationMeta: { model: 'fixture', selectedContract: 'tp.translation.schema-object/1',
                  finishReason: 'length', usage: { source: 'provider', outputTokens: 4096, thinkingTokens: 3900 } },
              });
              throw error;
            }
            if (typeof options.translateImpl === 'function')
              return await options.translateImpl(units, calls.length);
            return { translations: units.map(u => ({ id: u.id, text: wrongLanguage ? '日本語のままです' : 'คำแปลไทย' })) };
          } finally { translateRunning--; }
        }
      });
    } catch (error) { caught = error; }
    return { calls, applications, caught, maxTranslateRunning, progressEvents, observations, checkpoints };
  } finally { b.close(); }
}
await check('pool batches 6 failed units in 3 requests and delivers one final snapshot', async () => {
  const r = await runPool(); if (r.caught) throw r.caught;
  assert.deepEqual(r.calls.map(c => c.length), [2,2,2]);
  assert.equal(r.applications.length, 1, 'do not apply after each provider response');
  assert.equal(r.applications[0].calls, 3);
  assert.equal(r.applications[0].ids.length, 6);
});
await check('repair tasks overlap only up to the scheduler capacity and still apply once', async () => {
  const r = await runPool(false, false, false, { capacityLimit: 2, delayMs: 40 });
  if (r.caught) throw r.caught;
  assert.equal(r.maxTranslateRunning, 2, 'repair generation should overlap instead of serializing every request');
  assert.equal(r.calls.length, 3);
  assert.equal(r.applications.length, 1, 'parallel repair must keep one final DOM patch wave');
  assert.equal(r.applications[0].calls, 3);
});
await check('repair planner admits at most two requests per group before re-planning', async () => {
  const r = await runPool(false, false, false, { capacityLimit: 8, delayMs: 20 });
  if (r.caught) throw r.caught;
  const waves = r.progressEvents.filter(event => event.phase === 'repair_wave');
  assert.deepEqual(waves.map(event => event.taskCount), [2, 1],
    'six units with two-unit plans must be measured as a two-request wave before the final request');
  assert.deepEqual(r.observations, ['ok', 'ok', 'ok']);
});
await check('two generated capacity failures open the repair circuit without a third provider call', async () => {
  const r = await runPool(false, false, false, { capacityLimit: 8, capacityFailures: 2 });
  if (r.caught) throw r.caught;
  assert.equal(r.calls.length, 2, 'remaining repair units must be terminalized without provider dispatch');
  assert.deepEqual(r.observations, ['length', 'length']);
  assert.ok(r.progressEvents.some(event => event.phase === 'repair_circuit_open' && event.unitCount === 2),
    'the two not-yet-dispatched units must be explicitly closed by the circuit');
  assert.equal(r.applications.length, 1, 'the terminal partial result still reaches one final apply pass');
  assert.deepEqual(r.applications[0].ids, []);
});
await check('billing failure stops remaining Conversation repairs and preserves final unresolved report', async () => {
  const r=await runPool(false,false,false,{conversation:true,billingFailure:true,planSize:1});
  if(r.caught)throw r.caught;
  assert.equal(r.calls.length,1, 'only first request reaches Provider; ledger closes unsent tasks');
  assert.ok(r.progressEvents.some(event=>event.phase==='repair_circuit_open'));
  assert.equal(r.applications.length,1);assert.deepEqual(r.applications[0].ids,[]);
});
await check('Conversation repair sorts original units before planner slicing, not merely inside each wire batch', async () => {
  const r=await runPool(false,false,false,{conversation:true,reverseUnits:true,planSize:1});
  if(r.caught)throw r.caught;
  assert.deepEqual(r.calls.flatMap(rows=>rows.map(u=>u.id)),['I1_P0','I1_P1','I2_P0','I2_P1','I3_P0','I3_P1']);
  assert.equal(r.applications[0].ids.length,6);
});
await check('cancellation during pooled generation cannot deliver an intermediate repair', async () => {
  const r = await runPool(true);
  assert.equal(r.caught?.name, 'AbortError');
  assert.equal(r.calls.length, 2);
  assert.equal(r.applications.length, 0, 'cancelled pool must not have partially updated the DOM');
});
await check('repair cancellation during checkpoint does not start a provider request', async () => {
  const r=await runPool(false,true);
  assert.equal(r.caught?.name,'AbortError');assert.equal(r.calls.length,0);assert.equal(r.applications.length,0);
});
await check('wrong-language repair keeps all failed units unresolved despite complete JSON IDs', async () => {
  const r=await runPool(false,false,true);if(r.caught)throw r.caught;
  assert.equal(r.calls.length,3);assert.equal(r.applications.length,1);assert.deepEqual(r.applications[0].ids,[]);
  const rejected=r.checkpoints.filter(t=>t.state==='answered').flatMap(t=>t.wrongLanguageIds);
  assert.equal(rejected.length,6);assert.equal(new Set(rejected).size,6,'persisted validation uses exact pool IDs once');
});
await check('running cloud receipt pauses quickly and remains durable instead of being failed or re-dispatched', async () => {
  const task = { id:'cloud-running', state:'running', route:'server',
    units:[{ id:'R0', pageId:'p0', text:'source' }] };
  const snapshot = { phase:'repairing', pending:[], tasks:[task], repaired:0, unresolved:0, failedUnits:1 };
  const actions = [];
  const api = async (_run, action='') => { actions.push(action); return structuredClone(snapshot); };
  const started = Date.now();
  await assert.rejects(executeRepairPool({
    run:{ id:'receipt-run', token:'a'.repeat(64) }, snapshot:structuredClone(snapshot), executor:'new-worker',
    signal:new AbortController().signal, api, getPage:async()=>null, resolveAi:async()=>({}),
    checkpointTask:async()=>{}, onProgress:()=>{}, applyResults:async()=>{ throw new Error('must not apply'); },
    withCapacity:async()=>{ throw new Error('must not dispatch'); }, translate:async()=>{ throw new Error('must not translate'); },
    receiptPollBudgetMs:25, receiptPollIntervalMs:10,
  }), error => error?.code === 'repair_receipt_pending' && error?.retryable === true);
  assert.ok(Date.now() - started < 500, 'foreground recovery must not wait for the old 12-minute deadline');
  assert.ok(!actions.some(action => action.includes('/fail')), 'running paid receipt must remain resumable');
});
async function runCoordinator({ acknowledge = true, race = false, testProgress = false, partial = false, noSource = false, raceAtFinal = false, deferred = false } = {}) {
  let value = {}, writes = 0, epoch = 7, transientWrites = 0, firstAckSaw = 0;
  const area = { async get(k) { return { [k]: structuredClone(value[k]) }; }, async set(v) {
    writes++; Object.assign(value, structuredClone(v));
    if (raceAtFinal && Object.values(v).some(saved =>
      saved?.row?.phase === 'done' || Object.values(saved?.runs || {}).some(run => run.phase === 'done'))) epoch=8;
  } };
  const sessions = createTranslationSessionStore({ area: () => area });
  const tabId = 77000 + Math.floor(Math.random() * 100000), batch = ensureBatch(crypto.randomUUID(), tabId, 0);
  const ctxs = new Map(), queue = [], rendered = [], terminalErrors = [], events = [];
  const payloads = (noSource ? [0,1,2,3] : [0,1,2]).map(i => ({ engine:'extension', mode:'lens_text', source:'ai', lang:'th', src:`https://fixture.invalid/${i}`, metadata:{ image_id:`p${i}` } }));
  for (const p of payloads) batch.items.set(p.metadata.image_id, { attempt:1, status:'queued', phase:'waiting', payload:p });
  const reports = [];
  const api = async (_r, action, body) => {
    if(action === 'pages') reports.push(body);
    return action === 'seal' ? { phase:'repairing', pending:[] } : {};
  };
  const co = createRepairCoordinator({ sessions, api, currentEpoch: () => epoch, currentSession: () => 'session', getBase: async () => 'http://fixture.invalid', getContext: id => ctxs.get(id), getCapabilitiesFor: async () => ({}), emit: (ev,d) => events.push({ ev,d }),
    insert: async (_tab, msg) => {
      if (msg.type !== 'OVERLAY_HTML') {
        if (msg.type === 'IMAGE_ERROR') terminalErrors.push(msg);
        return { ok:true, applied:true };
      }
      rendered.push(msg);
      if (race) { epoch = 8; return { ok:true, applied:true }; }
      if (!acknowledge) return { ok:true };
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('repair delivery serialized before the other pages were enqueued')), 120);
        queue.push({ resolve, timer });
        if (queue.length === (partial ? 2 : 3)) {
          firstAckSaw = rendered.length;
          for (const entry of queue) { clearTimeout(entry.timer); entry.resolve({ ok:true, applied:true }); }
        }
      });
    },
    execute: async options => {
      const rows = [];
      for (const p of payloads) {
        const saved = await options.getPage(p.metadata.image_id);
        if (!saved) continue;
        rows.push({ id:`R${rows.length}`, pageId:saved.pageId, unitId:'g1', generationId:saved.generationId, sourceHash:saved.units[1].sourceHash, translation:'ซ่อมแล้ว' });
      }
      if (testProgress) {
        await sessions.flush(); const before = writes;
        for (let i=0;i<100;i++) {
          options.onProgress({ phase:'repair_request', taskId:'task', event:'content_delta', unitCount:3 });
          options.onProgress({ phase:'repair_validation', taskId:'task', unitCount:3, acceptedCount:1, rejectedCount:2, wrongLanguageCount:2 });
        }
        await sessions.flush(); transientWrites = writes - before;
      }
      if (partial) {
        rows.pop();
        await options.checkpointTask({id:'language-task',state:'done',wrongLanguageIds:['R2']});
      }
      await options.applyResults(rows);
      return { phase:'done', repaired:rows.length, failedUnits:3, initialAccepted:3,
        unresolved:partial ? 1 : 0, unverified:0,
        unavailablePages:reports.filter(r=>r.status === 'no_source').length, results:rows };
    }
  });
  const run = await co.registerBatch(batch,payloads);
  for (const p of payloads) {
    if (noSource && p.metadata.image_id === 'p3') continue;
    const id = `gen:${p.metadata.image_id}`;
    const ctx = { jobId:id, imageKey:p.metadata.image_id, tabId, frameId:0, imgUrl:p.src, mode:'lens_text', source:'ai', lang:'th', sessionId:'session', settingsEpoch:7, generation:{ pageInstanceId:'instance' } };
    ctxs.set(id,ctx); const r = result();
    await co.capture(batch.id,{ stage:'prepared', payload:p, result:r, plan:{ route:'direct-local', ai:{ provider:'ollama',model:'fixture',thinking:'off' } }, units:translationUnits(r.lensDocument), jobId:id, operationId:`op:${id}` });
    await co.capture(batch.id,{ stage:'finished', payload:p, jobId:id, accepted:[{ id:'g0',text:'ของดีเดิม' }], failures:[{ id:'g1',reason:'wrong_language' }] });
    await co.markDelivered(ctx,!deferred);
    if (deferred) batch.items.get(p.metadata.image_id).deferredImageError = {
      type:'IMAGE_ERROR', original:p.src, message:'deferred repair-owned failure', generation:ctx.generation,
    };
  }
  const initialPresentations=[...batch.items.values()].map(item=>({...item.presentation}));
  await co.finishInitial(batch); await sessions.flush();
  return { final:await sessions.get(run.id), rendered, terminalErrors, firstAckSaw, transientWrites, events, batch, reports, initialPresentations };
}
await check('all repaired pages enter the bulk queue before waiting for the first DOM ACK', async () => {
  const r = await runCoordinator();
  assert.equal(r.final.phase, 'done');
  assert.equal(r.firstAckSaw, 3);
  assert.equal(r.rendered.length, 3);
  assert.equal(batchPassStats(r.batch).inserted,3,'repair ACKs count once, separately from accepted unit totals');
  for (const msg of r.rendered) assert.equal(msg.result.backgroundMode, 'boxes');
});
await check('provider delta telemetry never rewrites the whole session checkpoint', async () => {
  const r = await runCoordinator({ acknowledge:false, testProgress:true });
  assert.equal(r.transientWrites, 0, 'request/validation telemetry must not produce checkpoint writes');
  const validation=r.events.filter(e=>e.d.phase==='repair_validation');assert.equal(validation.length,100);
  assert.equal(validation[0].d.counts.acceptedCount,1);assert.equal(validation[0].d.counts.rejectedCount,2);
  assert.equal(validation[0].d.counts.wrongLanguageCount,2);
  assert.ok(r.final.summary.phase!=='repair_validation','validation must never replace the current UI phase');
});
await check('repair reports retain partial, missing-source and exact language counts after placement', async () => {
  const r=await runCoordinator({partial:true,noSource:true});
  assert.equal(r.final.phase,'done');assert.equal(r.rendered.length,2);
  assert.equal(r.final.summary.repaired,2);assert.equal(r.final.summary.unresolved,1);
  assert.equal(r.final.summary.wrongLanguageCount,1);assert.equal(r.final.summary.unavailablePages,1);
  assert.match(r.batch.repair.label,/2\/3 fixed; 1 unresolved; 1 wrong target language/);
  assert.match(r.batch.repair.label,/1 image\(s\) lack source/);
  assert.equal(r.reports.find(p=>p.pageId === 'p3').status,'no_source');
  assert(r.initialPresentations.slice(0,3).every(p=>p.wrongLanguageCount===1));
  for(const id of ['p0','p1']) {
    const p=r.batch.items.get(id).presentation;
    assert.equal(p.accepted,2);assert.equal(p.applied,2);assert.equal(p.pending,0);
    assert.equal(p.wrongLanguageCount,0);assert.equal(p.repairPhase,'done');
  }
  assert.equal(r.batch.items.get('p2').presentation.wrongLanguageCount,1);
  const event=r.events.findLast(e=>e.ev==='repairProgress'&&e.d.phase==='done');
  const {enrichOperationalTrace,shortenValue}=await from('src/shared/trace.js');
  const compact=shortenValue(enrichOperationalTrace('repairProgress','..',event.d,'trace-fixture'));
  assert.equal(compact.outcome,'partial');assert.equal(compact.owner,'extension');
  assert.equal(compact.counts.unresolved,1);assert.equal(compact.counts.wrongLanguageCount,1);
  assert.equal(compact.counts.unavailablePages,1);assert.equal(compact.placement.appliedRepairedUnits,2);
});
await check('an ambiguous ACK remains apply_pending instead of deleting the checkpoint', async () => {
  const r = await runCoordinator({ acknowledge:false });
  assert.equal(r.final.phase, 'apply_pending');
  assert.equal(batchPassStats(r.batch).inserted,0,'missing ACK never counts as inserted');
  assert.equal(Object.keys(r.final.pages).length, 3);
  for (const p of Object.values(r.final.pages)) assert.ok(p.patchPending);
});
await check('repair-owned IMAGE_ERROR stays deferred until recovery is terminal', async () => {
  const repaired = await runCoordinator({ deferred:true });
  assert.equal(repaired.final.phase,'done');
  assert.equal(repaired.terminalErrors.length,0,'successful repair must never flash the deferred IMAGE_ERROR');
  assert([...repaired.batch.items.values()].every(item=>!item.deferredImageError),
    'successful repair clears the durable deferred terminal message');
  const pending = await runCoordinator({ deferred:true, acknowledge:false });
  assert.equal(pending.final.phase,'apply_pending');
  assert.equal(pending.terminalErrors.length,0,'ambiguous placement is still recoverable and must not be declared terminal');
  assert([...pending.batch.items.values()].every(item=>item.deferredImageError?.type==='IMAGE_ERROR'),
    'apply_pending keeps the terminal message for later recovery');
});
await check('settings change during delivery invalidates the run before terminal cleanup', async () => {
  const r = await runCoordinator({ race:true });
  assert.equal(r.final, null,'cancelled run checkpoint is removed for the next job');
  assert.ok(!r.events.some(e => e.ev === 'repairPatch' && e.d.applied === true));
  assert.equal(batchPassStats(r.batch).inserted,0,'stale repair does not add an insertion');
});
await check('settings change during final repair commit cannot emit stale done', async () => {
  const r=await runCoordinator({raceAtFinal:true});
  assert.equal(r.final,null,'cancelled run checkpoint is removed for the next job');
  assert(!r.events.some(e=>e.ev==='repairProgress'&&e.d.phase==='done'));
});
await check('partial and grouping diagnostics are trace-only; render refusal retains warnings', async () => {
  let code = await readFile(new URL('src/content/overlay/local-render.js',root),'utf8');
  // Mock only the dynamic import boundary, leaving the real classification/logging path intact.
  code = code.replace(/import\(\s*chrome\.runtime\.getURL\("processors\/render\/renderer\.js"\)\s*\)/, 'Promise.resolve(__renderer)');
  let enabled = false;
  const warnings = [], traces = [];
  const report = { aiUnanswered:['p1'], missingLayer:['p1'], aiBlocksOverlapping:0 };
  const TP = { ensureOverlayStyle(){}, log:{ warn:(...a)=>warnings.push(a),debug(){} }, traceNote:(...a)=>{if(enabled) traces.push(a);} };
  vm.runInNewContext(code,{ window:{__TP:TP},Promise,__renderer:{ OVERLAY_CSS:'', renderOverlay:()=>({ root:{},report }) } });
  const data = { lensDocument:doc(), aiPartial:{ missing:['g1'],translated:1 } };
  await TP.overlayLocalRender.build(data,'ai');
  assert.equal(warnings.length,0); assert.equal(traces.length,0);
  enabled = true; await TP.overlayLocalRender.build(data,'ai');
  assert.equal(warnings.length,0); assert.equal(traces.length,1);
  report.aiUnanswered=[]; report.missingLayer=['p-missing'];
  await TP.overlayLocalRender.build(data,'ai');
  assert.equal(warnings.length,0);
  assert.ok(traces.some(a => a[1] === 'groupingDocumentMismatch'));
  report.error='invalid schema';
  await TP.overlayLocalRender.build(data,'ai');
  assert.equal(warnings.length,1);
});
await check('navigation during background preparation never remounts an old result', async () => {
  let epoch = 0, release, started, upserts = 0;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const revoked = [];
  const img = { isConnected:true, naturalWidth:100, naturalHeight:100 };
  const TP = {
    log:{info(){},debug(){},warn(){}},
    findTargetImage:()=>img, isStillCurrent:(_img,g)=>({ok:g.epoch===epoch}),
    normUrl:x=>x, getBestImgUrl:()=> 'fixture-image', isMangaDexHost:()=>false,
    ensureOverlayStyle(){}, overlayStatus:{reason:()=>''},
    overlayLocalRender:{wants:()=>true,build:async()=>({root:{innerHTML:''}})},
    overlayBackground:{wants:()=>true,prepare:async()=>{started();await gate;return {url:'blob:stale'};},apply:async()=>true,update(){}},
    overlayMount:{upsertHtmlOverlay:()=>{upserts++;return {scope:{replaceChildren(){}},host:{isConnected:true}};},scheduleHtmlOverlayUpdate(){},hideHtmlOverlay(){}},
    emitViewerEvent(){},
  };
  const box={window:{__TP:TP},URL:{revokeObjectURL:url=>revoked.push(url)},setTimeout,WeakMap};
  vm.runInNewContext(await readFile(new URL('src/content/overlay.js',root),'utf8'),box);
  vm.runInNewContext(await readFile(new URL('src/content/overlay/message-controller.js',root),'utf8'),box);
  const generation={epoch:0},stamp={runId:'render-run',generationId:'render-generation',phase:'initial',revision:''};
  await TP.applyInsertMessage({type:'TP_TRANSLATION_BIND',original:'fixture-image',generation,translationRun:stamp});
  const rendering=TP.applyInsertMessage({type:'OVERLAY_HTML',original:'fixture-image',mode:'lens_text',source:'ai',generation,translationRun:stamp,result:{}});
  await began;epoch++;release();const ack=await rendering;
  assert.equal(ack.stale,true);assert.equal(ack.applied,false);
  assert.equal(upserts,0,'late background must not recreate a host cleared by navigation');
  assert.deepEqual(revoked,['blob:stale']);
});
console.log(JSON.stringify({ schema:'tp.repair-stability-regression/1', node:process.version, base:root.href, passed:results.filter(r=>r.pass).length, failed:results.filter(r=>!r.pass).length, results },null,2));
process.exitCode = results.some(r=>!r.pass) ? 1 : 0;
