import { readLoginState } from '../../shared/login-session.js';
import { requestFromTabExact } from '../tabs-messaging.js';
import { releaseReaderBatch } from "../reader-placement.js";
import { captureSourceEvidence, sourceEvidenceForDispatch, applySourceEvidence } from "./source-evidence.js";
import { translationSessions } from '../translation-session-store.js';
import { conversationDispatchJournal } from './dispatch-journal.js';
import { conversationPreparedPages } from './prepared-page-journal.js';
import { repairRequest } from './client.js';
import { initialReportBatches } from './initial-report-batches.js';
import { makePageCheckpoint, digestText, checkpointCredentialMatches, buildPatchedResult, pageInitialReport, compactDeliveredPage } from './page-checkpoint.js';
import { executeRepairPool, repairUsageDiagnostic } from './executor.js';
import { findContext } from '../job-registry.js';
import { getBatch, ensureBatch, registerBatchPayload, batchMark, batchUpdateToast, batchStopKeepAlive, updateImagePresentation } from '../batches.js';
import { getTabSessionId } from '../tab-sessions.js';
import { getSettingsEpoch, abortBatchInFlight } from '../jobs/lifecycle.js';
import { readAccountSession } from '../../shared/account-gate.js';
import { dataConsentError } from '../../shared/data-consent.js';
import { cancelBatchProviderViaRest } from '../jobs/cancellation.js';
import { enqueueDomInsert } from '../insert-queue.js';
import { getStorage } from '../../shared/storage.js';
import { makeProviderIdentity } from '../../shared/ai-profiles.js';
import { getCapabilities } from '../capabilities.js';
import { getApiBase } from '../api.js';
import { acquire, releaseSuccess, releaseReplay, releaseFailed, laneKeyFor } from '../scheduler.js';
import { getCachedDataUri, setCachedResult, mdCacheKey, mdKeyFromUrl, stripImageFields } from '../mangadex.js';
import { resultCache } from '../result-cache.js';
import { fetchImageDataUriFromTab } from '../images.js';
import { normImgSrc, persistableSource, sameImageSource } from '../job-keys.js';
import { note as traceNote } from '../../shared/trace.js';
import { refreshLocalAiCapabilities as defaultRefreshLocalAiCapabilities } from '../local-ai-preflight.js';
import { hasMeaningfulAiSource } from '../../shared/ai-source-filter.js';
import { pressurePause } from './provider-pressure.js';

