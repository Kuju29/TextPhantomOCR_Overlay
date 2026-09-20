import { getBatch } from "../batches.js";
import { pendingByJob } from "../job-registry.js";
import { getTabSessionId } from "../tab-sessions.js";
import { cancelJobsViaRest } from "../transports/cancel.js";

/** Propagate a batch discard to the server owner immediately. */
export function cancelBatchProviderViaRest(batchId) {
  const bid = String(batchId || "").trim();
  if (!bid) return;
  const jobIds = [];
  let session = "";
  for (const [jobId, ctx] of pendingByJob.entries()) {
    const ownedBatch = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
    if (ownedBatch !== bid) continue;
    jobIds.push(String(jobId));
    if (!session) session = String(ctx?.sessionId || "").trim();
  }
  const tabId = getBatch(bid)?.tabId;
  if (!session && Number.isFinite(tabId))
    session = String(getTabSessionId(tabId) || "").trim();
  void cancelJobsViaRest({ jobIds, batchId: bid, session });
}
