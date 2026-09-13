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
export function repairValidation(answer, units, targetLang) {
  const expected = new Set(units.map(u => u.id));
  const counts = new Map();
  for (const row of answer?.translations || []) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const diagnostics = diagnoseTargetScripts(answer?.translations || [], targetLang, units);
  const rejectedRows = diagnostics.filter(x => x.decision === 'reject');
  const rejected = new Set(rejectedRows.map(x => x.id));
  const accepted = (answer?.translations || []).filter(row => expected.has(row.id) && counts.get(row.id) === 1 &&
    String(row.text || '').trim() && !rejected.has(row.id)).map(row => row.id);
  return { accepted, wrongLanguageCount: rejectedRows.length, diagnostics };
}
export function acceptedRepairIds(answer, units, targetLang) {
  return repairValidation(answer, units, targetLang).accepted;
}

// Only bounded numeric usage evidence may cross repair progress sanitizers.
export function repairUsageDiagnostic(data = {}) {
  return {
    ...Object.fromEntries(['inputTokens','outputTokens','totalTokens','generationAttempts',
      'beforeRequests','afterRequests','beforeTotalTokens','afterTotalTokens']
      .filter(key => data[key] === null || Number.isFinite(data[key]))
      .map(key => [key, data[key]])),
    ...Object.fromEntries(['replayed','deduplicated']
      .filter(key => typeof data[key] === 'boolean').map(key => [key, data[key]])),
  };
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
  async function refresh() { return api(run, '', undefined, { signal }); }
  async function commit(task, answer, page) {
    await accountRecoveredRepair(run, task, answer);
    const validation = repairValidation(answer, task.units, page.targetLang);
    const accepted = validation.accepted;
    onProgress({ phase: 'repair_validation', taskId: task.id, unitCount: task.units.length,
      acceptedCount: accepted.length, rejectedCount: task.units.length - accepted.length,
      wrongLanguageCount: validation.wrongLanguageCount });
    // Save the reply before acknowledging it. A lost ACK can be replayed
    // idempotently without a second provider invocation.
    const acceptedSet = new Set(accepted);
    const expected = new Set(task.units.map(unit => unit.id));
    const wrongLanguageIds = [...new Set(validation.diagnostics
      .filter(row => row.decision === 'reject' && expected.has(row.id) && !acceptedSet.has(row.id))
      .map(row => row.id))];
    await checkpointTask({ id: task.id, state: 'answered', answer, accepted, wrongLanguageIds });
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
    const resolvedAi = await resolveAi(page);
    let baseAi = { ...resolvedAi, repair_reason: '' };
    let workloadSession = profiles.get(groupKey);
    if (!workloadSession) {
      workloadSession = await planner.open({ ai: baseAi, route: page.route, sourceLang: page.sourceLang,
        targetLang: page.targetLang, image: pageImageEnabled(baseAi.send_image) });
      profiles.set(groupKey, workloadSession);
    }
    if (workloadSession.ai) baseAi = { ...workloadSession.ai, repair_reason: '' };
    value = { groupKey, page, baseAi, workloadSession };
    groupContexts.set(groupKey, value);
    return value;
  }

  async function executePlan(plan) {
    cancelled(signal);
    const { page, units, estimate, preflightError, groupKey, workloadSession } = plan;
    const ai = { ...plan.ai };
    const taskId = crypto.randomUUID();
    let task;

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
        return translate(active.units.map(u => ({ id: u.id, text: u.text })), {
          route: page.route, ai: { ...ai, workload }, rate: page.rate, unlimited: page.unlimited,
          targetLang: page.targetLang, sourceLang: page.sourceLang, base: run.base,
          imageDataUri: pageImageEnabled(ai.send_image) ? ai._repairImageDataUri || '' : '',
          batchId: run.batchId, operationId: `repair:${run.id}:${taskId}`,
          jobId: taskId, imageId: '', signal, traceId: run.id, capabilities,
          tabSession: String(page?.ctx?.sessionId || run?.sessionId || ''),
          repairClaim: page.route === 'server' ? { runId: run.id, taskId, token: run.token } : null,
          trace: (event, data) => onProgress({ phase: 'repair_request', event, taskId,
            unitCount: active.units.length, ...repairUsageDiagnostic(data) }),
        });
      });
    } catch (error) {
      cancelled(signal);
      // If no claim was created, this was a scheduler/capacity failure before
      // provider ownership. There is no durable task to fail.
      if (!task) throw error;
      let observed = null;
      try {
        observed = workloadSession.observe({ units: task.units || units, error, plan: estimate });
      } catch {}
      const latest = await refresh();
      const latestTask = latest.tasks.find(x => x.id === taskId);
      if (latestTask?.state === 'answered') answer = latestTask.answer;
      else if (['failed', 'unknown', 'done'].includes(latestTask?.state)) return { groupKey, taskId, outcome: observed?.outcome || 'failed',
        capacityFailure: capacityCode(error?.code) || ['length','structure'].includes(observed?.outcome), code: String(error?.code || '') };
      else if (latestTask?.state === 'running' && page.route === 'server') {
        throw Object.assign(new Error('Cloud repair is still running; its receipt can be resumed'), { code: 'repair_receipt_pending' });
      } else {
        await api(run, `tasks/${taskId}/fail`, {
          reason: String(error.code || 'repair_generation_failed'),
          unknown: !Number(error.generationAttempts || error.providerAttempts || 0),
        }, { signal });
        return { groupKey, taskId, outcome: observed?.outcome || 'failed',
          capacityFailure: capacityCode(error?.code) || ['length','structure'].includes(observed?.outcome),
          code: String(error?.code || 'repair_generation_failed') };

      }
    }
    cancelled(signal);
    const validation = repairValidation(answer, task.units || units, page.targetLang);
    const wrongLanguage = validation.diagnostics.filter(row => row.decision === 'reject').map(row => row.id);
    const acceptedSet = new Set(validation.accepted);
    const missing = (task.units || units).map(row => row.id).filter(id => !acceptedSet.has(id) && !wrongLanguage.includes(id));
    let observed = null;
    try { observed = workloadSession.observe({ units: task.units || units, answer,
      defects: { missing, wrongLanguage }, plan: estimate }); } catch {}
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
        await terminalizeCircuit(groupKey, 'repair_capacity_circuit_open');
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
      for (let planIndex = 0; planIndex < MAX_PLANS_PER_GROUP_WAVE && remaining.length; planIndex++) {
        let chunk, preflightError;
        try { chunk = context.workloadSession.next(remaining, 0); }
        catch (error) { chunk = { units: [remaining[0]], estimate: {} }; preflightError = error; }
        let units = Array.isArray(chunk?.units) && chunk.units.length ? chunk.units : [remaining[0]];
        const remainingIds = new Set(remaining.map(row => row.id));
        units = units.filter(row => remainingIds.has(row?.id));
        if (!units.length) units = [remaining[0]];
        const selected = new Set(units.map(row => row.id));
        const repairReason = units.some(row => row.reason === 'wrong_language') ? 'wrong_target_script' : '';
        plans.push({ ...context, page: context.page,
          ai: { ...context.baseAi, repair_reason: repairReason }, units,
          estimate: chunk?.estimate || {}, preflightError });
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
    if (fatal) throw fatal.reason;
    for (const result of settled.map(item => item.value).filter(Boolean)) {
      const current = groupCircuits.get(result.groupKey) || { consecutive: 0, open: false };
      if (result.hardFailure) {
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
  cancelled(signal);
  return snapshot;
}
