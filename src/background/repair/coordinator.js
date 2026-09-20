import { captureSourceEvidence, sourceEvidenceForDispatch, applySourceEvidence } from "./source-evidence.js";
import { translationSessions } from '../translation-session-store.js';
import { conversationDispatchJournal } from './dispatch-journal.js';
import { conversationPreparedPages } from './prepared-page-journal.js';
import { repairRequest } from './client.js';
import { makePageCheckpoint, digestText, buildPatchedResult, pageInitialReport } from './page-checkpoint.js';
import { executeRepairPool, repairUsageDiagnostic } from './executor.js';
import { findContext } from '../job-registry.js';
import { getBatch, ensureBatch, batchMark, batchUpdateToast, batchStopKeepAlive, updateImagePresentation } from '../batches.js';
import { getTabSessionId } from '../tab-sessions.js';
import { getSettingsEpoch, abortBatchInFlight } from '../jobs/lifecycle.js';
import { cancelBatchProviderViaRest } from '../jobs/cancellation.js';
import { enqueueDomInsert } from '../insert-queue.js';
import { getStorage } from '../../shared/storage.js';
import { makeProviderIdentity } from '../../shared/ai-profiles.js';
import { getCapabilities } from '../capabilities.js';
import { getApiBase } from '../api.js';
import { acquire, releaseSuccess, releaseReplay, releaseFailed, laneKeyFor } from '../scheduler.js';
import { getCachedDataUri, setCachedResult, mdCacheKey, mdKeyFromUrl, stripImageFields } from '../mangadex.js';
import { fetchImageDataUriFromTab } from '../images.js';
import { normImgSrc } from '../job-keys.js';
import { note as traceNote } from '../../shared/trace.js';

const trace = (event, data) => traceNote('background/repair/coordinator.js', event, data);
const publicProgress = value => Object.fromEntries(['phase','repaired','unresolved','failedUnits',
  'initialAccepted','unverified','unavailablePages','unitCount','taskId','code',
  'acceptedCount','rejectedCount','wrongLanguageCount','alignmentUncertainCount','applyFailedPages',
  'applyPendingPages','appliedRepairedUnits','unappliedRepairedUnits'].filter(k => value[k] !== undefined).map(k => [k,value[k]]));
const makeToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2,'0')).join('');

