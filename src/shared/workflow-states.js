/**
 *
 * The workflow state machine.
 *
 * Pure: no storage, no chrome.*, no time. Everything here can be reasoned
 * about and tested directly, which matters because this is the part that
 * decides whether a job is still alive after the service worker was shut down
 * mid-flight.
 *
 * Two things the previous design could not express, and this one must:
 *
 * 1. **Why a job took the slow path.** `LENS_DEGRADED` is a state, not a flag,
 *    and every entry into it records a reason and bumps an attempt counter. A
 *    system where the fast path quietly stopped working looks completely
 *    healthy right up until the bill arrives.
 *
 * 2. **The difference between "not finished" and "finished elsewhere".** A
 *    result that arrives for a page the user has already scrolled past, or for
 *    an image that has since been replaced, must be dropped — not applied over
 *    whatever is on screen now. That is what `cancelEpoch` is for.
 */

export const STATES = {
  CREATED: "CREATED",
  MEDIA_READY: "MEDIA_READY",
  LENS_REQUESTED: "LENS_REQUESTED",
  LENS_READY: "LENS_READY",
  LENS_DEGRADED: "LENS_DEGRADED",
  AI_REQUESTED: "AI_REQUESTED",
  AI_DEGRADED: "AI_DEGRADED",
  TEXT_READY: "TEXT_READY",
  RENDER_READY: "RENDER_READY",
  RENDER_DEGRADED: "RENDER_DEGRADED",
  APPLY_REQUESTED: "APPLY_REQUESTED",
  APPLY_PENDING: "APPLY_PENDING",
  APPLIED: "APPLIED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
};

/** States from which nothing further happens. */
export const TERMINAL = new Set([
  STATES.APPLIED,
  STATES.FAILED,
  STATES.CANCELLED,
  STATES.EXPIRED,
]);

/**
 * States that mean "a request is in flight".
 *
 * These are the ones a service-worker restart strands: the request was sent,
 * the answer never arrived, and nothing will ever ask again unless something
 * looks for them. The reaper does exactly that.
 */
export const IN_FLIGHT = new Set([
  STATES.LENS_REQUESTED,
  STATES.AI_REQUESTED,
  STATES.APPLY_REQUESTED,
]);

/** Every legal move. Anything not listed here is a bug, not a variation. */
const TRANSITIONS = {
  [STATES.CREATED]: [STATES.MEDIA_READY, STATES.FAILED, STATES.CANCELLED],
  [STATES.MEDIA_READY]: [STATES.LENS_REQUESTED, STATES.FAILED, STATES.CANCELLED],
  [STATES.LENS_REQUESTED]: [
    STATES.LENS_READY,
    STATES.LENS_DEGRADED,
    STATES.FAILED,
    STATES.CANCELLED,
  ],
  // Degraded is not a dead end: it re-enters the request with a different
  // adapter pinned. The attempt counter is what stops that being a loop.
  [STATES.LENS_DEGRADED]: [STATES.LENS_REQUESTED, STATES.FAILED, STATES.CANCELLED],
  [STATES.LENS_READY]: [
    STATES.TEXT_READY,
    STATES.AI_REQUESTED,
    STATES.FAILED,
    STATES.CANCELLED,
  ],
  [STATES.AI_REQUESTED]: [
    STATES.TEXT_READY,
    STATES.AI_DEGRADED,
    STATES.FAILED,
    STATES.CANCELLED,
  ],
  [STATES.AI_DEGRADED]: [STATES.AI_REQUESTED, STATES.FAILED, STATES.CANCELLED],
  [STATES.TEXT_READY]: [STATES.RENDER_READY, STATES.RENDER_DEGRADED, STATES.FAILED, STATES.CANCELLED],
  [STATES.RENDER_DEGRADED]: [STATES.RENDER_READY, STATES.FAILED, STATES.CANCELLED],
  [STATES.RENDER_READY]: [STATES.APPLY_REQUESTED, STATES.FAILED, STATES.CANCELLED],
  [STATES.APPLY_REQUESTED]: [
    STATES.APPLIED,
    STATES.APPLY_PENDING,
    STATES.FAILED,
    STATES.CANCELLED,
  ],
  // The target left the DOM (a virtualised reader recycled the node). The work
  // is finished and valid; it just has nowhere to go yet.
  [STATES.APPLY_PENDING]: [STATES.APPLY_REQUESTED, STATES.EXPIRED, STATES.CANCELLED],
  [STATES.APPLIED]: [],
  [STATES.FAILED]: [],
  [STATES.CANCELLED]: [],
  [STATES.EXPIRED]: [],
};

