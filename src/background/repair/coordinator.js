import { translationSessions } from '../translation-session-store.js';
import { repairRequest } from './client.js';
import { makePageCheckpoint, digestText, buildPatchedResult, pageInitialReport } from './page-checkpoint.js';
import { executeRepairPool } from './executor.js';
import { findContext } from '../job-registry.js';
import { getBatch, ensureBatch, batchUpdateToast, batchStopKeepAlive, updateImagePresentation } from '../batches.js';
import { getTabSessionId } from '../tab-sessions.js';
import { getSettingsEpoch, abortBatchInFlight } from '../jobs/lifecycle.js';
import { enqueueDomInsert } from '../insert-queue.js';
import { getStorage } from '../../shared/storage.js';
import { makeProviderIdentity } from '../../shared/ai-profiles.js';
import { getCapabilities } from '../capabilities.js';
import { getApiBase } from '../api.js';
import { acquire, releaseSuccess, releaseFailed, laneKeyFor } from '../scheduler.js';
import { getCachedDataUri, setCachedResult, mdCacheKey, mdKeyFromUrl, stripImageFields } from '../mangadex.js';
import { fetchImageDataUriFromTab } from '../images.js';
import { normImgSrc } from '../job-keys.js';
import { note as traceNote } from '../../shared/trace.js';

const trace = (event, data) => traceNote('background/repair/coordinator.js', event, data);
const publicProgress = value => Object.fromEntries(['phase','repaired','unresolved','failedUnits',
  'initialAccepted','unverified','unavailablePages','unitCount','taskId','code',
  'acceptedCount','rejectedCount','wrongLanguageCount','applyFailedPages',
  'applyPendingPages','appliedRepairedUnits','unappliedRepairedUnits'].filter(k => value[k] !== undefined).map(k => [k,value[k]]));
const makeToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2,'0')).join('');