const trace = (event, data) => traceNote('background/repair/coordinator.js', event, data);
const publicProgress = value => Object.fromEntries(['phase','repaired','unresolved','failedUnits',
  'initialAccepted','unverified','unavailablePages','skippedPages','skippedUnits','unitCount','taskId','code',
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
  refreshLocalAiCapabilities = defaultRefreshLocalAiCapabilities,
} = {}) {
  const batchRuns = new Map(), runtimePages = new Map(), operations = new Map(), controllers = new Map();
  const pressureWrites = new Map();
  // runtimePages holds each page's source image bytes (data URI, often MB-sized)
  // until the run ends. Unavailable runs never repair: release everything.
  // Blocked runs may resume: release only the image bytes (resume re-reads them
  // from the md cache or the tab, see credentials()).
  function releaseRuntime(runId, {imagesOnly = false} = {}) {
    for (const [key, value] of runtimePages) {
      if (!key.startsWith(`${runId}:`)) continue;
      if (imagesOnly) { if (value?.sourceImageDataUri) runtimePages.set(key, {...value, sourceImageDataUri:''}); }
      else runtimePages.delete(key);
    }
  }
  const cancelledRuns = new Set();
  let executor;
  const workerId = () => executor ||= crypto.randomUUID();
  function lifecycle(run, reason, started, complete = false, failed = false, counts = {}) {
    emit('repairLifecycle', {schema:'tp.audit/1', event:'repair_lifecycle', reason,
      scope:{runId:run.id, batchId:run.batchId}, phase:failed ? 'error' : 'repair_wait',
      complete, persistence:failed ? 'failed' : complete ? 'persisted' : 'pending',
      timing:{elapsedMs:Math.max(0, now()-started)}, counts});
  }
  function live(run) {
    // A settings change does not end a repair run (it keeps its saved settings).
    return !cancelledRuns.has(run.id) && run.phase !== 'cancelled' && !getBatch(run.batchId)?.cancelled &&
      currentSession(run.tabId) === run.sessionId;
  }
  function presentPage(run, page, repairPhase = run.phase, extra = {}) {
    if(!page) return;
    const ids=new Set(page.units.filter(u=>u.translatable && hasMeaningfulAiSource(u.text)).map(u=>u.id));
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
  // A page whose provider stream was stopped (stalled, thought too long,
  // safety ceiling) before any line has nothing a repair could build on: the
  // same provider would most likely stop again after another ~60 s. It leaves
  // the repair run, so its error is shown at the first stop and the user can
  // press Translate again. Synchronous: the merge in finishInitial (which the
  // same image error may start) already sees it. Pages with lines still repair.
  const stoppedPages = new Map();
  function releaseStoppedPage(batchId, pageId, code) {
    const runId = batchRuns.get(String(batchId || '')), id = String(pageId || '');
    if (!runId || !id || cancelledRuns.has(runId)) return false;
    if (!stoppedPages.has(runId)) stoppedPages.set(runId, new Map());
    stoppedPages.get(runId).set(id, String(code || 'stream_stopped').slice(0, 40));
    updateImagePresentation(batchId, id, {repairPhase:''});
    emit('repairPageReleased', {runId, batchId:String(batchId), pageId:id, code:String(code || ''), reason:'provider_stream_stop'});
    return true;
  }
  async function settleDeferredImageErrors(run, pages, phase) {
    if (!['done','apply_failed','unavailable','blocked'].includes(phase) || !live(run)) return;
    const paused = phase === 'blocked';
    const batch = getBatch(run.batchId);
    if (!batch) return;
    const byId = new Map((pages || []).filter(page => page?.pageId)
      .map(page => [String(page.pageId),page]));
    // A failed source checkpoint is still a terminal image failure. Its saved
    // notice already owns the original target/generation; it must not disappear
    // just because the repair run has no page source or released that source.
    for (const pageId of run.manifest || []) {
      if (!live(run)) return;
      const item = batch.items?.get?.(String(pageId));
      const message = item?.deferredImageError;
      if (!message || typeof message !== 'object') continue;
      const page = byId.get(String(pageId));
      if (page?.delivered === true) {
        batchMark(run.batchId, pageId, { deferredImageError:null });
        continue;
      }
      const ctx = page?.ctx || {tabId:run.tabId,frameId:run.frameId || 0};
      if (!page && (!item?.payload?.src || !sameImageSource(message.original, item.payload.src) ||
          !message.generation?.pageInstanceId || !(message.generation.targetInstanceId ||
            (message.generation.readerRunId && message.generation.readerPageId)))) continue;
      try {
        const notice = paused ? {...message, message:`${message.message} · การซ่อมแปลหยุดชั่วคราว`,
          ...(message.error ? {error:{...message.error,
            userMessage:`${message.error.userMessage} · การซ่อมแปลหยุดชั่วคราว`}} : {})} : message;
        const ack=await insert(ctx.tabId, notice, ctx.frameId || 0);
        const visible=ack?.ok===true && !ack.stale && (ack.applied===true || ack.errorDisplayed===true || ack.toastDisplayed===true);
        if(!visible)throw Object.assign(new Error('Error notice was not acknowledged by the page'),{code:ack?.stale?'stale_error_notice':'error_notice_unacknowledged'});
        if (!live(run)) return;
        // Paused repair still owns its saved source and resume boundary. Keep
        // the notice until terminal repair decides whether it was resolved.
        if (!paused) batchMark(run.batchId, pageId, { deferredImageError:null });
        emit('repairTerminalImageError', {runId:run.id, batchId:run.batchId,
          pageId, phase, delivered:true, errorNoticeDelivered:true,
          owner:'extension', outcome:'failed', severity:'warning', translationOutcome:'failed'});
      } catch (error) {
        emit('repairTerminalImageError', {runId:run.id, batchId:run.batchId,
          pageId, phase, delivered:false, errorNoticeDelivered:false,
          owner:'extension', outcome:'failed', severity:'warning', translationOutcome:'failed', code:error.code || 'delivery_failed'});
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
    const summary = publicProgress({...data, skippedPages:Object.keys(run.initialSkips || {}).length});
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
      const activePages = new Set((data.pageIds || []).map(String));
      for (const page of Object.values(run.pages || {})) if (activePages.has(String(page.pageId)))
        presentPage(run, page, data.phase, {repairEvent:data.event || ""});
      emit('repairProgress', data.phase === 'repair_validation'
        ? diagnosticProgress(run, data)
        : { runId:run.id, batchId:run.batchId, ...publicProgress(data), event:data.event,
          ...repairUsageDiagnostic(data) });
      return;
    }
    const taskPages = data.taskId ? new Set((data.pageIds || []).map(String)) : null;
    for(const page of Object.values(run.pages || {})) if (!taskPages || taskPages.has(String(page.pageId)))
      presentPage(run,page,data.phase);
    const b = getBatch(run.batchId);
    const summary = publicProgress(data);
    if (b) {
      b.repair = summary;
      const label = data.phase === 'done'
        ? `Repair: ${data.repaired || 0}/${data.failedUnits || 0} fixed; ${data.unresolved || 0} unresolved${data.skippedUnits ? `; ${data.skippedUnits} skipped` : ''}${data.wrongLanguageCount ? `; ${data.wrongLanguageCount} wrong target language` : ''}${data.alignmentUncertainCount ? `; ${data.alignmentUncertainCount} alignment uncertain` : ''}${data.unverified ? `; ${data.unverified} interrupted` : ''}${data.unavailablePages ? `; ${data.unavailablePages} image(s) lack source` : ''}`
        : data.phase === 'apply_failed'
          ? `Repair complete: ${data.appliedRepairedUnits || 0}/${data.failedUnits || 0} fixed and placed; ${data.unresolved || 0} unresolved; ${data.applyFailedPages || 0} image(s) could not be placed safely (saved results)`
        : data.phase === 'unavailable' ? `Repair unavailable: ${data.code || 'API/session error'}`
        : data.phase === 'applying' ? 'Placing repair results'
        : data.phase === 'apply_pending' ? `Repair complete; waiting to place saved results${data.applyFailedPages ? `; ${data.applyFailedPages} image(s) could not be placed safely` : ''}`
        : data.phase === 'blocked' ? `Repair paused: ${data.code || 'connection interrupted'}`
        : data.phase === 'repairing' ? `Repairing ${data.failedUnits || 0} unit(s); ${data.repaired || 0} fixed`
        : 'Collecting repair candidates';
      b.repair.label = label;
      batchUpdateToast(b, label);
    }
    // 'collecting' is already durable in the registered run and the batch UI
    // above is live; persisting a duplicate summary would queue a write the
    // first prepared page must wait for before AI.
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
      base: await getBase(), manifest: [...batch.items.keys()], targets:payloads.map(p => persistableSource(normImgSrc(p.src))),
      ownerWorker:workerId(), reader:batch.reader || null, pages: {}, tasks: {}, summary: {} };
    try {
      for (const prior of await sessions.list()) {
        if (prior.tabId === run.tabId && prior.frameId === run.frameId &&
            !['done','apply_failed','cancelled','unavailable'].includes(prior.phase) &&
            (prior.sessionId !== run.sessionId || (prior.targets || []).some(x => run.targets.includes(x)))) {
          batchRuns.set(prior.batchId, prior.id);
          await cancelBatch(prior.batchId, prior.sessionId !== run.sessionId ? 'old_tab_session' : 'superseded_translation');
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
    if (data.stage === 'pressure') {
      if (!data.providerPressure) return;
      const runId = batchRuns.get(batchId), pageId = String(data.imageId || '');
      const run = runId && await sessions.get(runId);
      if (!run || !live(run) || run.phase !== 'collecting') return;
      const page = run.pages?.[pageId] || await preparedPages.get(runId, pageId);
      if (!page) return;
      const key = `${runId}:${page.groupKey}`;
      const prior = pressureWrites.get(key);
      if (prior && now() < prior.until) { await prior.write; return; }
      const write = sessions.update(runId, value => value && live(value) && value.phase === 'collecting'
        ? {...value, providerPressure:{...(value.providerPressure || {}), [page.groupKey]:data.providerPressure}} : value);
      pressureWrites.set(key, {until:data.providerPressure.until, write});
      try { await write; } catch (error) {
        pressureWrites.delete(key);
        // Provider pressure is a scheduling hint, not repair authority
        // (no source, receipt or delivery state). A full session area must not
        // turn this hint into "repair unavailable" for the whole run: skip its
        // persistence and trace it. Source/receipt checkpoints still fail closed.
        emit('repairCheckpointSkipped', {runId, batchId, stage:'pressure', essential:false,
          code:error?.code || (/QUOTA_BYTES/i.test(String(error?.message || '')) ? 'SESSION_STORAGE_LIMIT' : 'checkpoint_failed')});
      }
      return;
    }
    const runId = batchRuns.get(batchId);
    if (!runId || cancelledRuns.has(runId) || getBatch(batchId)?.repair?.phase === 'unavailable') return;
    const pageId = String(data.payload?.metadata?.image_id || data.imageId || getContext(data.jobId)?.imageKey || '');
    if ((Array.isArray(data.failures) && data.failures.length) || (Array.isArray(data.blocked) && data.blocked.length)) {
      // A page with failed lines is not reused from the result cache until its
      // repair fixes every line (never loop on a cached error).
      const key = getContext(data.jobId, pageId)?.resultCacheKey;
      if (key) resultCache.markPending(key);
    }
    if (data.stage === 'skipped' && ['no_text','no_translatable_text','result_cache_hit'].includes(data.reason)) {
      await sessions.update(runId, run => {
        if (!live(run) || run.phase !== 'collecting' || !run.manifest.includes(pageId)) return run;
        return {...run, initialSkips:{...(run.initialSkips || {}),[pageId]:data.reason}};
      });
      return;
    }
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
        // Conversation keeps the immutable source checkpoint under a page key;
        // writing the growing run object here would slow every checkpoint as the
        // chapter grows. The repair barrier folds page rows into the run later.
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
        // Keep the post-provider durability barrier but write only the small
        // per-page result delta: rewriting the full run would add session-storage
        // latency before every Conversation turn. finishInitial folds these
        // receipts into the full checkpoint before repair sealing/recovery.
        const current = await sessions.get(runId);
        const page = current?.pages?.[pageId] || await preparedPages.get(runId, pageId);
        if (!page || !live(current) || current.phase !== 'collecting') return;
        if (page.compacted) return; // A late duplicate cannot reopen a confirmed page.
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
        preview.delivered = receipt.delivered === true;
        if (preview.phase === 'finished' && preview.delivered)
          await preparedPages.compactDelivered?.(runId,pageId,preview).catch(() => {});
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
          current.pages[pageId] = compactDeliveredPage(page);
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
        await checkpointUnavailable(run, error);
      }
      emit('repairCheckpointFailed', { batchId, code: error.code || 'checkpoint_failed' });
    }
  }
  async function checkpointUnavailable(run, error) {
    if (!live(run)) return;
    const code = /session storage quota bytes exceeded|QUOTA_BYTES exceeded/i.test(String(error?.message || '')) ||
      error?.code === 'session_checkpoint_limit' ? 'SESSION_STORAGE_LIMIT' : error?.code || 'CHECKPOINT_FAILED';
    const stopped = {...run, phase:'unavailable', lastError:code};
    // The owning batch is the in-memory latch even when the same full storage
    // rejects the failure-state write. Initial translation can continue once;
    // repair must never proceed without its durable source/receipt authority.
    progress(stopped, {phase:'unavailable', code});
    releaseRuntime(run.id);
    await sessions.update(run.id, value => value && ({...value, phase:'unavailable', lastError:code})).catch(() => {});
    await settleDeferredImageErrors(stopped, Object.values(stopped.pages || {}), 'unavailable');
  }
  async function markDelivered(ctx, applied) {
    // A delayed stored ACK cannot undo a real content placement receipt.
    if (ctx?.generation?.readerRunId && applied !== true) return;
    const id = ctx?.translationRun?.runId;
    if (!id || cancelledRuns.has(id)) return;
    const pageId = String(ctx.translationRun.pageId || '');
    const run = await sessions.get(id).catch(() => null);
    if (!run || !live(run) || getBatch(run.batchId)?.repair?.phase === 'unavailable') return;
    if (!run.pages?.[pageId]) {
      const page = await preparedPages.get(id,pageId).catch(() => null);
      if (!page) return;
      const receipt = await dispatchJournal.markDelivered(id,pageId,applied === true);
      const preview = {...page, accepted:receipt.accepted, failures:receipt.failures,
        blocked:receipt.blocked,phase:receipt.phase === 'finished' ? 'finished' : page.phase,
        delivered:receipt.delivered === true};
      await preparedPages.compactDelivered?.(id,pageId,preview).catch(() => {});
      presentPage({...run,pages:{...(run.pages || {}),[pageId]:preview}},preview);
      // A placement receipt can race a per-page journal transfer. Bring the
      // canonical page up to date if the repair barrier moved it meanwhile.
      if (operations.has(id) && (await sessions.get(id).catch(() => null))?.pages?.[pageId])
        await sessions.update(id,current => {
          const row=current?.pages?.[pageId];if (!row || !live(current)) return current;
          row.delivered = row.delivered || applied === true;
          current.pages[pageId]=compactDeliveredPage(row);
          return current;
        });
      return;
    }
    const updated = await sessions.update(id, current => {
      const page = current?.pages?.[pageId];
      if (!page || !live(current)) return current;
      page.delivered = page.delivered || applied === true;
      current.pages[pageId]=compactDeliveredPage(page);
      return current;
    });
    if (updated) presentPage(updated,updated.pages?.[pageId]);
  }
  async function credentials(page, run) {
    const runtime = runtimePages.get(`${run.id}:${page.pageId}`);
    const ai = { ...page.ai };
    // 10495: Paid/Login repair sends the account token. Without data-use consent
    // (never given, or withdrawn) nothing is sent; an automatic resume is a no-op.
    const account = ["paid", "login"].includes(ai.provider)
      ? await readAccountSession({ read: readLoginState, keys: ["loginSessionId"] }) : null;
    if (account && !account.consent) throw dataConsentError({ revoked: Boolean(runtime?.ai) });
    if (runtime?.ai) {
      ai.api_key = runtime.ai.api_key || '';
      if(runtime.ai.price_quote_token)ai.price_quote_token=runtime.ai.price_quote_token;
    }
    else if (["paid", "login"].includes(ai.provider)) {
      if (!account.ok || account.base !== String(run.base || "").replace(/\/+$/, "") ||
          (ai.provider === "login" && !String(ai.model || "").startsWith(String(account.values.loginSessionId || "missing") + "/")))
        throw Object.assign(new Error("Sign in to the original account before retrying repair."), {code:"repair_account_unavailable"});
      ai.api_key = account.token;
      if (ai.provider === 'paid' && !await checkpointCredentialMatches(page, ai.api_key))
        throw Object.assign(new Error('The saved repair belongs to a different Paid session. Restore the original session before retrying.'), {code:'repair_account_unavailable'});
    }
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
    return refreshLocalAiCapabilities(ai, page.route, {signal:controllers.get(run.id)?.signal, traceId:run.id});
  }
  async function applyResults(run, rows) {
    const current = await sessions.get(run.id);
    if (!current || !live(current)) return;
    const byPage = new Map();
    for (const row of rows || []) {
      if (!byPage.has(row.pageId)) byPage.set(row.pageId, []);
      byPage.get(row.pageId).push(row);
    }
    const batch = getBatch(run.batchId);
    for (const page of Object.values(current.pages)) {
      if (page.delivered || !page.accepted.length || byPage.has(page.pageId)) continue;
      // The reader already owns this initial result and will place it when its
      // image mounts. An unmounted, healthy page is not a repair patch. Keep
      // the fallback below when the initial result was never staged.
      const initialStaged = page.ctx.generation?.readerRunId &&
        batch?.items?.get(page.pageId)?.presentation?.placementPending === true;
      if (!initialStaged) byPage.set(page.pageId, []);
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
      const skippedIds = new Set(page.sourceSkippedIds || []);
      const wantedSkips = candidates.filter(row => {
        const unit = page.units.find(u => u.id === (row.unitId || row.id));
        if (row.state !== 'skipped' || !unit || hasMeaningfulAiSource(unit.text) ||
            row.sourceHash !== unit.sourceHash || row.generationId !== page.generationId || skippedIds.has(unit.id)) return false;
        skippedIds.add(unit.id);return true;
      });
      if (!wanted.length && !wantedSkips.length && page.delivered) return null;
      const revision = await digestText(JSON.stringify({accepted:patch.accepted,skipped:[...skippedIds]}));
      const runtime = runtimePages.get(`${run.id}:${pageId}`);
      const image = runtime?.sourceImageDataUri || getCachedDataUri(normImgSrc(page.ctx.imgUrl));
      if (image) patch.result.sourceImageDataUri = image;
      return {pageId, page, patch, revision, image, wanted, wantedSkips};
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
          if(entry.page.ctx.generation?.readerRunId) target.pendingPatch={revision:entry.revision,
            accepted:entry.patch.accepted,repairedIds:entry.wanted.map(x=>x.id),
            sourceSkippedIds:entry.wantedSkips.map(x=>x.unitId || x.id)};
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
          generation:page.ctx.generation, tpTrace:page.ctx.traceId, workflowId:page.ctx.workflowId || '',
          translationRun:{runId:run.id, pageId, generationId:page.generationId, phase:'repair', revision}
        }, page.ctx.frameId || 0);
      } catch (error) { errorCode = error.code || 'repair_delivery_unconfirmed'; }
      if(receipt?.stored && page.ctx.generation?.readerRunId) updateImagePresentation(run.batchId,pageId,{placementPending:true});
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
        target.sourceSkippedIds = [...new Set([...(target.sourceSkippedIds || []),...plan.wantedSkips.map(x => x.unitId || x.id)])];
        target.patchPending = ''; target.delivered = true; delete target.pendingPatch;
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
        // A reused page must show the repaired text, not the initial one.
        if (plan.page.ctx.resultCacheKey) resultCache.replaceText(plan.page.ctx.resultCacheKey, plan.patch.result,
          {complete: !plan.patch.missing.length});
      }
      emit('repairPatch', {runId:run.id, pageId:plan.pageId, applied, stale:!!plan.receipt?.stale || !live(prepared),
        fixedUnits:applied ? plan.wanted.length : 0, skippedUnits:applied ? plan.wantedSkips.length : 0,
        readyUnits:plan.wanted.length, remaining:plan.patch.missing.length, code:plan.errorCode});
    }
  }
  async function runRepair(run) {
    if (!live(run)) { await cancelBatch(run.batchId, 'stale_generation'); return null; }
    const ctrl = new AbortController(); controllers.set(run.id, ctrl);
    let stageReason = 'repair_ledger_reports', stageStarted = now(), stageComplete = false;
    lifecycle(run, stageReason, stageStarted);
    try {
      // Only registerBatch creates API ownership. A browser checkpoint cannot
      // recreate expired work after the temporary API process state is lost.
      await api(run, '', undefined, {signal:ctrl.signal});
      const syncStarted = now();
      let reportRequests = 0, reportedPages = 0;
      if (run.phase === 'collecting') {
        // Keep manifest order and page source hashes. One 28-page job needs
        // one request, not 28 serial RTTs; longer jobs remain bounded and
        // sequential so one user cannot flood the shared API with reports.
        function* reports() {
          for (const pageId of run.manifest) {
            const page = run.pages[pageId];
            yield page ? pageInitialReport(page) : {
              pageId, generationId:run.id, groupKey:'', status:run.initialSkips?.[pageId] ? 'finished' : 'no_source', failed:[], initialAccepted:0, unverified:0,
            };
          }
        }
        for (const body of initialReportBatches(reports())) {
          if (!live(run) || ctrl.signal.aborted) throw new DOMException('Stale repair', 'AbortError');
          await api(run, 'pages', body, {signal:ctrl.signal});
          reportRequests++; reportedPages += body.pages.length;
        }
      }
      const syncMs = Math.max(0, now() - syncStarted), sealStarted = now();
      lifecycle(run, stageReason, stageStarted, true, false, {requests:reportRequests,count:reportedPages});
      stageReason = 'repair_ledger_seal'; stageStarted = sealStarted;
      lifecycle(run, stageReason, stageStarted);
      let snapshot = await api(run, 'seal', {}, {signal:ctrl.signal});
      lifecycle(run, stageReason, stageStarted, true, false, {pending:(snapshot.pending || []).length});
      stageComplete = true;
      emit('repairLedgerSync', {runId:run.id, batchId:run.batchId, reportRequests, reportedPages,
        syncMs, sealMs:Math.max(0, now() - sealStarted), pendingUnits:(snapshot.pending || []).length,
        phase:snapshot.phase});
      // Empty pools are already terminal: no planner, capabilities or repair UI.
      if (snapshot.phase !== 'done' || (snapshot.tasks || []).length || (snapshot.results || []).length) {
        await sessions.update(run.id, value => value && ({ ...value, phase:'repairing' }));
        const capabilities = await getCapabilitiesFor(run.base);
        snapshot = await execute({ run, snapshot, executor:workerId(), signal:ctrl.signal, capabilities,
          getPage: async pageId => (await sessions.get(run.id))?.pages?.[pageId],
          readTask: async taskId => (await sessions.get(run.id))?.tasks?.[taskId],
          resolveAi: page => credentials(page, run), api,
          checkpointTask: task => sessions.update(run.id, value => {
            if (value && value.phase !== 'cancelled') {
              value.tasks[task.id] = { ...(value.tasks[task.id] || {}), ...task };
              if (task.providerPressure && task.groupKey)
                value.providerPressure = {...(value.providerPressure || {}), [task.groupKey]:task.providerPressure};
            }
            return value;
          }),
          onProgress: data => progress(run, data),
          applyResults: rows => applyResults(run, rows),
          withCapacity: async (page, ai, signal, work) => {
            if (!live(run)) throw new DOMException('Stale repair','AbortError');
            const cooldown = pressurePause(run.providerPressure?.[page.groupKey], now());
            if (cooldown) throw cooldown;
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
        const retain = applyPendingPages;
        return { ...current,
          phase:applyPendingPages ? 'apply_pending' : applyFailedPages ? 'apply_failed' : 'done',
          summary:finalSummary,
          // Only unconfirmed repair placement needs its source checkpoint.
          // An unsafe terminal refusal remains visible in the small summary.
          pages:retain ? current.pages : {}, tasks:retain ? current.tasks : {} };
      });
      if (!value || !live(value)) { await cancelBatch(run.batchId, 'stale_after_repair_commit'); return null; }
      for (const page of finalPages) presentPage(value, page, value.phase);
      progress(value || run, {...(value?.summary || summary), phase:value?.phase || summary.phase});
      await settleDeferredImageErrors(value || run, finalPages, value?.phase || summary.phase);
      const readerBatch=getBatch(run.batchId);
      if(readerBatch?.reader) await releaseReaderBatch(readerBatch);
      if (['done','apply_failed'].includes(value?.phase)) {
        for (const key of runtimePages.keys()) if (key.startsWith(`${run.id}:`)) runtimePages.delete(key);
      }
      if (value?.phase === 'done') {
        // Release server-side dialogue only after confirmed delivery.
        await api(run, '', undefined, { method:'DELETE' }).catch(() => {});
      }
      return value?.summary || summary;
    } catch (error) {
      if (!stageComplete) lifecycle(run, stageReason, stageStarted, false, true);
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
        const readerBatch=getBatch(run.batchId);
        if(readerBatch?.reader) await releaseReaderBatch(readerBatch);
        batchRuns.delete(run.batchId);
        emit('repairOwnershipExpired', {runId:run.id, batchId:run.batchId, code:'repair_run_not_found'});
        return null;
      }
      await sessions.update(run.id, value => value && ({ ...value, phase:'blocked',
        resumePhase:value.phase, lastError:error.code || error.message,
        retryAt:Number(error.retryAt) || null })).catch(() => {});
      releaseRuntime(run.id, {imagesOnly:true});
      // Applying one repair may already have committed a real DOM ACK before
      // another task fails. Never paint an older error over that accepted page.
      const blocked = await sessions.get(run.id).catch(() => null);
      progress(blocked || {...run, pages:{}}, {phase:'blocked', code:error.code || 'repair_connection_failed'});
      if (blocked) await settleDeferredImageErrors(blocked, Object.values(blocked.pages || {}), 'blocked');
      return null;
    } finally {
      controllers.delete(run.id);
      const b = getBatch(run.batchId); if (b) await batchStopKeepAlive(b);
    }
  }
  async function finishInitial(batch) {
    const id = batchRuns.get(batch.id);
    if (!id) return false;
    let existing = await sessions.get(id).catch(() => null);
    if (!existing) return false;
    if (batch.repair?.phase === 'unavailable') existing = {...existing, phase:'unavailable'};
    if (['done','apply_failed','unavailable'].includes(existing.phase)) {
      await settleDeferredImageErrors(existing, Object.values(existing.pages || {}), existing.phase);
      return existing.phase !== 'unavailable';
    }
    if(existing.reader && existing.phase==='apply_pending'){await releaseReaderBatch(batch);return true;}
    if (operations.has(id)) { await operations.get(id); return batch.repair?.phase !== 'unavailable'; }
    const mergeStarted = now();
    let mergeComplete = false;
    let mergeStage = 'journal_read', transferredPages = 0;
    const work = (async () => {
      let run = await sessions.get(id);
      if (!run || ['done','apply_failed','cancelled','unavailable'].includes(run.phase)) return;
      lifecycle(run, 'repair_checkpoint_merge', mergeStarted);
      // An interrupted generation cannot be repaired blindly: save unknown IDs
      // separately and only pool failures whose response was actually observed.
      if (run.phase === 'collecting') {
        const [sources, dispatches] = await Promise.all([
          // A failed read is not an empty journal. Keep source and unknown
          // dispatch receipts intact; the outer handler stops repair safely.
          preparedPages.listRun(id),
          dispatchJournal.listRun(id),
        ]);
        const receipts = new Map(dispatches.map(row => [String(row.pageId),row]));
        const sourceByPage = new Map(sources.filter(row => row?.pageId && row?.page)
          .map(row => [String(row.pageId),row.page]));
        mergeStage = 'page_transfer';
        // Four pages per durable transfer bound temporary duplication while
        // avoiding one complete run write per image. Source is removed only
        // after the canonical chunk has committed successfully.
        const transferIds = [...new Set([...sourceByPage.keys(),...receipts.keys()])];
        for (let offset=0; offset<transferIds.length; offset+=4) {
          const chunkIds = transferIds.slice(offset,offset+4);
          run = await sessions.update(id,current => {
            if (!current || current.phase !== 'collecting') return current;
            for (const pageId of chunkIds) {
            const source = sourceByPage.get(pageId), receipt = receipts.get(pageId);
            const page = current.pages[pageId] || source;
            if (!page) continue;
            if (receipt && !page.compacted) {
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
              const latest=(receipt.dispatches || []).at(-1) || receipt.evidence;
              if (receipt.phase === 'finished') {page.phase='finished';page.inFlight=[];}
              else if (latest) {page.phase='translating';page.inFlight=[...latest.targetIds];page.currentOperation=latest.operationId;}
            }
            if (receipt?.delivered === true) page.delivered=true;
            current.pages[pageId]=compactDeliveredPage(page);
            }
            return current;
          });
          if (!run || !live(run)) return;
          for (const journal of [preparedPages,dispatchJournal]) {
            if (journal.removeMany) await journal.removeMany(id,chunkIds).catch(() => {});
            else await Promise.all(chunkIds.map(pageId => journal.remove(id,pageId).catch(() => {})));
          }
          transferredPages+=chunkIds.length;
        }
        mergeStage = 'run_settlement';
        const stopped = stoppedPages.get(id);
        run = await sessions.update(id, current => {
          if (!current || current.phase !== 'collecting') return current;
          // Stopped pages report as finished with nothing to repair.
          for (const [pageId, code] of stopped || []) {
            delete current.pages[pageId];
            current.initialSkips = {...(current.initialSkips || {}), [pageId]:code};
          }
          for (const page of Object.values(current.pages)) {
            if (page.phase !== 'finished') {
              const accepted = new Set(page.accepted.map(x=>x.id));
              const blocked = new Set(page.blocked);
              // A terminal page checkpoint blocks every unresolved ID. Only
              // then let blocked receipts supersede earlier failed chunks;
              // ordinary interrupted/gateway pages keep their repairable IDs.
              if (page.units.filter(unit => unit.translatable)
                .every(unit => accepted.has(unit.id) || blocked.has(unit.id))) {
                page.blocked = [...blocked].filter(id => !accepted.has(id));
                page.failures = page.failures.filter(row => !blocked.has(row.id));
              }
              const known = new Set([...accepted, ...page.failures.map(x=>x.id), ...page.blocked]);
              const unknown = new Set(page.inFlight);
              for (const unit of page.units.filter(u => u.translatable && !known.has(u.id))) {
                if (unknown.has(unit.id)) page.blocked.push(unit.id);
                else page.failures.push({id:unit.id, reason:'not_sent'});
              }
              page.blocked = [...new Set(page.blocked)];
              page.phase = page.blocked.length ? 'interrupted' : 'finished'; page.inFlight = [];
            }
            current.pages[page.pageId]=compactDeliveredPage(page);
          }
          return current;
        });
        await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]);
        stoppedPages.delete(id);
      }
      lifecycle(run, 'repair_checkpoint_merge', mergeStarted, true, false, {count:run.manifest.length});
      mergeComplete = true;
      // Initial requests are terminal now: remaining rows are awaiting ledger
      // sync, not still receiving the original AI response. Healthy pages stay done.
      if (run.phase === 'collecting') progress(run, {phase:'collecting'});
      return runRepair(run);
    })().catch(async error => {
      if (!mergeComplete) {
        lifecycle(existing, 'repair_checkpoint_merge', mergeStarted, false, true);
        // Export a bounded classification, never exception text or checkpoint
        // values. This distinguishes native quota, policy capacity and reads.
        const code = /session storage quota bytes exceeded|QUOTA_BYTES exceeded/i.test(String(error?.message || ''))
          ? 'SESSION_STORAGE_QUOTA' : error?.code === 'session_checkpoint_limit'
            ? 'SESSION_CHECKPOINT_LIMIT' : mergeStage === 'journal_read'
              ? 'CHECKPOINT_READ_FAILED' : 'CHECKPOINT_TRANSFER_FAILED';
        try { emit('repairCheckpointFailed', {schema:'tp.checkpoint-failure/1',
          scope:{runId:id, batchId:batch.id}, code, stage:mergeStage, transferredPages}); } catch {}
      }
      await checkpointUnavailable(existing, error);
    });
    operations.set(id, work);
    try { await work; }
    finally { operations.delete(id); }
    return batch.repair?.phase !== 'unavailable';
  }
  // Completes an already generated repair patch; never calls execute/seal or
  // mutates chat history. The saved revision is the authority, not a scroll event.
  async function confirmDeferredPlacement(batch, message) {
    const stamp=message.translationRun;
    if(!stamp || stamp.phase!=='repair' || stamp.runId!==batchRuns.get(batch.id))return false;
    let page=null,accepted=false;
    const value=await sessions.update(stamp.runId,run=>{
      if(!run || !live(run) || run.batchId!==batch.id)return run;
      const target=run.pages?.[stamp.pageId],intent=target?.pendingPatch;
      if(target?.generationId!==stamp.generationId || !intent || intent.revision!==stamp.revision ||
        target.patchPending!==stamp.revision || target.ctx.generation?.readerRunId!==message.readerRunId)return run;
      target.accepted=intent.accepted;
      target.repaired=[...new Set([...target.repaired,...intent.repairedIds])];
      target.sourceSkippedIds=[...new Set([...(target.sourceSkippedIds || []),...(intent.sourceSkippedIds || [])])];
      target.delivered=true;target.patchPending='';delete target.pendingPatch;
      page=target;accepted=true;
      const pages=Object.values(run.pages),waiting=pages.filter(p=>p.patchPending).length;
      const appliedRepairedUnits=pages.reduce((n,p)=>n+(p.repaired?.length || 0),0);
      run.summary={...run.summary,applyPendingPages:waiting,appliedRepairedUnits,
        unappliedRepairedUnits:Math.max(0,(run.summary?.repaired || 0)-appliedRepairedUnits)};
      if(run.phase==='apply_pending'&&!waiting){
        run.phase=pages.some(p=>p.patchError)?'apply_failed':'done';
        if(run.phase==='done'){run.pages={};run.tasks={};}
      }
      return run;
    });
    if(!accepted || !value || !live(value))return false;
    batchMark(batch.id,stamp.pageId,{deferredImageError:null});
    presentPage(value,page,value.phase);
    progress(value,{...value.summary,phase:value.phase});
    if(value.phase==='done'){
      for(const key of runtimePages.keys())if(key.startsWith(`${value.id}:`))runtimePages.delete(key);
      await api(value,'',undefined,{method:'DELETE'}).catch(()=>{});
    }
    return true;
  }
  async function cancelBatch(batchId, reason = 'cancelled') {
    const id = batchRuns.get(batchId); if (!id) return;
    cancelledRuns.add(id); controllers.get(id)?.abort(); stoppedPages.delete(id);
    const batch = getBatch(batchId);
    if (batch) { batch.cancelled = true; batch.cancelRequestedAt = now();
      batch.lifecycle='cancelled';batch.completedAt=now();
      batch.repair={...(batch.repair || {}),phase:'cancelled'};
      for(const [key,item] of batch.items) if(item.presentation?.placementPending || !['done','error','aborted','skipped'].includes(item.status))
        batchMark(batch.id,key,{phase:'cancelled',status:'aborted',lastError:reason,
          presentation:{...(item.presentation || {}),placementPending:false}});
      if(batch.reader)void requestFromTabExact(batch.tabId,{type:'TP_READER_CANCEL',readerRunId:batch.reader.runId,reason},batch.frameId);
      batchUpdateToast(batch,'Cancelled');await batchStopKeepAlive(batch);
    }
    abortBatchInFlight(batchId, 'repair_run_cancelled');
    const run = await sessions.get(id).catch(() => null);
    if (!run) { await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]);
      batchRuns.delete(batchId);return; }
    await Promise.all([dispatchJournal.clearRun(id).catch(() => {}), preparedPages.clearRun(id).catch(() => {})]);
    // A cancelled chapter is no longer recoverable work. Free its run row too;
    // the already placed DOM stays under the content script's display policy.
    await sessions.remove(id).catch(() => {});
    for (const key of runtimePages.keys()) if (key.startsWith(`${id}:`)) runtimePages.delete(key);
    // A completed run has already been deleted on confirmed repair delivery.
    // Navigating away still retires reader placement, but must not POST cancel
    // to that deleted server run (which only produces repair_run_not_found).
    if (run.phase !== 'done') await api(run, 'cancel', {}).catch(() => {});
    batchRuns.delete(batchId);
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
      for(const [index,id] of (run.manifest || []).entries()) {
        if(b.items.has(id))continue;
        const page=run.pages?.[id],ctx=page?.ctx || {};
        const payload={src:ctx.imgUrl || '',generation:ctx.generation || null,
          context:{page_index:index,tp_tab_session:run.sessionId},metadata:{image_id:id,batch_id:run.batchId}};
        if(run.reader && ctx.generation?.readerPageId) payload.reader={...run.reader,pageId:ctx.generation.readerPageId};
        registerBatchPayload(b,payload,id);
        batchMark(b.id,id,{phase:page?.phase==='finished' ? 'done' : 'error',
          status:page?.phase==='finished' ? 'done' : 'error',lastError:page ? '' : 'Interrupted before source checkpoint'});
      }
      if(run.reader)b.reader={...run.reader};
      if(run.reader && run.phase==='apply_pending'){
        b.repair={...run.summary,phase:'apply_pending'};
        await releaseReaderBatch(b,{replayReceipts:true});
        continue;
      }
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
  // Diagnostics/tests: retained in-memory source bytes of one run (no content).
  function runtimeFootprint(runId) {
    let pages = 0, imageChars = 0;
    for (const [key, value] of runtimePages) if (key.startsWith(`${runId}:`)) {
      pages++; imageChars += String(value?.sourceImageDataUri || '').length;
    }
    return {pages, imageChars};
  }
  return { runtimeFootprint, registerBatch, capture:safeCapture, markDelivered, confirmDeferredPlacement, ownsInitialFailure, releaseStoppedPage, finishInitial, cancelBatch, cancelTab, cancelSettings, resume,
    async summaries() { return (await sessions.list().catch(() => [])).map(r => ({...r.summary, batchId:r.batchId, phase:r.phase})); } };
}
export const repairCoordinator = createRepairCoordinator();
