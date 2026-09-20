// Writes one image's workflow record as the job runs, calling the store for each state the job reaches.

import { createLogger } from "../shared/logger.js";
import { STATES } from "../shared/workflow-states.js";
import * as defaultStore from "./workflow-store.js";

const log = createLogger("SW.workflow");

let store = defaultStore;

// Swaps the storage layer, for tests running outside a browser.
export function __setStoreForTests(next) {
  store = next || defaultStore;
  storeBroken = false;
}

let storeBroken = false;
// These states describe work already completed or owned by the live job. Their
// persistence must not delay provider dispatch or showing its result. Actual
// generation receipts / repair dispatch checkpoints are persisted by their owners
// before provider I/O; this tracking store is only reported on startup (not replayed).
// Keep observations ordered per image, including terminal/cancellation writes.
const pending = new Map();
const workflowTabs = new Map();
const cancellingWorkflows = new Set();
const observational = new Set([
  STATES.LENS_READY, STATES.AI_REQUESTED,
  STATES.TEXT_READY, STATES.RENDER_READY, STATES.APPLY_REQUESTED, STATES.APPLIED,
]);

export async function flushTracking() {
  await Promise.all([...pending.values()]);
}

// Reports the first storage failure and turns tracking off for the rest of the session.
function noteStoreFailure(what, error) {
  const msg = error?.message || String(error);
  if (!storeBroken) {
    storeBroken = true;
    log.warn(
      "workflow tracking is off for this session — translating continues, but nothing is being recorded",
      { failedAt: what, error: msg },
    );
  }
  return null;
}

// Returns whether the durable record is still being written.
export const isTracking = () => !storeBroken;

// Runs one store call and turns a storage failure into a null result so tracking cannot break translating.
async function track(what, fn) {
  if (storeBroken) return null;
  try {
    return await fn();
  } catch (e) {
    return noteStoreFailure(what, e);
  }
}

// Opens the record for one image and returns its workflow id, or "" when the store is unavailable.
export async function begin({ itemId, request, generation }) {
  const workflowId = crypto.randomUUID();
  const created = await track("begin", () =>
    store.create({ workflowId, itemId, request, generation }),
  );
  if (created) workflowTabs.set(workflowId, generation?.tabId);
  return created ? workflowId : "";
}

// Builds a step function that advances a record to one state, doing nothing for an untracked job.
function step(state, { reason = "", operation } = {}) {
  return (workflowId) => {
    if (!workflowId || cancellingWorkflows.has(workflowId)) return Promise.resolve(null);
    const previous = pending.get(workflowId) || Promise.resolve();
    const writing = previous.then(() => track(`advance:${state}`, () =>
      store.advance(workflowId, state, { reason, operation }),
    ));
    pending.set(workflowId, writing);
    void writing.then(() => {
      if (pending.get(workflowId) === writing) pending.delete(workflowId);
      if (state === STATES.APPLIED || state === STATES.FAILED || storeBroken)
        workflowTabs.delete(workflowId);
    });
    return observational.has(state) ? Promise.resolve(null) : writing;
  };
}

// Records that the image bytes are in hand.
export const mediaReady = (workflowId) => step(STATES.MEDIA_READY)(workflowId);

// Records the Lens request before it is made, committing the operation id a retry reuses.
export const lensRequested = (workflowId, operation) =>
  step(STATES.LENS_REQUESTED, { operation })(workflowId);

// Records that the text geometry came back.
export const lensReady = (workflowId) => step(STATES.LENS_READY)(workflowId);

// Records that a text attempt was given up on, with its reason.
export const lensDegraded = (workflowId, reason) =>
  step(STATES.LENS_DEGRADED, { reason })(workflowId);

// Observes entry into the live AI route. This diagnostic operation label is not
// the provider idempotency key; its authoritative dispatch receipt stays awaited.
export const aiRequested = (workflowId, operation) =>
  step(STATES.AI_REQUESTED, { operation })(workflowId);

// Records that the chosen AI route did not deliver, with its reason.
export const aiDegraded = (workflowId, reason) =>
  step(STATES.AI_DEGRADED, { reason })(workflowId);

// Records that final text exists for every unit of this image.
export const textReady = (workflowId) => step(STATES.TEXT_READY)(workflowId);

// Records that the overlay's markup or canvas exists.
export const renderReady = (workflowId) =>
  step(STATES.RENDER_READY)(workflowId);

// Records the apply request before the overlay is handed to the page.
export const applyRequested = (workflowId, operation) =>
  step(STATES.APPLY_REQUESTED, { operation })(workflowId);

// Records that the page accepted the overlay, the workflow's only success state.
export const applied = (workflowId) => step(STATES.APPLIED)(workflowId);

// Records that the workflow ended unsuccessfully, with its reason.
export const failed = (workflowId, reason) =>
  step(STATES.FAILED, { reason })(workflowId);

// Cancels every workflow belonging to a tab.
export function cancelTab(tabId, reason = "navigation") {
  // Fence observations now, then drain only this navigation's captured jobs.
  // A new job can start in the SAME tab while these writes are outstanding;
  // it must not be cancelled by the old page's delayed store transaction.
  const own = [...workflowTabs].filter(([, owner]) => owner === tabId).map(([id]) => id);
  const previous = own.map(id => pending.get(id));
  for (const id of own) cancellingWorkflows.add(id);
  const writing = Promise.all(previous).then(() =>
    track("cancelTab", () => store.cancelTab(tabId, reason, own)),
  );
  for (const id of own) pending.set(id, writing);
  return writing.finally(() => {
    for (const id of own) {
      if (pending.get(id) === writing) pending.delete(id);
      cancellingWorkflows.delete(id);
      workflowTabs.delete(id);
    }
  });
}

// Reports the workflows that survived a service-worker restart.
export function reportOnStartup() {
  return track("reportOnStartup", () => store.reportOnStartup());
}
