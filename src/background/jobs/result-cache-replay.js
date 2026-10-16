// Result-cache reuse for one job (extracted from jobs.js processJobInner
// without behaviour change; the trace keeps its "background/jobs.js" source).
import { note as traceNote } from "../../shared/trace.js";
import * as wf from "../workflow-track.js";
import { markBatchInitialAi } from "../batches.js";
import { rememberJob } from "../job-registry.js";
import { repairCoordinator } from "../repair/coordinator.js";
import { resultCache } from "../result-cache.js";

/**
 * Looks the job up in the result cache and, on a hit, delivers the finished
 * result through `handleResult`. Returns true when the job was answered here.
 */
export async function deliverCachedResult({ cacheKey, payload, imageKey, batchId, workflowId,
  traceId, makeContext, handleResult }) {
  const hit = resultCache.get(cacheKey);
  traceNote("background/jobs.js", "resultCache", {
    outcome: hit ? "hit" : "miss", imageId: imageKey, batchId,
    identity: cacheKey.slice(0, cacheKey.indexOf(":")), mode: payload?.mode || "",
    ...(hit ? { imageOmitted: hit.imageOmitted, bytes: hit.bytes, providerCalls: 0, usageRecorded: false } : {}),
  }, traceId);
  if (!hit) return false;
  // Same image + same effective settings: reuse the finished result. No
  // Lens/AI request, no usage receipt or charge, and no Conversation
  // history append (the page never reaches the provider path).
  const jobId = crypto.randomUUID();
  rememberJob(jobId, makeContext({ startedAt: Date.now(), transport: "result_cache", resultCacheHit: true }));
  await wf.lensRequested(workflowId, `result-cache:${jobId}`);
  await wf.lensReady(workflowId);
  await wf.textReady(workflowId);
  if (batchId && imageKey) {
    // Repair has nothing to do for a reused page (a repaired result
    // replaces the cached text when repair applies it).
    await repairCoordinator.capture(batchId, { stage: "skipped", imageId: imageKey, jobId, reason: "result_cache_hit" });
    markBatchInitialAi(batchId, imageKey);
  }
  // The cached result carries the first job's ids; this delivery belongs
  // to the current image/batch.
  hit.result.metadata = { ...(hit.result.metadata || {}), ...(payload.metadata || {}) };
  await handleResult(jobId, hit.result);
  return true;
}
