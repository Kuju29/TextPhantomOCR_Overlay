/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Shared registry of in-flight jobs.
 *
 * Lives in its own module (importing nothing) so both `transport.js` and
 * `jobs.js` can read/write it without a circular import.
 *
 * - `pendingByJob`  : jobId  -> context (tabId, frameId, mode, batchId, ...)
 * - `pendingByImage`: imageId -> context (used to recover a result whose jobId
 *   we lost, e.g. after a WS reconnect)
 */

const STORAGE_KEY = "tpPendingJobsV2";
const PERSIST_DEBOUNCE_MS = 250;

/** @type {Map<string, object>} */
export const pendingByJob = new Map();

/** @type {Map<string, object>} */
export const pendingByImage = new Map();

let persistTimer = null;

function storageArea() {
  return chrome?.storage?.session || chrome?.storage?.local || null;
}

function serializableContext(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  return JSON.parse(JSON.stringify(ctx));
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistPendingJobs().catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

export async function persistPendingJobs() {
  const area = storageArea();
  if (!area) return;
  const records = [];
  for (const [jobId, ctx] of pendingByJob.entries()) {
    records.push({ jobId, ctx: serializableContext(ctx) });
  }
  await area.set({ [STORAGE_KEY]: records });
}

export async function restorePendingJobs() {
  const area = storageArea();
  if (!area) return [];
  const got = await area.get(STORAGE_KEY);
  const records = Array.isArray(got?.[STORAGE_KEY]) ? got[STORAGE_KEY] : [];
  const restored = [];
  for (const rec of records) {
    const jobId = String(rec?.jobId || "").trim();
    const ctx = rec?.ctx && typeof rec.ctx === "object" ? rec.ctx : null;
    if (!jobId || !ctx) continue;
    pendingByJob.set(jobId, ctx);
    const imageId = String(ctx?.metadata?.image_id || "").trim();
    if (imageId) pendingByImage.set(imageId, ctx);
    restored.push(jobId);
  }
  return restored;
}

/** Remember a job and persist it so MV3 service-worker restarts can resume. */
export function rememberJob(jobId, ctx) {
  const id = String(jobId || "").trim();
  if (!id) return;
  pendingByJob.set(id, ctx || {});
  const imageId = String(ctx?.metadata?.image_id || "").trim();
  if (imageId) pendingByImage.set(imageId, ctx || {});
  schedulePersist();
}

/** Look up a job context by id, falling back to the image-id map. */
export function findContext(jobId, imageId) {
  const direct = pendingByJob.get(jobId);
  if (direct) return direct;
  if (imageId) {
    const mapped = pendingByImage.get(imageId);
    return typeof mapped === "string" ? pendingByJob.get(mapped) : mapped || null;
  }
  return null;
}

/** Remove a job (and its image-id entry) from the registry. */
export function removeJob(jobId, imageId) {
  pendingByJob.delete(jobId);
  if (imageId) pendingByImage.delete(imageId);
  schedulePersist();
}
