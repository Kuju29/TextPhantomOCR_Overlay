/**
 * Shared registry of in-flight jobs.
 *
 * Lives in its own module (importing nothing) so both `transport.js` and
 * `jobs.js` can read/write it without a circular import.
 *
 * - `pendingByJob`  : jobId  -> context (tabId, frameId, mode, batchId, ...)
 * - `pendingByImage`: imageId -> context (used to recover a result whose jobId
 *   we lost, e.g. after a WS reconnect)
 */

/** @type {Map<string, object>} */
export const pendingByJob = new Map();

/** @type {Map<string, object>} */
export const pendingByImage = new Map();

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
}
