// Shared registry of in-flight jobs, indexed by job id and by image id, persisted across service-worker restarts.

// Imports nothing so transport.js and jobs.js can both use it without a circular import.

const STORAGE_KEY = "tpPendingJobsV2";
const PERSIST_DEBOUNCE_MS = 250;

// jobId -> job context.
export const pendingByJob = new Map();

// imageId -> job context, used to recover a result whose job id was lost.
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

// Writes the pending-job contexts to session storage.
export async function persistPendingJobs() {
  const area = storageArea();
  if (!area) return;
  const records = [];
  for (const [jobId, ctx] of pendingByJob.entries()) {
    records.push({ jobId, ctx: serializableContext(ctx) });
  }
  await area.set({ [STORAGE_KEY]: records });
}

// Reloads persisted job contexts into the registry and returns the restored job ids.
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

// Records a job's context in the registry and schedules a persist.
export function rememberJob(jobId, ctx) {
  const id = String(jobId || "").trim();
  if (!id) return;
  pendingByJob.set(id, ctx || {});
  const imageId = String(ctx?.metadata?.image_id || "").trim();
  if (imageId) pendingByImage.set(imageId, ctx || {});
  schedulePersist();
}

// Looks up a job context by job id, falling back to the image-id map.
export function findContext(jobId, imageId) {
  const direct = pendingByJob.get(jobId);
  if (direct) return direct;
  if (imageId) {
    const mapped = pendingByImage.get(imageId);
    return typeof mapped === "string" ? pendingByJob.get(mapped) : mapped || null;
  }
  return null;
}

// Removes a job and its image-id entry from the registry.
export function removeJob(jobId, imageId) {
  pendingByJob.delete(jobId);
  if (imageId) pendingByImage.delete(imageId);
  schedulePersist();
}
