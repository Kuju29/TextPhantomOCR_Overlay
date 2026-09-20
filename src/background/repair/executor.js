import { isProviderBillingFailure } from "../../shared/error-contract.js";
import { uncertainRepairIds } from "../../shared/ai/repair-alignment.js";
import { createAiWireRecorder, aiWireTraceEnabled } from "../ai/wire-trace.js";
import { budgetDiagnostic, rejectedBudgetDiagnostic, resultDiagnostic } from "../../shared/ai/request-diagnostics.js";
import { rememberDiagnostic } from "../ai/recent-diagnostics.js";
import { note as diagnosticNote } from "../../shared/trace.js";
import { repairSourceContext } from "./source-evidence.js";
import { orderRepairUnits, prepareConversationRepairWire } from "./conversation-repair-wire.js";
import { persistProviderGeneration, failureUsageDetails } from "../../shared/ai-usage.js";
import { isLocalAiTarget } from "../../shared/constants.js";
import { workloadController } from '../ai/workload-controller.js';
import { translateUnits } from '../ai/translation-service.js';
import { diagnoseTargetScripts } from '../ai/script-diagnostics.js';
import { repairRequest } from './client.js';
import { pageImageEnabled } from '../../shared/page-image-policy.js';

const cancelled = signal => {
  if (signal?.aborted) throw new DOMException('Repair cancelled', 'AbortError');
};
export function repairValidation(answer, units, targetLang, wireToAlias = new Map()) {
  const expected = new Set(units.map(u => u.id));
  const unknown = answer?.meta?.contractDiagnostics?.ignoredUnknownIds || [];
  const wireIds = wireToAlias.size ? [...wireToAlias.keys()] : [...expected];
  const uncertain = new Set(Array.isArray(answer?.meta?.alignmentUncertainIds)
    ? answer.meta.alignmentUncertainIds
    : uncertainRepairIds(wireIds, unknown).map(id => wireToAlias.get(id) || id));

  const counts = new Map();
  for (const row of answer?.translations || []) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const diagnostics = diagnoseTargetScripts(answer?.translations || [], targetLang, units);
  const rejectedRows = diagnostics.filter(x => x.decision === 'reject');
  const rejected = new Set(rejectedRows.map(x => x.id));
  const accepted = (answer?.translations || []).filter(row => expected.has(row.id) && counts.get(row.id) === 1 &&
    String(row.text || '').trim() && !rejected.has(row.id) && !uncertain.has(row.id)).map(row => row.id);
  return { accepted, wrongLanguageCount: rejectedRows.length, diagnostics,
    alignmentUncertainIds:[...uncertain].filter(id => expected.has(id)),
    alignmentStatus:uncertain.size ? "uncertain" : "not_semantically_verified" };
}
export function acceptedRepairIds(answer, units, targetLang) {
  return repairValidation(answer, units, targetLang).accepted;
}

// Only bounded numeric usage evidence may cross repair progress sanitizers.
export function repairUsageDiagnostic(data = {}) {
  if(data.schema === "tp.conversation/1") return globalThis.TPAuditSchema.sanitizeConversation(data);
  if (data.schema === 'tp.audit/1' && data.event === 'usage_ledger') {
    // Preserve the typed record through both compact trace sanitizers.
    return globalThis.TPAuditSchema.sanitize(data);
  }
  return {
    ...Object.fromEntries(['inputTokens','outputTokens','totalTokens','generationAttempts',
      'beforeRequests','afterRequests','beforeTotalTokens','afterTotalTokens']
      .filter(key => data[key] === null || Number.isFinite(data[key]))
      .map(key => [key, data[key]])),
    ...Object.fromEntries(['replayed','deduplicated']
      .filter(key => typeof data[key] === 'boolean').map(key => [key, data[key]])),
  };
}

// Provider telemetry has its own phase vocabulary; never let it own repair lifecycle.
export function repairRequestProgress(event, data, taskId, unitCount) {
  const diagnostic = repairUsageDiagnostic(data);
  return { phase:'repair_request', event, taskId, unitCount,
    ...(diagnostic.schema ? {diagnostic} : diagnostic) };
}