/** Stage a `*_DEGRADED` state belongs to, for attempt accounting. */
const DEGRADED_STAGE = {
  [STATES.LENS_DEGRADED]: "lens",
  [STATES.AI_DEGRADED]: "ai",
  [STATES.RENDER_DEGRADED]: "render",
};

/** How many times one stage may degrade before the job is called failed. */
export const MAX_STAGE_ATTEMPTS = 3;

export function isTerminal(state) {
  return TERMINAL.has(state);
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Legal next states — exported so a UI can explain where a job can go. */
export function allowedFrom(state) {
  return [...(TRANSITIONS[state] || [])];
}

/** A fresh record. `cancelEpoch` is stamped at creation, never derived later. */
export function createWorkflow({
  workflowId,
  itemId,
  request,
  generation,
  now = Date.now(),
}) {
  return {
    schemaVersion: 1,
    workflowId,
    itemId,
    state: STATES.CREATED,
    stateVersion: 0,
    createdAt: now,
    updatedAt: now,
    request: { ...request },
    generation: { ...generation },
    adapters: {},
    degradations: [],
    operation: null,
  };
}

/**
 * Apply a transition, or explain why it cannot happen.
 *
 * Returns a NEW record — callers persist the result rather than mutating a
 * record another task may be reading.
 *
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
export function transition(record, to, { reason = "", now = Date.now(), operation } = {}) {
  const from = record?.state;
  if (!from) return { ok: false, reason: "record has no state" };
  if (from === to) return { ok: false, reason: `already in ${to}` };
  if (!canTransition(from, to)) {
    return { ok: false, reason: `illegal transition ${from} -> ${to}` };
  }

  const next = {
    ...record,
    state: to,
    stateVersion: (record.stateVersion || 0) + 1,
    updatedAt: now,
    adapters: { ...record.adapters },
    degradations: [...record.degradations],
  };

  const stage = DEGRADED_STAGE[to];
  if (stage) {
    const attempts = (next.adapters[stage]?.attempts || 0) + 1;
    next.adapters[stage] = { ...(next.adapters[stage] || {}), attempts };
    // The reason is stored, not logged and forgotten. A page that degraded
    // once is noise; a fleet that degrades every time is an outage, and only
    // the stored reason can tell those apart after the fact.
    next.degradations.push({ stage, reason: String(reason || "unspecified"), at: now, attempts });
  }

  // Write-ahead: the operation id is committed BEFORE the call it identifies,
  // so a retry after a crash reuses it instead of paying twice.
  if (operation !== undefined) next.operation = operation;
  if (IN_FLIGHT.has(to) && operation === undefined) {
    return { ok: false, reason: `${to} requires an operation id` };
  }
  if (!IN_FLIGHT.has(to)) next.operation = null;

  return { ok: true, record: next };
}

/** Whether a stage has degraded too often to be worth another attempt. */
export function stageExhausted(record, stage, max = MAX_STAGE_ATTEMPTS) {
  return (record?.adapters?.[stage]?.attempts || 0) >= max;
}

/**
 * Whether a record still belongs to the world it was created in.
 *
 * A result for a page the user navigated away from, or for an image slot a
 * virtualised reader has since re-used, must be dropped. Applying it would
 * paint a translation of one picture over a different one — which looks like a
 * translation bug and is not one.
 */
export function isCurrent(record, generation) {
  const g = record?.generation || {};
  if (!generation) return false;
  if (g.pageInstanceId && g.pageInstanceId !== generation.pageInstanceId) return false;
  if (g.targetKey && generation.targetKey && g.targetKey !== generation.targetKey) return false;
  if (
    Number.isFinite(g.targetRevision) &&
    Number.isFinite(generation.targetRevision) &&
    g.targetRevision !== generation.targetRevision
  ) {
    return false;
  }
  if ((generation.cancelEpoch || 0) > (g.cancelEpoch || 0)) return false;
  return true;
}

/** Human-readable one-liner for logs and the popup. */
export function describeWorkflow(record) {
  return {
    workflowId: record?.workflowId,
    itemId: record?.itemId,
    state: record?.state,
    v: record?.stateVersion,
    degradations: (record?.degradations || []).map((d) => `${d.stage}:${d.reason}`),
    ageMs: record?.updatedAt ? Date.now() - record.updatedAt : null,
  };
}
