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
  return created ? workflowId : "";
}

// Builds a step function that advances a record to one state, doing nothing for an untracked job.
function step(state, { reason = "", operation } = {}) {
  return (workflowId) => {
    if (!workflowId) return Promise.resolve(null);
    return track(`advance:${state}`, () => store.advance(workflowId, state, { reason, operation }));
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

// Records the AI request before it is made, committing the operation id a retry reuses.
export const aiRequested = (workflowId, operation) =>
  step(STATES.AI_REQUESTED, { operation })(workflowId);

// Records that the chosen AI route did not deliver, with its reason.
export const aiDegraded = (workflowId, reason) =>
  step(STATES.AI_DEGRADED, { reason })(workflowId);

// Records that final text exists for every unit of this image.
export const textReady = (workflowId) => step(STATES.TEXT_READY)(workflowId);

// Records that the overlay's markup or canvas exists.
export const renderReady = (workflowId) => step(STATES.RENDER_READY)(workflowId);


// Records the apply request before the overlay is handed to the page.
export const applyRequested = (workflowId, operation) =>
  step(STATES.APPLY_REQUESTED, { operation })(workflowId);

// Records that the page accepted the overlay, the workflow's only success state.
export const applied = (workflowId) => step(STATES.APPLIED)(workflowId);


// Records that the workflow ended unsuccessfully, with its reason.
export const failed = (workflowId, reason) => step(STATES.FAILED, { reason })(workflowId);

// Cancels every workflow belonging to a tab.
export function cancelTab(tabId, reason = "navigation") {
  return track("cancelTab", () => store.cancelTab(tabId, reason));
}

// Reports the workflows that survived a service-worker restart.
export function reportOnStartup() {
  return track("reportOnStartup", () => store.reportOnStartup());
}