// Recovery may bypass translateUnits(): count an already observed server receipt
// on first delivery only, before validation/apply; never invoke a provider here.
export async function accountRecoveredRepair(run, task, answer, persist = persistProviderGeneration) {
  const meta = answer?.meta || {}, usage = meta.usage;
  if (!usage?.receiptId && !usage?.generations?.some(g => g?.receiptId)) return;
  const details = failureUsageDetails(meta);
  await persist({ provider: details.provider, model: details.model,
    runtime: isLocalAiTarget(details.provider, details.baseUrl) ? "local" : "cloud",
    engine: "runsextension", operationId: `repair:${run.id}:${task.id}`,
    usage, replayed: true, reason: "repair", requests: 1 });
}

// One pass over a server-owned pool. The workload planner chooses bounded
// chunks and learns only from provider-observed generations in this run.
export async function executeRepairPool({ run, snapshot, executor, signal, getPage, resolveAi,
  checkpointTask, readTask = async () => null, onProgress, applyResults, withCapacity, capabilities,
  api = repairRequest, translate = translateUnits, planner = workloadController,
  receiptPollBudgetMs = 60_000, receiptPollIntervalMs = 1_500,
}) {
  const profiles = new Map();
  const repairRecorders = [];
  const flushRepairEvidence = () => Promise.all(repairRecorders.map(recorder =>
    recorder?.flush?.(Number(capabilities?.aiWireTraceRelay?.timeoutMs) || 1500)));
  async function refresh() { return api(run, '', undefined, { signal }); }
  async function commit(task, answer, page) {
    await accountRecoveredRepair(run, task, answer);
    // Recovery uses source checkpoints, not guesses from the order of aliases.
    let wireToAlias = new Map();
    if (page.ai?.translation_mode === "conversation" &&
        (answer?.meta?.contractDiagnostics?.ignoredUnknownIds || []).length &&
        !Array.isArray(answer?.meta?.alignmentUncertainIds)) {
      const pages = new Map();
      for (const pageId of new Set(task.units.map(unit => unit.pageId))) {
        const source = pageId === page.pageId ? page : await getPage(pageId);
        if (source) pages.set(pageId, source);
      }
      wireToAlias = prepareConversationRepairWire(pages, task.units, true).wireToAlias;
    }
    const validation = repairValidation(answer, task.units, page.targetLang, wireToAlias);
    const accepted = validation.accepted;
    onProgress({ phase: 'repair_validation', taskId: task.id, unitCount: task.units.length,
      acceptedCount: accepted.length, rejectedCount: task.units.length - accepted.length,
      wrongLanguageCount: validation.wrongLanguageCount,
      alignmentUncertainCount: validation.alignmentUncertainIds.length,
      alignmentStatus: validation.alignmentStatus });
    // Save the reply before acknowledging it. A lost ACK can be replayed
    // idempotently without a second provider invocation.
    const acceptedSet = new Set(accepted);
    const expected = new Set(task.units.map(unit => unit.id));
    const wrongLanguageIds = [...new Set(validation.diagnostics
      .filter(row => row.decision === 'reject' && expected.has(row.id) && !acceptedSet.has(row.id))
      .map(row => row.id))];
    await checkpointTask({ id: task.id, state: 'answered', answer, accepted, wrongLanguageIds,
      alignmentUncertainIds: validation.alignmentUncertainIds });
    const next = await api(run, `tasks/${task.id}/complete`, {
      accepted, ...(task.route === 'direct-local' ? { answer } : {}),
    }, { signal });
    await checkpointTask({ id: task.id, state: 'done' });
    return next;
  }

  // Recovery first. Answered cloud tasks are recoverable without invoking AI.
  // A local stream lost with an old worker is unknown, never silently retried.
  for (const task of snapshot.tasks || []) {
    cancelled(signal);
    if (task.state === 'answered') {
      const page = await getPage(task.units[0]?.pageId);
      if (page) snapshot = await commit(task, task.answer, page);
    } else if (task.state === 'running') {
      if (task.route === 'direct-local') {
        const saved = await readTask(task.id);
        const page = await getPage(task.units[0]?.pageId);
        if (saved?.state === 'answered' && saved.answer && page) {
          snapshot = await commit(task, saved.answer, page);
          continue;
        }
        snapshot = await api(run, `tasks/${task.id}/fail`, { reason: 'local_stream_interrupted', unknown: true }, { signal });
      } else {
        // Poll ONLY the durable receipt. Do not POST the translation again. Keep
        // this foreground wake bounded: if the provider receipt is still running,
        // leave it durable and pause the run so the next worker wake can resume.
        // Marking it failed here would either lose a late paid answer or invite an
        // unsafe duplicate provider request.
        const pollBudget = Math.max(0, Number(receiptPollBudgetMs) || 0);
        const pollInterval = Math.max(10, Number(receiptPollIntervalMs) || 1_500);
        const deadline = Date.now() + pollBudget;
        let current = task;
        while (current?.state === 'running' && Date.now() < deadline) {
          const waitMs = Math.min(pollInterval, Math.max(0, deadline - Date.now()));
          if (waitMs > 0) await new Promise((resolve, reject) => {
            let timer;
            const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted','AbortError')); };
            timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, waitMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
          snapshot = await refresh();
          current = snapshot.tasks.find(x => x.id === task.id);
        }
        if (current?.state === 'answered') {
          const page = await getPage(current.units[0]?.pageId);
          if (page) snapshot = await commit(current, current.answer, page);
        } else if (current?.state === 'running') {
          throw Object.assign(new Error('Cloud repair receipt is still running and can be resumed'), {
            code: 'repair_receipt_pending', taskId: task.id, retryable: true,
          });
        }
      }
    } else if (task.state === 'ready') {
      // A claim may have been saved while its response was lost. It was not
      // dispatched, but a new worker must not steal the prior executor claim.
      snapshot = await api(run, `tasks/${task.id}/fail`, { reason: 'repair_claim_interrupted', unknown: true }, { signal });
    }
  }

  // Repair is planned in small adaptive waves. A provider/model group may have
  // at most two newly planned requests in flight before its measured output is
  // fed back into the workload profile. This prevents an initial truncation from
  // pre-allocating dozens of equally oversized repair calls.
  const MAX_PLANS_PER_GROUP_WAVE = 2;
  const groupContexts = new Map();
  const groupCircuits = new Map();
  const capacityCode = value => /ai_workload_budget_insufficient|output_budget_exhausted|invalid_model_output|output_contract|invalid_result_schema/i.test(String(value || ''));

  async function groupContext(groupKey, rows) {
    let value = groupContexts.get(groupKey);
    if (value) return value;
    const first = rows[0];
    const page = await getPage(first?.pageId);
    if (!page) throw Object.assign(new Error('Repair checkpoint missing; no source was resent'), { code: 'repair_checkpoint_missing' });
    const pages = new Map();
    for (const pageId of new Set(rows.map(row => row.pageId))) {
      const captured = pageId === page.pageId ? page : await getPage(pageId);
      if (!captured) throw Object.assign(new Error('Repair checkpoint missing'), {code:'repair_checkpoint_missing'});
      pages.set(pageId, captured);
    }
    const sourceContextForUnits = units => repairSourceContext(pages, units);
    const resolvedAi = await resolveAi(page);
    const conversationRepair = resolvedAi?.translation_mode === "conversation";
    const prepareRepairWire = units => prepareConversationRepairWire(pages, units, conversationRepair);
    let baseAi = { ...resolvedAi, page_context: [], repair_reason: '', conversation: {...(resolvedAi.conversation || {}), branch:'repair'} };
    let workloadSession = profiles.get(groupKey);
    if (!workloadSession) {
      workloadSession = await planner.open({ ai: { ...baseAi, repair_reason: "wrong_target_script" }, route: page.route, sourceLang: page.sourceLang,
        targetLang: page.targetLang, image: pageImageEnabled(baseAi.send_image), phase: "repair", sourceContextForUnits });
      profiles.set(groupKey, workloadSession);
    }
    if (workloadSession.ai) baseAi = { ...workloadSession.ai, repair_reason: '' };
    value = { groupKey, page, baseAi, workloadSession, sourceContextForUnits, conversationRepair, prepareRepairWire,
      orderUnits: units => orderRepairUnits(pages, units) };
    groupContexts.set(groupKey, value);
    return value;
  }

  async function executePlan(plan) {
    cancelled(signal);
    const { page, units, wire, estimate, preflightError, groupKey, workloadSession } = plan;
    const ai = { ...plan.ai };
    const taskId = crypto.randomUUID();
    let task;
    const operationId=`repair:${run.id}:${taskId}`;
    // The browser owns Local repair just as it owns initial generation.
    // Reuse the existing relay; no provider call or new logging endpoint.
    const wireTrace = page.route === 'direct-local' ? createAiWireRecorder({
      enabled: aiWireTraceEnabled(capabilities), operationId, traceId: run.id,
      identity: { recordKind: 'provider_request', attemptKind: 'repair', engine: 'runsextension',
        route: page.route, provider: ai.provider, model: ai.model, batchId: run.batchId, jobId: taskId, origins: wire?.origins },
      apiBase: run.base, relay: capabilities?.aiWireTraceRelay,
    }) : null;
    if (wireTrace) repairRecorders.push(wireTrace);
    await wireTrace?.('units', units.map(u => ({id:u.id,text:u.text})));
    const diagnosticScope={operationId,profileId:workloadSession.key?.slice(0,16),attemptKind:'repair'};
    const reportResult=(observed,error=null,value=null)=>{
      const result=resultDiagnostic(observed,{...diagnosticScope,error});
      diagnosticNote('background/repair/executor.js','translationResult',result,run.id);
      rememberDiagnostic({provider:ai.provider,model:ai.model,operationId,result,layout:value?.meta?.promptLayout,coordination:value?.meta?.cacheCoordination,conversation:value?.meta?.conversation});
    };
    const budget=preflightError ? rejectedBudgetDiagnostic(preflightError,{...diagnosticScope,pageUnits:plan.poolUnits || units.length})
      : budgetDiagnostic({units,estimate,splitReason:plan.splitReason || 'end_of_page'},
      {...diagnosticScope,pageUnits:plan.poolUnits || units.length});
    diagnosticNote('background/repair/executor.js','translationBudget',budget,run.id);
    rememberDiagnostic({provider:ai.provider,model:ai.model,operationId,budget});

    const claim = async () => {
      cancelled(signal);
      task = await api(run, 'claim', { taskId, executor, ids: units.map(u => u.id), route: page.route }, { signal });
      cancelled(signal);
      await checkpointTask({ id: taskId, state: 'claimed', ids: task.ids });
      onProgress({ phase: 'repairing', repaired: snapshot.repaired, unresolved: snapshot.unresolved,
        failedUnits: snapshot.failedUnits, taskId, unitCount: task.units.length });
      return task;
    };

    if (preflightError) {
      await wireTrace?.('terminal', {state:'failed',stage:'input_budget',code:preflightError.code,
        requestDispatched:false,providerAttempts:0,terminal:true});
      reportResult(null,preflightError);
      await claim();
      cancelled(signal);
      await api(run, `tasks/${taskId}/fail`, { reason: preflightError.code || 'workload_preflight_rejected' }, { signal });
      return { groupKey, taskId, outcome: 'preflight', capacityFailure: true, hardFailure: true,
        code: String(preflightError.code || 'workload_preflight_rejected') };
    }

    const workload = { version: 1, predictedOutput: estimate.predictedOutput,
      reasoningReserve: estimate.reasoningReserve, estimatedInput: estimate.estimatedInput,
      completionAvailable: estimate.completionAvailable, limits: estimate.limits };
    let answer;
    try {
      // Capacity is acquired before the durable task claim. The wave may contain
      // many plans, but only scheduler-admitted plans become active claims.
      answer = await withCapacity(page, ai, signal, async () => {
        const active = await claim();
        const repairReason = active.units.some(u => u.reason === 'wrong_language') ? 'wrong_target_script' : '';
        ai.repair_reason = repairReason;
        onProgress({ phase: 'repair_request', event: 'instruction_selected', taskId,
          repairReason: repairReason || 'missing_or_invalid', unitCount: active.units.length });
        cancelled(signal);
        if (page.route === 'direct-local') {
          const start = await api(run, `tasks/${taskId}/start`, { executor }, { signal });
          if (!start.dispatch) throw Object.assign(new Error('Repair task was already dispatched'), { code: 'repair_already_dispatched' });
        }
        await checkpointTask({ id: taskId, state: 'dispatched', ids: active.ids });
        cancelled(signal);
        const activeByAlias = new Set(active.units.map(u => String(u.id)));
        const providerUnits = wire.wireUnits.filter((_, index) => activeByAlias.has(String(wire.taskUnits[index]?.id)));
        return translate(providerUnits, {
          route: page.route, ai: { ...ai, workload }, rate: page.rate, unlimited: page.unlimited,
          targetLang: page.targetLang, sourceLang: page.sourceLang, base: run.base,
          imageDataUri: pageImageEnabled(ai.send_image) ? ai._repairImageDataUri || '' : '',
          batchId: run.batchId, operationId: `repair:${run.id}:${taskId}`,
          jobId: taskId, imageId: '', signal, traceId: run.id, capabilities, wireTrace,
          tabSession: String(page?.ctx?.sessionId || run?.sessionId || ''),
          repairClaim: page.route === 'server' ? { runId: run.id, taskId, token: run.token } : null,
          trace: (event, data) => onProgress(repairRequestProgress(event, data, taskId, active.units.length)),
        });
      });
    } catch (error) {
      await wireTrace?.('terminal', {state:signal?.aborted?'cancelled':'failed',stage:'provider_generation',
        code:String(error?.code || 'repair_generation_failed'), requestDispatched:error?.requestDispatched ?? null,
        providerAttempts:Number.isFinite(error?.providerAttempts)?error.providerAttempts:null,terminal:true});
      if (signal?.aborted) reportResult(null,Object.assign(new Error("Cancelled"),{name:"AbortError"}));
      cancelled(signal);
      // If no claim was created, this was a scheduler/capacity failure before
      // provider ownership. There is no durable task to fail.
      if (!task) throw error;
      let observed = null;
      try {
        observed = workloadSession.observe({ units: task.units || units, error, plan: estimate });
      } catch {}
      reportResult(observed,error);
      const latest = await refresh();
      const latestTask = latest.tasks.find(x => x.id === taskId);
      if (latestTask?.state === 'answered') answer = latestTask.answer;
      else if (['failed', 'unknown', 'done'].includes(latestTask?.state)) return { groupKey, taskId, outcome: observed?.outcome || 'failed',
        billingFailure:isProviderBillingFailure(error), capacityFailure: capacityCode(error?.code) || ['length','structure'].includes(observed?.outcome), code: String(error?.code || '') };
      else if (latestTask?.state === 'running' && page.route === 'server') {
        throw Object.assign(new Error('Cloud repair is still running; its receipt can be resumed'), { code: 'repair_receipt_pending' });
      } else {
        await api(run, `tasks/${taskId}/fail`, {
          reason: String(error.code || 'repair_generation_failed'),
          unknown: !Number(error.generationAttempts || error.providerAttempts || 0),
        }, { signal });
        return { groupKey, taskId, outcome: observed?.outcome || 'failed',
          billingFailure:isProviderBillingFailure(error),
          capacityFailure: capacityCode(error?.code) || ['length','structure'].includes(observed?.outcome),
          code: String(error?.code || 'repair_generation_failed') };

      }
    }
    cancelled(signal);
    if (page.route === "direct-local" && answer && wire?.wireToAlias) {
      const mapId = id => wire.wireToAlias.get(String(id)) || String(id);
      const meta = {...(answer.meta || {})};
      for (const key of ["omittedIds", "declinedIds", "wrongLanguageIds", "alignmentUncertainIds"])
        if (Array.isArray(meta[key])) meta[key] = meta[key].map(mapId);
      answer = {...answer, translations:(answer.translations || []).map(row => ({...row,id:mapId(row.id)})),
        missing:Array.isArray(answer.missing) ? answer.missing.map(mapId) : answer.missing, meta};
    }
    const validation = repairValidation(answer, task.units || units, page.targetLang, wire?.wireToAlias);
    const wrongLanguage = validation.diagnostics.filter(row => row.decision === 'reject').map(row => row.id);
    const acceptedSet = new Set(validation.accepted);
    const missing = (task.units || units).map(row => row.id).filter(id => !acceptedSet.has(id) && !wrongLanguage.includes(id));
    let observed = null;
    try { observed = workloadSession.observe({ units: task.units || units, answer,
      defects: { missing, wrongLanguage }, plan: estimate }); } catch {}
    reportResult(observed,null,answer);
    await wireTrace?.('validation', {acceptedIds:validation.accepted,missingIds:missing,
      wrongLanguageIds:wrongLanguage,alignmentUncertainIds:validation.alignmentUncertainIds,
      alignmentStatus:validation.alignmentStatus,stage:'target_language_validation'});
    await wireTrace?.('terminal', {state:missing.length || wrongLanguage.length ? 'partial' : 'succeeded',
      stage:'target_language_validation', placementStatus:'pending_repair_apply',
      missingIds:missing,wrongLanguageIds:wrongLanguage,translated:validation.accepted.length,
      complete:missing.length===0 && wrongLanguage.length===0,terminal:true});
    await commit(task, answer, page);
    return { groupKey, taskId, outcome: observed?.outcome || (missing.length ? 'structure' : wrongLanguage.length ? 'language' : 'ok'),
      capacityFailure: ['length','structure'].includes(observed?.outcome) || missing.length > 0,
      code: '' };
  }

  async function terminalizeCircuit(groupKey, reason) {
    let rows = (snapshot.pending || []).filter(row => row.groupKey === groupKey);
    while (rows.length) {
      cancelled(signal);
      const context = await groupContext(groupKey, rows);
      const selected = rows.slice(0, 200);
      const taskId = crypto.randomUUID();
      const task = await api(run, 'claim', { taskId, executor, ids: selected.map(row => row.id),
        route: context.page.route }, { signal });
      await checkpointTask({ id: taskId, state: 'claimed', ids: task.ids });
      snapshot = await api(run, `tasks/${taskId}/fail`, { reason, unknown: false }, { signal });
      await checkpointTask({ id: taskId, state: 'done', reason });
      onProgress({ phase: 'repair_circuit_open', groupKey, taskId, unitCount: selected.length,
        failedUnits: snapshot.failedUnits, unresolved: snapshot.unresolved, reason });
      rows = (snapshot.pending || []).filter(row => row.groupKey === groupKey);
    }
  }

  let waveIndex = 0;
  while ((snapshot.pending || []).length) {
    cancelled(signal);
    waveIndex += 1;
    if (waveIndex > 4096) throw Object.assign(new Error('Repair planner did not converge'), { code: 'repair_planner_stalled' });

    // Groups whose provider repeatedly exhausted/invalidated output are closed
    // without another provider call. Claim+fail keeps every unit durable and
    // terminal so the final bulk apply can proceed with earlier successes.
    for (const [groupKey, circuit] of groupCircuits) {
      if (circuit.open && (snapshot.pending || []).some(row => row.groupKey === groupKey))
        await terminalizeCircuit(groupKey, circuit.reason || 'repair_reliability_circuit_open');
    }
    if (!(snapshot.pending || []).length) break;

    const pending = [...snapshot.pending];
    const groupOrder = [...new Set(pending.map(row => row.groupKey))];
    const plans = [];
    for (const groupKey of groupOrder) {
      cancelled(signal);
      const circuit = groupCircuits.get(groupKey);
      if (circuit?.open) continue;
      let remaining = pending.filter(row => row.groupKey === groupKey);
      if (!remaining.length) continue;
      const context = await groupContext(groupKey, remaining);
      if (context.conversationRepair) remaining = context.orderUnits(remaining);
      const plansPerWave = context.conversationRepair ? 1 : MAX_PLANS_PER_GROUP_WAVE;
      for (let planIndex = 0; planIndex < plansPerWave && remaining.length; planIndex++) {
        let chunk, preflightError;
        try { chunk = context.conversationRepair
          ? context.workloadSession.nextRepair(remaining, context.sourceContextForUnits)
          : context.workloadSession.next(remaining, 0); }
        catch (error) { chunk = { units: [remaining[0]], estimate: {} }; preflightError = error; }
        let units = Array.isArray(chunk?.units) && chunk.units.length ? chunk.units : [remaining[0]];
        const remainingIds = new Set(remaining.map(row => row.id));
        units = units.filter(row => remainingIds.has(row?.id));
        if (!units.length) units = [remaining[0]];
        const selected = new Set(units.map(row => row.id));
        const repairReason = units.some(row => row.reason === 'wrong_language') ? 'wrong_target_script' : '';
        const wire = context.prepareRepairWire(units);
        plans.push({ ...context, page: context.page, wire,
          ai: { ...context.baseAi, repair_reason: repairReason, source_context: wire.sourceContext,
            conversation: {...(context.baseAi.conversation || {}), branch:"repair", origins:wire.origins} }, units:wire.taskUnits,
          estimate: chunk?.estimate || {}, splitReason:chunk.splitReason, poolUnits:remaining.length, preflightError });
        remaining = remaining.filter(row => !selected.has(row.id));
        if (preflightError) break;
      }
    }
    if (!plans.length) throw Object.assign(new Error('Repair planner produced no work'), { code: 'repair_planner_stalled' });
    onProgress({ phase: 'repair_wave', waveIndex, taskCount: plans.length,
      failedUnits: snapshot.failedUnits, pendingUnits: pending.length });

    // allSettled prevents an early rejection from abandoning sibling provider
    // calls already admitted by the scheduler. The next wave is not planned
    // until every result in this bounded wave has been measured.
    const settled = await Promise.allSettled(plans.map(executePlan));
    const fatal = settled.find(result => result.status === 'rejected');
    if (fatal) { await flushRepairEvidence(); throw fatal.reason; }
    for (const result of settled.map(item => item.value).filter(Boolean)) {
      const current = groupCircuits.get(result.groupKey) || { consecutive: 0, open: false };
      if (result.capacityFailure) current.reason = result.hardFailure || result.outcome === 'length'
        ? 'repair_capacity_circuit_open' : 'repair_reliability_circuit_open';
      if (result.billingFailure) {
        current.reason = "billing_required";
        current.open = true;
      } else if (result.hardFailure) {
        current.consecutive = 2;
        current.open = true;
      } else if (result.capacityFailure) {
        current.consecutive += 1;
        if (current.consecutive >= 2) current.open = true;
      } else current.consecutive = 0;
      groupCircuits.set(result.groupKey, current);
    }
    await planner.flush?.();
    snapshot = await refresh();
  }
  cancelled(signal);
  snapshot = await refresh();
  if (snapshot.phase !== 'done') throw Object.assign(new Error('Repair tasks are not terminal'), {code:'repair_tasks_pending'});
  // Receipts stay durable per task, but only the complete repair pass reaches DOM.
  cancelled(signal);
  onProgress({ phase: 'applying', repaired: snapshot.repaired, unresolved: snapshot.unresolved,
    failedUnits: snapshot.failedUnits, initialAccepted: snapshot.initialAccepted, unverified: snapshot.unverified });
  await applyResults(snapshot.results || []);
  await flushRepairEvidence();
  cancelled(signal);
  return snapshot;
}
