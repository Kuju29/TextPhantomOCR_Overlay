import { persistProviderGeneration, failureUsageDetails } from "../../shared/ai-usage.js";
import { isLocalAiTarget } from "../../shared/constants.js";
import { workloadController } from '../ai/workload-controller.js';
import { translateUnits } from '../ai/translation-service.js';
import { diagnoseTargetScripts } from '../ai/script-diagnostics.js';
import { repairRequest } from './client.js';

const cancelled = signal => {
  if (signal?.aborted) throw new DOMException('Repair cancelled', 'AbortError');
};
export function acceptedRepairIds(answer, units, targetLang) {
  const expected = new Set(units.map(u => u.id));
  const counts = new Map();
  for (const row of answer?.translations || []) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  const rejected = new Set(diagnoseTargetScripts(answer?.translations || [], targetLang, units)
    .filter(x => x.decision === 'reject').map(x => x.id));
  return (answer?.translations || []).filter(row => expected.has(row.id) && counts.get(row.id) === 1 &&
    String(row.text || '').trim() && !rejected.has(row.id)).map(row => row.id);
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

// One pass over a server-owned pool. The current workload planner chooses chunks;
// repair examples are traced separately, not fed back as independent training.
export async function executeRepairPool({ run, snapshot, executor, signal, getPage, resolveAi,
  checkpointTask, readTask = async () => null, onProgress, applyResults, withCapacity, capabilities,
  api = repairRequest, translate = translateUnits, planner = workloadController,
}) {
  const profiles = new Map();
  async function refresh() { return api(run, '', undefined, { signal }); }
  async function commit(task, answer, page) {
    await accountRecoveredRepair(run, task, answer);
    const accepted = acceptedRepairIds(answer, task.units, page.targetLang);
    onProgress({ phase: 'repair_validation', taskId: task.id, unitCount: task.units.length,
      acceptedCount: accepted.length, rejectedCount: task.units.length - accepted.length,
      wrongLanguageCount: diagnoseTargetScripts(answer?.translations || [], page.targetLang, task.units)
        .filter(row => row.decision === 'reject').length });
    // Save the reply before acknowledging it. A lost ACK can be replayed
    // idempotently without a second provider invocation.
    await checkpointTask({ id: task.id, state: 'answered', answer, accepted });
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
        // Poll ONLY the durable receipt. Do not POST the translation again.
        const deadline = Date.now() + 12 * 60 * 1000;
        let current = task;
        while (current?.state === 'running' && Date.now() < deadline) {
          await new Promise((resolve, reject) => {
            const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted','AbortError')); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 1500);
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
          snapshot = await api(run, `tasks/${task.id}/fail`, { reason: 'cloud_receipt_unconfirmed', unknown: true }, { signal });
        }
      }
    } else if (task.state === 'ready') {
      // A claim may have been saved while its response was lost. It was not
      // dispatched, but a new worker must not steal the prior executor claim.
      snapshot = await api(run, `tasks/${task.id}/fail`, { reason: 'repair_claim_interrupted', unknown: true }, { signal });
    }
  }

  // Plan one repair wave from the sealed pending pool, then let the existing
  // provider/model scheduler bound actual parallelism. Planning does not claim
  // server tasks yet, so a worker that dies while waiting for capacity does not
  // strand a large set of ready claims. Every unit belongs to exactly one plan.
  const plans = [];
  const pending = [...(snapshot.pending || [])];
  const groupOrder = [...new Set(pending.map(row => row.groupKey))];
  for (const groupKey of groupOrder) {
    cancelled(signal);
    const rows = pending.filter(row => row.groupKey === groupKey);
    if (!rows.length) continue;
    const first = rows[0];
    const page = await getPage(first.pageId);
    if (!page) throw Object.assign(new Error('Repair checkpoint missing; no source was resent'), { code: 'repair_checkpoint_missing' });
    const resolvedAi = await resolveAi(page);
    let baseAi = { ...resolvedAi, repair_reason: '' };
    let workloadSession = profiles.get(groupKey);
    if (!workloadSession) {
      workloadSession = await planner.open({ ai: baseAi, route: page.route, sourceLang: page.sourceLang,
        targetLang: page.targetLang, image: baseAi.send_image === true });
      profiles.set(groupKey, workloadSession);
    }
    if (workloadSession.ai) baseAi = { ...workloadSession.ai, repair_reason: '' };
    let remaining = [...rows];
    while (remaining.length) {
      cancelled(signal);
      let chunk, preflightError;
      try { chunk = workloadSession.next(remaining, 0); }
      catch (error) { chunk = { units: [remaining[0]], estimate: {} }; preflightError = error; }
      let units = Array.isArray(chunk?.units) && chunk.units.length ? chunk.units : [remaining[0]];
      const remainingIds = new Set(remaining.map(row => row.id));
      units = units.filter(row => remainingIds.has(row?.id));
      if (!units.length) units = [remaining[0]];
      const selected = new Set(units.map(row => row.id));
      const repairReason = units.some(u => u.reason === 'wrong_language') ? 'wrong_target_script' : '';
      plans.push({ page, ai: { ...baseAi, repair_reason: repairReason }, units,
        estimate: chunk?.estimate || {}, preflightError });
      remaining = remaining.filter(row => !selected.has(row.id));
    }
  }

  onProgress({ phase: 'repair_wave', taskCount: plans.length,
    failedUnits: snapshot.failedUnits, pendingUnits: pending.length });

  async function executePlan(plan) {
    cancelled(signal);
    const { page, units, estimate, preflightError } = plan;
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
      return;
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
          imageDataUri: ai.send_image ? ai._repairImageDataUri || '' : '',
          batchId: run.batchId, operationId: `repair:${run.id}:${taskId}`,
          jobId: taskId, imageId: '', signal, traceId: run.id, capabilities,
          repairClaim: page.route === 'server' ? { runId: run.id, taskId, token: run.token } : null,
          trace: (event, data) => onProgress({ phase: 'repair_request', event, taskId,
            unitCount: active.units.length, generationAttempts: data?.generationAttempts }),
        });
      });
    } catch (error) {
      cancelled(signal);
      // If no claim was created, this was a scheduler/capacity failure before
      // provider ownership. There is no durable task to fail.
      if (!task) throw error;
      const latest = await refresh();
      const latestTask = latest.tasks.find(x => x.id === taskId);
      if (latestTask?.state === 'answered') answer = latestTask.answer;
      else if (['failed', 'unknown', 'done'].includes(latestTask?.state)) return;
      else if (latestTask?.state === 'running' && page.route === 'server') {
        throw Object.assign(new Error('Cloud repair is still running; its receipt can be resumed'), { code: 'repair_receipt_pending' });
      } else {
        await api(run, `tasks/${taskId}/fail`, {
          reason: String(error.code || 'repair_generation_failed'),
          unknown: !Number(error.generationAttempts || error.providerAttempts || 0),
        }, { signal });
        return;
      }
    }
    cancelled(signal);
    await commit(task, answer, page);
  }

  // Wait for the complete wave before applying anything. allSettled prevents an
  // early rejection from abandoning sibling provider calls already admitted by
  // the scheduler. A fatal/cancelled task is rethrown only after siblings settle.
  const settled = await Promise.allSettled(plans.map(executePlan));
  const fatal = settled.find(result => result.status === 'rejected');
  if (fatal) throw fatal.reason;
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
