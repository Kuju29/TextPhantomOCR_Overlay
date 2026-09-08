let settingsEpoch = 0;
let currentBatchId = null;
const inFlight = new Map();
const imageJobOwners = new Map();

function imageJobOwnerKey(identity = {}) {
  const imageKey = String(identity.imageKey || "").trim();
  if (!imageKey) return "";
  return JSON.stringify([
    String(identity.batchId || ""),
    imageKey,
    String(identity.sessionId || ""),
    String(identity.engine || "extension"),
    Number(identity.settingsEpoch) >>> 0,
  ]);
}

// Synchronous compare-and-set performed by enqueue before it yields. The token
// prevents an older completion from releasing a newer legitimate owner.
export function claimImageJob(identity = {}) {
  const key = imageJobOwnerKey(identity);
  if (!key) return { claimed: true, key: "", token: null };
  if (imageJobOwners.has(key)) return { claimed: false, key, token: null };
  const token = Symbol("image-job-owner");
  imageJobOwners.set(key, {
    token,
    tabId: Number(identity.tabId) || 0,
    batchId: String(identity.batchId || ""),
  });
  return { claimed: true, key, token };
}

export function releaseImageJob(claim) {
  if (!claim?.key || !claim?.token) return false;
  const current = imageJobOwners.get(claim.key);
  if (current?.token !== claim.token) return false;
  imageJobOwners.delete(claim.key);
  return true;
}

export function releaseTabImageJobs(tabId) {
  let released = 0;
  for (const [key, owner] of imageJobOwners.entries()) {
    if (owner.tabId !== Number(tabId)) continue;
    imageJobOwners.delete(key);
    released++;
  }
  return released;
}

export function releaseBatchImageJobs(batchId) {
  let released = 0;
  const wanted = String(batchId || "");
  for (const [key, owner] of imageJobOwners.entries()) {
    if (owner.batchId !== wanted) continue;
    imageJobOwners.delete(key);
    released++;
  }
  return released;
}

export function scheduleOwnedImageJob({
  identity,
  isAdmissible,
  schedule,
  work,
  laneManaged = false,
}) {
  const ownership = claimImageJob(identity);
  if (!ownership.claimed) return false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseImageJob(ownership);
  };
  const shouldStart = () => {
    const allowed = isAdmissible();
    if (!allowed) release();
    return allowed;
  };
  schedule(async () => {
    if (!shouldStart()) return;
    try {
      return await work();
    } finally {
      release();
    }
  }, { shouldStart, laneManaged });
  return true;
}

export function bumpSettingsEpoch() {
  settingsEpoch = (settingsEpoch + 1) >>> 0;
  persistSettingsEpoch();
}
export function getSettingsEpoch() {
  return settingsEpoch;
}
export function setCurrentBatchId(id) {
  currentBatchId = id;
}
export function getCurrentBatchId() {
  return currentBatchId;
}

export function beginInFlight(jobId, tabId, batchId = "") {
  const ctrl = new AbortController();
  inFlight.set(jobId, {
    tabId: Number(tabId) || 0,
    batchId: String(batchId || ""),
    ctrl,
  });
  return ctrl;
}

export function endInFlight(jobId) {
  inFlight.delete(jobId);
}

export function abortBatchInFlight(batchId, reason) {
  let stopped = 0;
  for (const [jobId, record] of Array.from(inFlight.entries())) {
    if (record.batchId !== String(batchId || "")) continue;
    inFlight.delete(jobId);
    stopped += 1;
    record.ctrl.abort(reason);
  }
  return stopped;
}

export function abortTabInFlight(tabId, reason, onError = null) {
  let stopped = 0;
  for (const [jobId, record] of Array.from(inFlight.entries())) {
    if (record.tabId !== tabId) continue;
    inFlight.delete(jobId);
    stopped += 1;
    try {
      record.ctrl.abort(reason);
    } catch (error) {
      onError?.(jobId, error);
    }
  }
  return stopped;
}


const EPOCH_KEY = "tpTranslationSettingsEpochV1";
let restoredEpoch = null;
let epochWrites = Promise.resolve();
export function restoreSettingsEpoch() {
  if (!restoredEpoch) restoredEpoch = (async () => {
    const area = globalThis.chrome?.storage?.session;
    if (!area) return;
    const got = await area.get(EPOCH_KEY);
    const stored = got?.[EPOCH_KEY];
    if (Number.isSafeInteger(stored) && stored >= 0) settingsEpoch = (stored + settingsEpoch) >>> 0;
  })().catch(() => {});
  return restoredEpoch;
}
function persistSettingsEpoch() {
  epochWrites = epochWrites.catch(() => {}).then(async () => {
    await restoreSettingsEpoch();
    await globalThis.chrome?.storage?.session?.set({ [EPOCH_KEY]: settingsEpoch });
  }).catch(() => {});
}