export function createRepairCoordinator({
  sessions = translationSessions, api = repairRequest, execute = executeRepairPool,
  now = Date.now, getBase = getApiBase, getContext = findContext,
  currentEpoch = getSettingsEpoch, currentSession = getTabSessionId,
  getCapabilitiesFor = getCapabilities, insert = enqueueDomInsert,
  readSettings = getStorage, emit = trace,
} = {}) {
  const batchRuns = new Map(), runtimePages = new Map(), operations = new Map(), controllers = new Map();
  const cancelledRuns = new Set();
  let executor;
  const workerId = () => executor ||= crypto.randomUUID();
  function live(run) {
    return !cancelledRuns.has(run.id) && run.phase !== 'cancelled' && !getBatch(run.batchId)?.cancelled &&
      run.settingsEpoch === currentEpoch() && currentSession(run.tabId) === run.sessionId;
  }
  function presentPage(run, page, repairPhase = run.phase) {
    if(!page) return;
    const ids=new Set(page.units.filter(u=>u.translatable).map(u=>u.id));
    const acceptedIds=new Set(page.accepted.filter(u=>ids.has(u.id)).map(u=>u.id));
    const accepted=acceptedIds.size;
    const remaining=page.failures.filter(f=>ids.has(f.id)&&!acceptedIds.has(f.id));
    updateImagePresentation(run.batchId,page.pageId,{total:ids.size,accepted,
      applied:page.delivered?accepted:0,pending:Math.max(0,ids.size-accepted),repairPhase,
      wrongLanguageCount:remaining.filter(f=>f.reason==='wrong_target_script').length,
      structuralCount:remaining.filter(f=>['missing','omitted','malformed','empty','duplicate'].includes(f.reason)).length});
  }
  function progress(run, data) {
    // Stream telemetry is not a durable state transition. Task receipts below
    // already checkpoint each answer; do not serialize every token to storage.
    if (data.phase === 'repair_request' || data.phase === 'repair_validation') {
      emit('repairProgress', { runId:run.id, batchId:run.batchId,
        ...publicProgress(data), event:data.event });
      return;
    }
    for(const page of Object.values(run.pages || {})) presentPage(run,page,data.phase);
    const b = getBatch(run.batchId);
    const summary = publicProgress(data);
    if (b) {
      b.repair = summary;
      const label = data.phase === 'done'
        ? `Repair: ${data.repaired || 0}/${data.failedUnits || 0} fixed; ${data.unresolved || 0} unresolved${data.unverified ? `; ${data.unverified} interrupted` : ''}${data.unavailablePages ? `; ${data.unavailablePages} image(s) lack source` : ''}`
        : data.phase === 'apply_failed'
          ? `Repair finished: ${data.appliedRepairedUnits || 0}/${data.failedUnits || 0} fixed and placed; ${data.unresolved || 0} unresolved; ${data.applyFailedPages || 0} image(s) could not be placed safely (saved results)`
        : data.phase === 'unavailable' ? `Repair unavailable: ${data.code || 'API/session error'}`
        : data.phase === 'applying' ? 'Placing repair results'
        : data.phase === 'apply_pending' ? `Repair finished; waiting to place saved results${data.applyFailedPages ? `; ${data.applyFailedPages} image(s) could not be placed safely` : ''}`
        : data.phase === 'blocked' ? `Repair paused: ${data.code || 'connection interrupted'}`
        : data.phase === 'repairing' ? `Repairing ${data.failedUnits || 0} unit(s); ${data.repaired || 0} fixed`
        : 'Collecting repair candidates';
      b.repair.label = label;
      batchUpdateToast(b, label, true);
    }
    void sessions.update(run.id, current => {
      if (!current || current.phase === 'cancelled') return current;
      current.summary = {...current.summary, ...summary};
      current.events = [...(current.events || []), {at:now(), ...summary}].slice(-96);
      return current;
    }).catch(() => {});
    // Keep placement counters together so the compact trace field limit does
    // not drop the distinction between translated answers and delivered ones.
    const {applyFailedPages, applyPendingPages, appliedRepairedUnits, unappliedRepairedUnits, ...eventSummary} = summary;
    const placement = Object.fromEntries(Object.entries({applyFailedPages, applyPendingPages,
      appliedRepairedUnits, unappliedRepairedUnits}).filter(([,v]) => v !== undefined));
    emit('repairProgress', { runId: run.id, batchId: run.batchId, ...eventSummary,
      ...(Object.keys(placement).length ? {placement} : {}) });
  }
  async function registerBatch(batch, payloads) {
    if (!payloads.length || payloads.some(p => p.engine === 'api' || p.mode !== 'lens_text' || p.source !== 'ai')) return null;
    const old = batchRuns.get(batch.id);
    if (old) return sessions.get(old);
    const run = { id: crypto.randomUUID(), token: makeToken(), createdAt: now(), phase: 'collecting',
      batchId: batch.id, tabId: batch.tabId, frameId: batch.frameId || 0,
      sessionId: currentSession(batch.tabId), settingsEpoch: currentEpoch(),
      base: await getBase(), manifest: [...batch.items.keys()], targets:payloads.map(p => normImgSrc(p.src)),
      ownerWorker:workerId(), pages: {}, tasks: {}, summary: {} };
    try {
      for (const prior of await sessions.list()) {
        if (prior.tabId === run.tabId && prior.frameId === run.frameId &&
            !['done','apply_failed','cancelled','unavailable'].includes(prior.phase) &&
            (prior.targets || []).some(x => run.targets.includes(x))) {
          batchRuns.set(prior.batchId, prior.id);
          await cancelBatch(prior.batchId, 'superseded_translation');
        }
      }
      await sessions.update(run.id, () => run);
      batchRuns.set(batch.id, run.id);
      await api(run, 'register', { runId: run.id, manifest: run.manifest });
      if (!live(run)) { await cancelBatch(batch.id, 'cancelled_during_registration'); return null; }
      progress(run, { phase: 'collecting' });
      return run;
    } catch (error) {
      emit('repairRegistrationFailed', { batchId: batch.id, code: error.code || 'repair_api_unavailable' });
      progress(run, { phase: 'unavailable', code: error.code || 'repair_api_unavailable' });
      try { await sessions.update(run.id, old => old && ({...old, phase:'unavailable'})); } catch {}
      // Initial translation stays available, but never pretend repair is active.
      return null;
    }
  }
  async function capture(batchId, data) {
    const runId = batchRuns.get(batchId);
    if (!runId || cancelledRuns.has(runId)) return;
    const run = await sessions.get(runId);
    if (!run || !live(run) || run.phase === 'unavailable') return;
    const pageId = String(data.payload?.metadata?.image_id || data.imageId || getContext(data.jobId)?.imageKey || '');
    let captured;
    if (data.stage === 'prepared') {
      const ctx = getContext(data.jobId, pageId) || {};
      ctx.translationRun = { runId, pageId, generationId: data.jobId, phase: 'initial', revision: '' };
      const page = await makePageCheckpoint({ ...data, ctx: { ...ctx, jobId: data.jobId } });
      await insert(ctx.tabId, {type:'TP_TRANSLATION_BIND', original:ctx.imgUrl, generation:ctx.generation,
        translationRun:ctx.translationRun}, ctx.frameId || 0);
      runtimePages.set(`${runId}:${pageId}`, { ai: data.plan.ai,
        sourceImageDataUri: data.result.sourceImageDataUri || data.payload.imageDataUri || '' });
      captured = await sessions.update(runId, current => {
        if (!current || current.phase !== 'collecting') return current;
        current.pages[pageId] = page; return current;
      });
    } else {
      captured = await sessions.update(runId, current => {
        const page = current?.pages?.[pageId];
        if (!page || current.phase !== 'collecting') return current;
        if (data.stage === 'dispatch') {
          page.phase = 'translating';
          page.inFlight = (data.ids || []).map(String);
          page.currentOperation = data.operationId;
        } else if (data.stage === 'progress' || data.stage === 'finished') {
          const accepted = new Map(page.accepted.map(u => [u.id, u]));
          for (const row of data.accepted || []) if (!accepted.has(row.id)) accepted.set(row.id, { id: row.id, text: row.text });
          page.accepted = [...accepted.values()];
          const failures = new Map(page.failures.map(x => [x.id, x]));
          for (const item of data.failures || []) if (!accepted.has(item.id)) {
            if (!failures.has(item.id) || item.reason !== 'missing') failures.set(item.id, item);
          }
          for (const id of accepted.keys()) failures.delete(id);
          page.failures = [...failures.values()];
          page.blocked = [...new Set([...page.blocked, ...(data.blocked || [])])];
          page.inFlight = [];
          if (data.stage === 'finished') page.phase = 'finished';
        }
        return current;
      });
    }
    if (captured) presentPage(captured,captured.pages?.[pageId]);
  }
  async function safeCapture(batchId, data) {
    try { await capture(batchId, data); }
    catch (error) {
      const id = batchRuns.get(batchId);
      const run = id && await sessions.get(id).catch(() => null);
      if (run) {
        progress(run, { phase: 'unavailable', code: error.code || 'checkpoint_failed' });
        await sessions.update(id, old => old && ({ ...old, phase: 'unavailable' })).catch(() => {});
      }
      emit('repairCheckpointFailed', { batchId, code: error.code || 'checkpoint_failed' });
    }
  }
  async function markDelivered(ctx, applied) {
    const id = ctx?.translationRun?.runId;
    if (!id || cancelledRuns.has(id)) return;
    const updated = await sessions.update(id, run => {
      const page = run?.pages?.[ctx.translationRun.pageId];
      if (page) page.delivered = applied === true;
      return run;
    }).catch(error => emit('repairDeliveryCheckpointFailed', { code: error.code || 'checkpoint_failed' }));
    if (updated) presentPage(updated,updated.pages?.[ctx.translationRun.pageId]);
  }
  async function credentials(page, run) {
    const runtime = runtimePages.get(`${run.id}:${page.pageId}`);
    const ai = { ...page.ai };
    if (runtime?.ai) ai.api_key = runtime.ai.api_key || '';
    else {
      const stored = await readSettings('aiProfileCredentialsV1');
      const identity = makeProviderIdentity(ai.provider, ai.base_url || '');
      ai.api_key = stored?.aiProfileCredentialsV1?.[identity] || '';
    }
    if (ai.send_image) {
      const image = runtime?.sourceImageDataUri || getCachedDataUri(normImgSrc(page.ctx.imgUrl)) ||
        await fetchImageDataUriFromTab(page.ctx.tabId, page.ctx.imgUrl, page.ctx.frameId || 0);
      if (!image) throw Object.assign(new Error('Repair image context unavailable; no text-only fallback was used'), {code:'repair_image_unavailable'});
      ai._repairImageDataUri = image;
    }
    return ai;
  }
  async function applyResults(run, rows) {
    const current = await sessions.get(run.id);
    if (!current || !live(current)) return;
    const byPage = new Map();
    for (const row of rows || []) {
      if (!byPage.has(row.pageId)) byPage.set(row.pageId, []);
      byPage.get(row.pageId).push(row);
    }
    for (const page of Object.values(current.pages)) {
      if (!page.delivered && page.accepted.length && !byPage.has(page.pageId)) byPage.set(page.pageId, []);
    }
    const preparedPages = await Promise.all([...byPage].map(async ([pageId, repaired]) => {
      const page = current.pages[pageId];
      if (!page) return null;
      const candidates = repaired.filter(x => !page.repaired.includes(x.id));
      let patch;
      try {
        patch = buildPatchedResult(page, candidates);
      } catch (error) {
        // A deterministic unsafe erase map is isolated to this image. Never
        // guess ownership, erase its missing text, or block other saved answers.
        if (error?.code !== 'repair_erase_conflict') throw error;
        return {pageId, page, patchError: {code:error.code, reason:error.message}};
      }
      const oldIds = new Set(page.accepted.map(x => x.id));
      const newIds = new Set(patch.accepted.filter(x => !oldIds.has(x.id)).map(x => x.id));
      const wanted = candidates.filter(x => newIds.delete(x.unitId || x.id));
      if (!wanted.length && page.delivered) return null;
      const revision = await digestText(JSON.stringify(patch.accepted));
      const runtime = runtimePages.get(`${run.id}:${pageId}`);
      const image = runtime?.sourceImageDataUri || getCachedDataUri(normImgSrc(page.ctx.imgUrl));
      if (image) patch.result.sourceImageDataUri = image;
      return {pageId, page, patch, revision, image, wanted};
    }));
    const entries = preparedPages.filter(Boolean);
    const plans = entries.filter(p => !p.patchError);
    if (!entries.length || !live(current)) return;
    // Persist intents AND terminal per-image refusals. A failed plan never
    // deletes another image's intent/ACK, and no provider request is retried.
    const prepared = await sessions.update(run.id, value => {
      if (!value || !live(value)) return value;
      for (const entry of entries) {
        const target = value.pages[entry.pageId];
        if (target?.generationId !== entry.page.generationId) continue;
        if (entry.patchError) {
          target.patchError = entry.patchError;
          target.patchPending = '';
        } else {
          delete target.patchError;
          target.patchPending = entry.revision;
        }
      }
      return value;
    });
    if (!prepared || !live(prepared)) return;
    for (const entry of entries.filter(p => p.patchError)) {
      emit('repairPatch', {runId:run.id, pageId:entry.pageId, applied:false,
        stage:'render', code:entry.patchError.code, reason:entry.patchError.reason,
        fixedUnits:0, terminal:true});
    }
    // Enqueue every page before awaiting the first ACK, allowing the existing
    // bounded tab/frame insertion queue to coalesce the final repair pass.
    const deliveries = await Promise.all(plans.map(async plan => {
      const {pageId, page, patch, revision} = plan;
      if (!live(prepared) || prepared.pages[pageId]?.patchPending !== revision) return {...plan, applied:false};
      let receipt, errorCode;
      try {
        receipt = await insert(page.ctx.tabId, { type:'OVERLAY_HTML', original:page.ctx.imgUrl,
          mode:page.ctx.mode || 'lens_text', source:page.ctx.source || 'ai', result:patch.result,
          generation:page.ctx.generation, tpTrace:page.ctx.traceId,
          translationRun:{runId:run.id, pageId, generationId:page.generationId, phase:'repair', revision}
        }, page.ctx.frameId || 0);
      } catch (error) { errorCode = error.code || 'repair_delivery_unconfirmed'; }
      const applied = live(prepared) && receipt?.ok === true && receipt.applied === true &&
        !receipt.stale && !receipt.notFound && !receipt.pending && !receipt.expired;
      return {...plan, applied, receipt, errorCode};
    }));
    const committed = new Set();
    await sessions.update(run.id, value => {
      if (!value || !live(value)) return value;
      for (const plan of deliveries) {
        const target = value.pages[plan.pageId];
        if (!plan.applied || target?.generationId !== plan.page.generationId || target.patchPending !== plan.revision) continue;
        target.accepted = plan.patch.accepted;
        target.repaired = [...new Set([...target.repaired, ...plan.wanted.map(x => x.id)])];
        target.patchPending = ''; target.delivered = true;
        committed.add(plan.pageId);
      }
      return value;
    });
    for (const plan of deliveries) {
      const applied = committed.has(plan.pageId) && live(prepared);
      if (applied) {
        const key = mdCacheKey(mdKeyFromUrl(plan.page.ctx.imgUrl), plan.page.targetLang, plan.page.ctx.mode, plan.page.ctx.source);
        if (key) setCachedResult(key, {newImg:null, result:stripImageFields(plan.patch.result),
          sourceImageKey:plan.image ? normImgSrc(plan.page.ctx.imgUrl) : ''});
      }
      emit('repairPatch', {runId:run.id, pageId:plan.pageId, applied, stale:!!plan.receipt?.stale || !live(prepared),
        fixedUnits:applied ? plan.wanted.length : 0, readyUnits:plan.wanted.length, remaining:plan.patch.missing.length, code:plan.errorCode});
    }
  }
  async function runRepair(run) {
    if (!live(run)) { await cancelBatch(run.batchId, 'stale_generation'); return null; }
    const ctrl = new AbortController(); controllers.set(run.id, ctrl);
    try {
      // Registration is idempotent, including after an ambiguous HTTP timeout.
      await api(run, 'register', { runId:run.id, manifest:run.manifest }, {signal:ctrl.signal});
      if (run.phase === 'collecting') {
        for (const pageId of run.manifest) {
          const page = run.pages[pageId];
          const report = page ? pageInitialReport(page) : {
            pageId, generationId:run.id, groupKey:'', status:'no_source', failed:[], initialAccepted:0, unverified:0,
          };
          await api(run, 'pages', report, {signal:ctrl.signal});
        }
      }
      let snapshot = await api(run, 'seal', {}, {signal:ctrl.signal});
      await sessions.update(run.id, value => value && ({ ...value, phase:'repairing' }));
      const capabilities = await getCapabilitiesFor(run.base);
      snapshot = await execute({ run, snapshot, executor:workerId(), signal:ctrl.signal, capabilities,
        getPage: async pageId => (await sessions.get(run.id))?.pages?.[pageId],
        readTask: async taskId => (await sessions.get(run.id))?.tasks?.[taskId],
        resolveAi: page => credentials(page, run), api,
        checkpointTask: task => sessions.update(run.id, value => {
          if (value && value.phase !== 'cancelled') value.tasks[task.id] = { ...(value.tasks[task.id] || {}), ...task };
          return value;
        }),
        onProgress: data => progress(run, data),
        applyResults: rows => applyResults(run, rows),
        withCapacity: async (page, ai, signal, work) => {
          if (!live(run)) throw new DOMException('Stale repair','AbortError');
          const payload = { mode:'lens_text', source:'ai', ai, rate:page.rate, engine:'extension' };
          const lane = laneKeyFor(payload); const start = Date.now();
          await acquire(lane, signal);
          try {
            const answer = await work();
            releaseSuccess(lane, Math.max(1, Number(answer?.meta?.providerMs) || Date.now() - start));
            return answer;
          } catch (error) { releaseFailed(lane); throw error; }
        },
      });
      if (!live(run)) { await cancelBatch(run.batchId, 'stale_after_repair'); return null; }
      if (snapshot.phase !== 'done') throw Object.assign(new Error('Repair pool is not terminal'), {code:'repair_tasks_pending'});
      const summary = publicProgress(snapshot);
      const value = await sessions.update(run.id, current => {
        if (!current || current.phase === 'cancelled') return current;
        const pages = Object.values(current.pages);
        const applyPendingPages = pages.filter(p => p.patchPending).length;
        const applyFailedPages = pages.filter(p => p.patchError).length;
        const appliedRepairedUnits = pages.reduce((n,p) => n + p.repaired.length, 0);
        const finalSummary = {...summary, applyPendingPages, applyFailedPages,
          appliedRepairedUnits,
          unappliedRepairedUnits: Math.max(0, (summary.repaired || 0) - appliedRepairedUnits)};
        const retain = applyPendingPages || applyFailedPages;
        return { ...current,
          phase:applyPendingPages ? 'apply_pending' : applyFailedPages ? 'apply_failed' : 'done',
          summary:finalSummary,
          // Keep unconfirmed/unsafe saved answers until session TTL. apply_failed
          // is terminal, not a blocked network job to retry on worker wake-up.
          pages:retain ? current.pages : {}, tasks:retain ? current.tasks : {} };
      });
      progress(value || run, {...(value?.summary || summary), phase:value?.phase || summary.phase});
      if (['done','apply_failed'].includes(value?.phase)) {
        for (const key of runtimePages.keys()) if (key.startsWith(`${run.id}:`)) runtimePages.delete(key);
      }
      if (value?.phase === 'done') {
        // Release server-side dialogue only after confirmed delivery.
        await api(run, '', undefined, { method:'DELETE' }).catch(() => {});
      }
      return value?.summary || summary;
    } catch (error) {
      if (ctrl.signal.aborted || cancelledRuns.has(run.id)) return null;
      await sessions.update(run.id, value => value && ({ ...value, phase:'blocked',
        resumePhase:value.phase, lastError:error.code || error.message })).catch(() => {});
      progress(run, {phase:'blocked', code:error.code || 'repair_connection_failed'});
      return null;
    } finally {
      controllers.delete(run.id);
      const b = getBatch(run.batchId); if (b) await batchStopKeepAlive(b);
    }
  }
  async function finishInitial(batch) {
    const id = batchRuns.get(batch.id);
    if (!id) return false;
    const existing = await sessions.get(id).catch(() => null);
    if (!existing || existing.phase === 'unavailable') return false;
    if (operations.has(id)) { await operations.get(id); return true; }
    const work = (async () => {
      let run = await sessions.get(id);
      if (!run || ['done','apply_failed','cancelled','unavailable'].includes(run.phase)) return;
      // An interrupted generation cannot be repaired blindly: save unknown IDs
      // separately and only pool failures whose response was actually observed.
      if (run.phase === 'collecting') {
        run = await sessions.update(id, current => {
          for (const page of Object.values(current.pages)) {
            if (page.phase !== 'finished') {
              const known = new Set([...page.accepted.map(x=>x.id), ...page.failures.map(x=>x.id), ...page.blocked]);
              const unknown = new Set(page.inFlight);
              for (const unit of page.units.filter(u => u.translatable && !known.has(u.id))) {
                if (unknown.has(unit.id)) page.blocked.push(unit.id);
                else page.failures.push({id:unit.id, reason:'not_sent'});
              }
              page.blocked = [...new Set(page.blocked)];
              page.phase = page.blocked.length ? 'interrupted' : 'finished'; page.inFlight = [];
            }
          }
          return current;
        });
      }
      return runRepair(run);
    })();
    operations.set(id, work);
    try { await work; } finally { operations.delete(id); }
    return true;
  }
  async function cancelBatch(batchId, reason = 'cancelled') {
    const id = batchRuns.get(batchId); if (!id) return;
    cancelledRuns.add(id); controllers.get(id)?.abort();
    const batch = getBatch(batchId);
    if (batch) { batch.cancelled = true; batch.cancelRequestedAt = now(); }
    abortBatchInFlight(batchId, 'repair_run_cancelled');
    const run = await sessions.get(id).catch(() => null);
    if (!run) return;
    await sessions.update(id, value => value && ({...value, phase:'cancelled', pages:{}, tasks:{}, reason})).catch(() => {});
    for (const key of runtimePages.keys()) if (key.startsWith(`${id}:`)) runtimePages.delete(key);
    await api(run, 'cancel', {}).catch(() => {});
    emit('repairCancelled', {runId:id, batchId, reason});
  }
  async function resume() {
    const rows = await sessions.list().catch(() => []);
    for (let run of rows) {
      batchRuns.set(run.batchId, run.id);
      if (['done','apply_failed','cancelled','unavailable'].includes(run.phase)) continue;
      if (run.phase === 'collecting' && run.ownerWorker === workerId()) continue;
      if (!live(run)) { await cancelBatch(run.batchId, 'stale_after_worker_restart'); continue; }
      if (run.phase === 'blocked') {
        run = await sessions.update(run.id, old => ({ ...old, phase:old.resumePhase || 'repairing' }));
      }
      const b = getBatch(run.batchId) || ensureBatch(run.batchId, run.tabId, run.frameId);
      void finishInitial(b).catch(error => emit('repairResumeFailed', {runId:run.id, code:error.code || 'repair_resume_failed'})); // receipt recovery, never blind resend
    }
  }
  async function cancelTab(tabId, reason) {
    for (const run of await sessions.list().catch(() => []))
      if (run.tabId === tabId && !['done','cancelled'].includes(run.phase)) await cancelBatch(run.batchId, reason);
  }
  async function cancelSettings() {
    for (const run of await sessions.list().catch(() => []))
      if (!['done','cancelled'].includes(run.phase) && run.settingsEpoch !== currentEpoch()) await cancelBatch(run.batchId,'settings_changed');
  }
  return { registerBatch, capture:safeCapture, markDelivered, finishInitial, cancelBatch, cancelTab, cancelSettings, resume,
    async summaries() { return (await sessions.list().catch(() => [])).map(r => ({...r.summary, batchId:r.batchId, phase:r.phase})); } };
}
export const repairCoordinator = createRepairCoordinator();
