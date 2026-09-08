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
const { ensureBatch } = await from('src/background/batches.js');
const results = [];
async function check(name, work) {
  try { await work(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, pass: false, error: e.message }); console.error(`FAIL ${name}: ${e.message}`); }
}
function doc() { return { schema: 'tp.lens-document/1', image: { width: 100, height: 100 }, languages: { source: 'ja', target: 'th' }, paragraphs: [0,1].map(i => ({ id: `p${i}`, sourceText: `こんにちは ${i}`, items: [] })) }; }
function result() { return { backgroundMode: 'boxes', layout: { relayout_translated: false }, lensDocument: doc(), eraseBoxes: { schema: 'tp.erase-boxes/1', boxes: [0,1].map(i => ({ l: .1, t: .1 + i*.2, w: .3, h: .1, p: `p${i}` })) } }; }
async function page(id = 'page') {
  const d = result();
  return makePageCheckpoint({ payload: { metadata: { image_id: id }, lang: 'th' }, result: d, units: translationUnits(d.lensDocument), plan: { route: 'direct-local', ai: { provider: 'ollama', model: 'fixture', thinking: 'off' } }, ctx: { jobId: `gen:${id}` }, operationId: `op:${id}` });
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
  const calls = [], applications = [];
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
    const pages = new Map(await Promise.all([0,1,2].map(async i => { const p = await page(`p${i}`); return [p.pageId, p]; })));
    await b.api(run, 'register', { manifest: [...pages.keys()] });
    for (const p of pages.values()) await b.api(run, 'pages', { pageId: p.pageId, generationId: p.generationId, groupKey: p.groupKey, status: 'finished', initialAccepted: 0, failed: p.units.map(u => ({ id: u.id, text: u.text, sourceHash: u.sourceHash, reason: 'missing' })) });
    let caught;
    try {
      await executeRepairPool({ run, snapshot: await b.api(run, 'seal', {}), executor: 'w', signal: ctrl.signal, api: b.api,
        getPage: async id => pages.get(id), resolveAi: async p => p.ai, checkpointTask: async task => { if (abortOnDispatch && task.state === 'dispatched') ctrl.abort(); },
        onProgress: () => {}, applyResults: async rows => applications.push({ calls: calls.length, ids: rows.map(r => r.id) }),
        withCapacity, planner: { open: async () => ({ next: rows => ({ units: rows.slice(0,2), estimate: {} }) }) },
        translate: async units => {
          calls.push(units); translateRunning++; maxTranslateRunning = Math.max(maxTranslateRunning, translateRunning);
          try {
            if (abortAfterSecond && calls.length === 2) ctrl.abort();
            if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
            return { translations: units.map(u => ({ id: u.id, text: wrongLanguage ? '日本語のままです' : 'คำแปลไทย' })) };
          } finally { translateRunning--; }
        }
      });
    } catch (error) { caught = error; }
    return { calls, applications, caught, maxTranslateRunning };
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
});
async function runCoordinator({ acknowledge = true, race = false, testProgress = false } = {}) {
  let value = {}, writes = 0, epoch = 7, transientWrites = 0, firstAckSaw = 0;
  const area = { async get(k) { return { [k]: structuredClone(value[k]) }; }, async set(v) { writes++; Object.assign(value, structuredClone(v)); } };
  const sessions = createTranslationSessionStore({ area: () => area });
  const tabId = 77000 + Math.floor(Math.random() * 100000), batch = ensureBatch(crypto.randomUUID(), tabId, 0);
  const ctxs = new Map(), queue = [], rendered = [], events = [];
  const payloads = [0,1,2].map(i => ({ engine:'extension', mode:'lens_text', source:'ai', lang:'th', src:`https://fixture.invalid/${i}`, metadata:{ image_id:`p${i}` } }));
  for (const p of payloads) batch.items.set(p.metadata.image_id, { attempt:1, status:'queued', phase:'waiting', payload:p });
  const api = async (_r, action) => action === 'seal' ? { phase:'repairing', pending:[] } : {};
  const co = createRepairCoordinator({ sessions, api, currentEpoch: () => epoch, currentSession: () => 'session', getBase: async () => 'http://fixture.invalid', getContext: id => ctxs.get(id), getCapabilitiesFor: async () => ({}), emit: (ev,d) => events.push({ ev,d }),
    insert: async (_tab, msg) => {
      if (msg.type !== 'OVERLAY_HTML') return { ok:true, applied:true };
      rendered.push(msg);
      if (race) { epoch = 8; return { ok:true, applied:true }; }
      if (!acknowledge) return { ok:true };
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('repair delivery serialized before the other pages were enqueued')), 120);
        queue.push({ resolve, timer });
        if (queue.length === 3) {
          firstAckSaw = rendered.length;
          for (const entry of queue) { clearTimeout(entry.timer); entry.resolve({ ok:true, applied:true }); }
        }
      });
    },
    execute: async options => {
      const rows = [];
      for (const p of payloads) {
        const saved = await options.getPage(p.metadata.image_id);
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
      await options.applyResults(rows);
      return { phase:'done', repaired:3, failedUnits:3, initialAccepted:3, unresolved:0, unverified:0, results:rows };
    }
  });
  const run = await co.registerBatch(batch,payloads);
  for (const p of payloads) {
    const id = `gen:${p.metadata.image_id}`;
    const ctx = { jobId:id, imageKey:p.metadata.image_id, tabId, frameId:0, imgUrl:p.src, mode:'lens_text', source:'ai', lang:'th', sessionId:'session', settingsEpoch:7, generation:{ pageInstanceId:'instance' } };
    ctxs.set(id,ctx); const r = result();
    await co.capture(batch.id,{ stage:'prepared', payload:p, result:r, plan:{ route:'direct-local', ai:{ provider:'ollama',model:'fixture',thinking:'off' } }, units:translationUnits(r.lensDocument), jobId:id, operationId:`op:${id}` });
    await co.capture(batch.id,{ stage:'finished', payload:p, jobId:id, accepted:[{ id:'g0',text:'ของดีเดิม' }], failures:[{ id:'g1',reason:'missing' }] });
    await co.markDelivered(ctx,true);
  }
  await co.finishInitial(batch); await sessions.flush();
  return { final:await sessions.get(run.id), rendered, firstAckSaw, transientWrites, events };
}
await check('all repaired pages enter the bulk queue before waiting for the first DOM ACK', async () => {
  const r = await runCoordinator();
  assert.equal(r.final.phase, 'done');
  assert.equal(r.firstAckSaw, 3);
  assert.equal(r.rendered.length, 3);
  for (const msg of r.rendered) assert.equal(msg.result.backgroundMode, 'boxes');
});
await check('provider delta telemetry never rewrites the whole session checkpoint', async () => {
  const r = await runCoordinator({ acknowledge:false, testProgress:true });
  assert.equal(r.transientWrites, 0, 'request/validation telemetry must not produce checkpoint writes');
  const validation=r.events.filter(e=>e.d.phase==='repair_validation');assert.equal(validation.length,100);
  assert.equal(validation[0].d.acceptedCount,1);assert.equal(validation[0].d.rejectedCount,2);
  assert.equal(validation[0].d.wrongLanguageCount,2);
  assert.ok(r.final.summary.phase!=='repair_validation','validation must never replace the current UI phase');
});
await check('an ambiguous ACK remains apply_pending instead of deleting the checkpoint', async () => {
  const r = await runCoordinator({ acknowledge:false });
  assert.equal(r.final.phase, 'apply_pending');
  assert.equal(Object.keys(r.final.pages).length, 3);
  for (const p of Object.values(r.final.pages)) assert.ok(p.patchPending);
});
await check('settings change during delivery invalidates the run before terminal cleanup', async () => {
  const r = await runCoordinator({ race:true });
  assert.equal(r.final.phase, 'cancelled');
  assert.deepEqual(r.final.pages, {});
  assert.ok(!r.events.some(e => e.ev === 'repairPatch' && e.d.applied === true));
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