export function createRepairCoordinator({
  sessions = translationSessions, api = repairRequest, execute = executeRepairPool,
  now = Date.now, getBase = getApiBase, getContext = findContext,
  currentEpoch = getSettingsEpoch, currentSession = getTabSessionId,
  getCapabilitiesFor = getCapabilities, insert = enqueueDomInsert,
  readSettings = getStorage, emit = trace, dispatchJournal = conversationDispatchJournal,
  preparedPages = conversationPreparedPages,
} = {}) {
  const batchRuns = new Map(), runtimePages = new Map(), operations = new Map(), controllers = new Map();
  const cancelledRuns = new Set();
  let executor;
  const workerId = () => executor ||= crypto.randomUUID();
  function live(run) {
    return !cancelledRuns.has(run.id) && run.phase !== 'cancelled' && !getBatch(run.batchId)?.cancelled &&
      run.settingsEpoch === currentEpoch() && currentSession(run.tabId) === run.sessionId;
  }
  function presentPage(run, page, repairPhase = run.phase, extra = {}) {
    if(!page) return;
    const ids=new Set(page.units.filter(u=>u.translatable).map(u=>u.id));
    const acceptedIds=new Set(page.accepted.filter(u=>ids.has(u.id)).map(u=>u.id));
    const accepted=acceptedIds.size;
    const remaining=page.failures.filter(f=>ids.has(f.id)&&!acceptedIds.has(f.id));
    // A healthy image does not re-enter the repair UI with its siblings.
    const healthy = accepted === ids.size && !(page.repaired || []).length;
    if (healthy && (['collecting','repairing','repair_request','repair_validation','repair_wave','applying','apply_pending'].includes(repairPhase) ||
        (repairPhase === 'done' && page.delivered))) return;
    updateImagePresentation(run.batchId,page.pageId,{total:ids.size,accepted,
      applied:page.delivered?accepted:0,pending:Math.max(0,ids.size-accepted),repairPhase,...extra,
      wrongLanguageCount:remaining.filter(f=>['wrong_language','wrong_target_script'].includes(f.reason)).length,
      structuralCount:remaining.filter(f=>['missing','omitted','malformed','empty','duplicate'].includes(f.reason)).length});
  }
  function ownsInitialFailure(batchId, pageId) {
    const runId = batchRuns.get(String(batchId || ''));
    if (!runId || cancelledRuns.has(runId)) return false;
    const batch = getBatch(batchId);
    const item = batch?.items?.get(String(pageId || ''));
    const phase = String(batch?.repair?.phase || '');
    return item?.presentation?.repairPhase === 'collecting' &&
      !['unavailable','done','apply_failed','cancelled'].includes(phase);
  }
  async function settleDeferredImageErrors(run, pages, phase) {
    if (!['done','apply_failed','unavailable'].includes(phase)) return;
    const batch = getBatch(run.batchId);
    if (!batch) return;
    for (const page of pages || []) {
      const item = batch.items?.get?.(String(page?.pageId || ''));
      const message = item?.deferredImageError;
      if (!message || typeof message !== 'object') continue;
      if (page?.delivered === true) {
        batchMark(run.batchId, page.pageId, { deferredImageError:null });
        continue;
      }
      try {
        await insert(page.ctx.tabId, message, page.ctx.frameId || 0);
        batchMark(run.batchId, page.pageId, { deferredImageError:null });
        emit('repairTerminalImageError', {runId:run.id, batchId:run.batchId,
          pageId:page.pageId, phase, delivered:true});
      } catch (error) {
        emit('repairTerminalImageError', {runId:run.id, batchId:run.batchId,
          pageId:page.pageId, phase, delivered:false, code:error.code || 'delivery_failed'});
      }
    }
  }
  function diagnosticProgress(run, data) {
    const validation = data.phase === 'repair_validation';
    const unresolved = validation ? Number(data.rejectedCount || 0)
      : Number(data.unresolved || 0) + Number(data.unavailablePages || 0) + Number(data.unverified || 0);
    const successful = validation ? Number(data.acceptedCount || 0)
      : Number(data.repaired || 0) + Number(data.initialAccepted || 0);
    const outcome = ['blocked','unavailable','apply_failed'].includes(data.phase) ? 'failed'
      : unresolved ? (successful ? 'partial' : 'failed')
      : data.phase === 'done' || validation ? 'succeeded' : 'progress';
    const summary = publicProgress(data);
    const placement = Object.fromEntries(['applyFailedPages','applyPendingPages',
      'appliedRepairedUnits','unappliedRepairedUnits'].filter(k => summary[k] !== undefined).map(k => [k,summary[k]]));
    const counts = Object.fromEntries(Object.entries(summary)
      .filter(([key,value]) => typeof value === 'number' && !Object.hasOwn(placement,key)));
    // Keep counters grouped so compact trace enrichment cannot hide unresolved
    // language failures or images that never produced a source checkpoint.
    return { owner:validation ? 'model' : 'extension', outcome,
      severity:outcome === 'failed' || outcome === 'partial' ? 'warning' : 'info',
      runId:run.id, batchId:run.batchId, phase:data.phase, counts,
      ...(data.taskId ? {taskId:data.taskId} : {}),
      ...(data.code ? {code:data.code} : {}),
      ...(Object.keys(placement).length ? {placement} : {}) };
  }
  function progress(run, data) {
    // Stream telemetry is not a durable state transition. Task receipts below
    // already checkpoint each answer; do not serialize every token to storage.
    if (data.phase === 'repair_request' || data.phase === 'repair_validation') {
      if (data.diagnostic) emit('repairDiagnostic', {runId:run.id, batchId:run.batchId, taskId:data.taskId, ...data.diagnostic});
      // These are live request/validation phases, not durable state transitions.
      // Project them into the per-image status UI without adding storage writes.
      for (const page of Object.values(run.pages || {})) presentPage(run, page, data.phase, {repairEvent:data.event || ""});
      emit('repairProgress', data.phase === 'repair_validation'
        ? diagnosticProgress(run, data)
        : { runId:run.id, batchId:run.batchId, ...publicProgress(data), event:data.event,
          ...repairUsageDiagnostic(data) });
      return;
    }
    for(const page of Object.values(run.pages || {})) presentPage(run,page,data.phase);
    const b = getBatch(run.batchId);
    const summary = publicProgress(data);
    if (b) {
      b.repair = summary;
      const label = data.phase === 'done'
        ? `Repair: ${data.repaired || 0}/${data.failedUnits || 0} fixed; ${data.unresolved || 0} unresolved${data.wrongLanguageCount ? `; ${data.wrongLanguageCount} wrong target language` : ''}${data.alignmentUncertainCount ? `; ${data.alignmentUncertainCount} alignment uncertain` : ''}${data.unverified ? `; ${data.unverified} interrupted` : ''}${data.unavailablePages ? `; ${data.unavailablePages} image(s) lack source` : ''}`
        : data.phase === 'apply_failed'
          ? `Repair complete: ${data.appliedRepairedUnits || 0}/${data.failedUnits || 0} fixed and placed; ${data.unresolved || 0} unresolved; ${data.applyFailedPages || 0} image(s) could not be placed safely (saved results)`
        : data.phase === 'unavailable' ? `Repair unavailable: ${data.code || 'API/session error'}`
        : data.phase === 'applying' ? 'Placing repair results'
        : data.phase === 'apply_pending' ? `Repair complete; waiting to place saved results${data.applyFailedPages ? `; ${data.applyFailedPages} image(s) could not be placed safely` : ''}`
        : data.phase === 'blocked' ? `Repair paused: ${data.code || 'connection interrupted'}`
        : data.phase === 'repairing' ? `Repairing ${data.failedUnits || 0} unit(s); ${data.repaired || 0} fixed`
        : 'Collecting repair candidates';
      b.repair.label = label;
      batchUpdateToast(b, label, true);
    }
    // 'collecting' is already durable in the registered run and the batch UI
    // above is live. Persisting a duplicate summary here used to leave a queued
    // run write that the first prepared page had to wait for before AI.
    if (data.phase !== 'collecting') void sessions.update(run.id, current => {
      if (!current || current.phase === 'cancelled') return current;
      current.summary = {...current.summary, ...summary};
      current.events = [...(current.events || []), {at:now(), ...summary}].slice(-96);
      return current;
    }).catch(() => {});
    emit('repairProgress', diagnosticProgress(run, data));
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
    const pageId = String(data.payload?.metadata?.image_id || data.imageId || getContext(data.jobId)?.imageKey || '');
    let captured;
    if (data.stage === 'prepared') {
      const run = await sessions.get(runId);
      if (!run || !live(run) || run.phase === 'unavailable') return;
      const ctx = getContext(data.jobId, pageId) || {};
      ctx.translationRun = { runId, pageId, generationId: data.jobId, phase: 'initial', revision: '' };
      const page = await makePageCheckpoint({ ...data, ctx: { ...ctx, jobId: data.jobId } });
      await insert(ctx.tabId, {type:'TP_TRANSLATION_BIND', original:ctx.imgUrl, generation:ctx.generation,
        translationRun:ctx.translationRun}, ctx.frameId || 0);
      runtimePages.set(`${runId}:${pageId}`, { ai: data.plan.ai,
        sourceImageDataUri: data.result.sourceImageDataUri || data.payload.imageDataUri || '' });
      if (data.plan?.ai?.translation_mode === 'conversation') {
        // Conversation keeps the immutable source checkpoint under a page key.
        // Writing the growing run object here made prepared checkpoint latency
        // increase with every page in a chapter. The repair barrier folds these
        // page rows into the canonical run once initial translation is complete.
        await preparedPages.record(runId, pageId, page);
        captured = {...run,pages:{...(run.pages || {}),[pageId]:page}};
      } else {
        captured = await sessions.update(runId, current => {
          if (!current || !live(current) || current.phase !== 'collecting') return current;
          current.pages[pageId] = page; return current;
        });
      }
    } else {
      const conversation = data.plan?.ai?.translation_mode === 'conversation';
      if (conversation && data.stage === 'dispatch') {
        // The prepared page checkpoint already owns the full source/result.
        // Persist only the small dispatch receipt before provider I/O so a large
        // chapter does not rewrite the entire run on the critical path.
        const current = await sessions.get(runId);
        const page = current?.pages?.[pageId] || await preparedPages.get(runId, pageId);
        if (!page || !live(current) || current.phase !== 'collecting') return;
        const evidence = sourceEvidenceForDispatch(page, data);
        if (evidence) await dispatchJournal.record(runId, pageId, evidence);
        captured = current.pages?.[pageId] ? current : {...current,pages:{...(current.pages || {}),[pageId]:page}};
      } else if (conversation && (data.stage === 'progress' || data.stage === 'finished')) {
        // Keep the post-provider durability barrier, but write only the small
        // per-page result delta. Rewriting the full run here made every
        // Conversation turn pay hundreds of milliseconds of session-storage
        // latency before the next provider request. finishInitial folds these
        // receipts into the full checkpoint before repair sealing/recovery.
        const current = await sessions.get(runId);
        const page = current?.pages?.[pageId] || await preparedPages.get(runId, pageId);
        if (!page || !live(current) || current.phase !== 'collecting') return;
        const receipt = await dispatchJournal.checkpointResult(runId, pageId, {
          stage:data.stage, accepted:data.accepted || [], failures:data.failures || [], blocked:data.blocked || [],
        });
        const preview = structuredClone(page);
        for (const evidence of receipt.dispatches || []) applySourceEvidence(preview,evidence);
        preview.accepted = receipt.accepted || [];
        preview.failures = receipt.failures || [];
        preview.blocked = receipt.blocked || [];
        preview.inFlight = [];
        preview.phase = receipt.phase === 'finished' ? 'finished' : 'translating';
        captured = {...current,pages:{...(current.pages || {}),[pageId]:preview}};
      } else {
        captured = await sessions.update(runId, current => {
          const page = current?.pages?.[pageId];
          if (!page || !live(current) || current.phase !== 'collecting') return current;
          if (data.stage === 'dispatch') {
            captureSourceEvidence(page, data);
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
            else if (data.nextDispatch) {
              captureSourceEvidence(page, data.nextDispatch);
              page.phase = 'translating';
              page.inFlight = (data.nextDispatch.ids || []).map(String);
              page.currentOperation = data.nextDispatch.operationId;
            }
          }
          return current;
        });
      }
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
    const pageId = String(ctx.translationRun.pageId || '');
    const run = await sessions.get(id).catch(() => null);
    if (!run || !live(run)) return;
    if (!run.pages?.[pageId]) {
      const page = await preparedPages.get(id,pageId).catch(() => null);
      if (!page) return;
      const receipt = await dispatchJournal.markDelivered(id,pageId,applied === true);
      const preview = {...page,delivered:receipt.delivered === true};
      presentPage({...run,pages:{...(run.pages || {}),[pageId]:preview}},preview);
      return;
    }
    const updated = await sessions.update(id, current => {
      const page = current?.pages?.[pageId];
      if (!page || !live(current)) return current;
      page.delivered = applied === true; return current;
    });
    if (updated) presentPage(updated,updated.pages?.[pageId]);
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
      // Presentation ACK is observable now; durable repair acceptance below
      // remains its own boundary. Never derive image count from unit totals.
      if (applied) updateImagePresentation(run.batchId, pageId, {
        insertionAck:{present:receipt.drawn!==false, provisional:false, acknowledgedAt:now()},
        progressEvent:{lane:'insert', state:'done', detail:receipt.drawn===false ? 'No translation layer' : 'Repair placed; finalizing'},
      });
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
        const key = mdCacheKey(mdKeyFromUrl(plan.page.ctx.imgUrl), plan.page.targetLang,
          plan.page.ctx.mode, plan.page.ctx.source, prepared.settingsEpoch);
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
      // Only registerBatch creates API ownership. A browser checkpoint cannot
      // recreate expired work after the temporary API process state is lost.
      await api(run, '', undefined, {signal:ctrl.signal});
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
      // Empty pools are already terminal: no planner, capabilities or repair UI.
      if (snapshot.phase !== 'done' || (snapshot.tasks || []).length || (snapshot.results || []).length) {
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
            const lane = laneKeyFor(payload);
            await acquire(lane, signal);
            try {
              const answer = await work();
              // A repair task has different work from the initial page sample.
              // Release capacity without teaching Auto from repair or wait time.
              if (answer?.replayed === true) releaseReplay(lane);
              else releaseSuccess(lane, 0);
              return answer;
            } catch (error) { releaseFailed(lane); throw error; }
          },
        });
      } else {
        // An empty AI pool can still contain an accepted initial result whose
        // placement acknowledgement was lost. Preserve that delivery path.
        await applyResults(run, []);
      }
      if (!live(run)) { await cancelBatch(run.batchId, 'stale_after_repair'); return null; }
      if (snapshot.phase !== 'done') throw Object.assign(new Error('Repair pool is not terminal'), {code:'repair_tasks_pending'});
      const summary = publicProgress(snapshot);
      let finalPages = [];
      const value = await sessions.update(run.id, current => {
        if (!current || current.phase === 'cancelled') return current;
        const pages = Object.values(current.pages);
        finalPages = pages;
        const wrongLanguageCount = Object.values(current.tasks).reduce((n,task) =>
          n + (task.state === 'done' ? (task.wrongLanguageIds || []).length : 0), 0);
        const alignmentUncertainCount = Object.values(current.tasks).reduce((n,task) =>
          n + (task.state === 'done' ? (task.alignmentUncertainIds || []).length : 0), 0);
        const applyPendingPages = pages.filter(p => p.patchPending).length;
        const applyFailedPages = pages.filter(p => p.patchError).length;
        const appliedRepairedUnits = pages.reduce((n,p) => n + p.repaired.length, 0);
        const finalSummary = {...summary, wrongLanguageCount, alignmentUncertainCount, applyPendingPages, applyFailedPages,
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
      if (!value || !live(value)) { await cancelBatch(run.batchId, 'stale_after_repair_commit'); return null; }
      for (const page of finalPages) presentPage(value, page, value.phase);
      progress(value || run, {...(value?.summary || summary), phase:value?.phase || summary.phase});
      await settleDeferredImageErrors(value || run, finalPages, value?.phase || summary.phase);
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
      if (error.code === 'repair_run_not_found') {
        const current = await sessions.get(run.id).catch(() => null);
        const lost = current || run;
        // Mark the status without changing already displayed partial results.
        progress(lost, {phase:'unavailable', code:'repair_run_not_found'});
        await settleDeferredImageErrors(lost, Object.values(lost.pages || {}), 'unavailable');
        await sessions.update(run.id, value => value && ({...value,
          phase:'unavailable', resumePhase:null, lastError:'repair_run_not_found',
          pages:{}, tasks:{}, summary:{...value.summary, phase:'unavailable', code:'repair_run_not_found'}}));
        await Promise.all([dispatchJournal.clearRun(run.id).catch(() => {}),
          preparedPages.clearRun(run.id).catch(() => {})]);
        for (const key of runtimePages.keys()) if (key.startsWith(`${run.id}:`)) runtimePages.delete(key);
        batchRuns.delete(run.batchId);
        emit('repairOwnershipExpired', {runId:run.id, batchId:run.batchId, code:'repair_run_not_found'});
        return null;
      }
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
        const [sources, dispatches] = await Promise.all([
          preparedPages.listRun(id).catch(() => []),
          dispatchJournal.listRun(id).catch(() => []),
        ]);
        run = await sessions.update(id, current => {
          for (const source of sources) {
            if (source?.pageId && source?.page && !current.pages?.[source.pageId])
              current.pages[source.pageId] = source.page;
          }
          for (const receipt of dispatches) {
            const page = current.pages?.[receipt.pageId];
            if (!page) continue;
            for (const evidence of receipt.dispatches || (receipt.evidence ? [receipt.evidence] : []))
              applySourceEvidence(page,evidence);
            const accepted = new Map(page.accepted.map(row => [String(row.id),row]));
            for (const row of receipt.accepted || []) if (!accepted.has(String(row.id)))
              accepted.set(String(row.id),{id:String(row.id),text:String(row.text || '')});
            page.accepted=[...accepted.values()];
            const failures=new Map(page.failures.map(row => [String(row.id),row]));
            for (const row of receipt.failures || []) if (!accepted.has(String(row.id))) {
              const prior=failures.get(String(row.id));
              if (!prior || row.reason !== 'missing') failures.set(String(row.id),row);
            }
            for (const acceptedId of accepted.keys()) failures.delete(acceptedId);
            page.failures=[...failures.values()];
            page.blocked=[...new Set([...page.blocked,...(receipt.blocked || []).map(String)])];
            if (receipt.delivered === true) page.delivered = true;
            const latest=(receipt.dispatches || []).at(-1) || receipt.evidence;
            if (receipt.phase === 'finished') {
              page.phase='finished';page.inFlight=[];
            } else if (latest) {
              page.phase='translating';page.inFlight=[...latest.targetIds];page.currentOperation=latest.operationId;
            }
          }
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
        await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]);
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
    if (!run) { await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]); return; }
    await sessions.update(id, value => value && ({...value, phase:'cancelled', pages:{}, tasks:{}, reason})).catch(() => {});
    await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]);
    for (const key of runtimePages.keys()) if (key.startsWith(`${id}:`)) runtimePages.delete(key);
    await api(run, 'cancel', {}).catch(() => {});
    emit('repairCancelled', {runId:id, batchId, reason});
  }
  async function resume() {
    const rows = await sessions.list().catch(() => []);
    for (let run of rows) {
      if (['done','apply_failed','cancelled','unavailable'].includes(run.phase)) continue;
      batchRuns.set(run.batchId, run.id);
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
    for (const run of await sessions.list().catch(() => [])) {
      if (['done','cancelled'].includes(run.phase) || run.settingsEpoch === currentEpoch()) continue;
      // A semantic settings change (including Thinking) aborts the browser
      // fetch immediately. Propagate the same batch cancellation to the API so
      // an already-running provider call does not continue after the user has
      // changed the request contract. Repair cancellation alone is not enough.
      cancelBatchProviderViaRest(run.batchId);
      await cancelBatch(run.batchId,'settings_changed');
    }
  }
  return { registerBatch, capture:safeCapture, markDelivered, ownsInitialFailure, finishInitial, cancelBatch, cancelTab, cancelSettings, resume,
    async summaries() { return (await sessions.list().catch(() => [])).map(r => ({...r.summary, batchId:r.batchId, phase:r.phase})); } };
}
export const repairCoordinator = createRepairCoordinator();
