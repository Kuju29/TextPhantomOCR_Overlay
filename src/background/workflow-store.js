// Persists workflow records in IndexedDB so a service-worker restart can tell what was in flight.

import { createLogger } from "../shared/logger.js";
import {
  IN_FLIGHT,
  STATES,
  createWorkflow,
  describeWorkflow,
  isTerminal,
  transition,
} from "../shared/workflow-states.js";

const log = createLogger("SW.workflow");

const DB_NAME = "textphantom";
const DB_VERSION = 1;
const STORE = "workflows";

const TERMINAL_TTL_MS = 10 * 60 * 1000;
const STRANDED_AFTER_MS = 60 * 1000;

let dbPromise = null;

// Opens the database, creating the workflow store and its indexes on first use.
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "workflowId" });
        store.createIndex("state", "state");
        store.createIndex("tabId", "generation.tabId");
        store.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

// Runs a function inside one object-store transaction and resolves with its value when the transaction completes.
function runTransaction(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
      }),
  );
}

// Promisifies one IDBObjectStore call.
function request(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const req = store[method](...args);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Creates and persists a workflow record.
export async function create({ workflowId, itemId, request: req, generation }) {
  const record = createWorkflow({ workflowId, itemId, request: req, generation });
  await runTransaction("readwrite", (store) => store.put(record));
  return record;
}

// Reads one workflow record by id.
export async function get(workflowId) {
  return runTransaction("readonly", (store) => request(store, "get", workflowId));
}

// Moves a workflow to a new state and persists it, returning null when the transition is illegal.
export async function advance(workflowId, to, options = {}) {
  const current = await get(workflowId);
  if (!current) {
    log.warn("advance: no such workflow", { workflowId, to });
    return null;
  }
  const result = transition(current, to, options);
  if (!result.ok) {
    log.warn("advance: refused", { workflowId, from: current.state, to, reason: result.reason });
    return null;
  }
  await runTransaction("readwrite", (store) => store.put(result.record));
  return result.record;
}

// Records extra fields on a workflow without changing its state.
export async function patch(workflowId, fields) {
  const current = await get(workflowId);
  if (!current) return null;
  const next = { ...current, ...fields, updatedAt: Date.now() };
  await runTransaction("readwrite", (store) => store.put(next));
  return next;
}

// Returns every non-terminal workflow, oldest first.
export async function listActive() {
  const all = await runTransaction("readonly", (store) => request(store, "getAll"));
  return (all || [])
    .filter((r) => !isTerminal(r.state))
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

// Returns the workflows whose in-flight request outlived its service worker.
export async function listStranded(now = Date.now()) {
  const active = await listActive();
  return active.filter(
    (r) => IN_FLIGHT.has(r.state) && now - (r.updatedAt || 0) > STRANDED_AFTER_MS,
  );
}

// Cancels every workflow belonging to a tab and returns how many were cancelled.
export async function cancelTab(tabId, reason = "navigation") {
  const active = await listActive();
  const mine = active.filter((r) => r.generation?.tabId === tabId);
  for (const record of mine) {
    const result = transition(record, STATES.CANCELLED, { reason });
    if (result.ok) {
      await runTransaction("readwrite", (store) => store.put(result.record));
    }
  }
  return mine.length;
}

// Deletes terminal records past their TTL and returns how many were removed.
export async function sweep(now = Date.now()) {
  const all = await runTransaction("readonly", (store) => request(store, "getAll"));
  const stale = (all || []).filter(
    (r) => isTerminal(r.state) && now - (r.updatedAt || 0) > TERMINAL_TTL_MS,
  );
  if (!stale.length) return 0;
  await runTransaction("readwrite", (store) => {
    for (const record of stale) store.delete(record.workflowId);
  });
  return stale.length;
}

// Reports the active, stranded and swept workflows when the service worker wakes.
export async function reportOnStartup() {
  try {
    const [active, stranded, swept] = await Promise.all([
      listActive(),
      listStranded(),
      sweep(),
    ]);
    if (active.length || stranded.length) {
      log.info("workflows restored", {
        active: active.length,
        stranded: stranded.length,
        swept,
        examples: stranded.slice(0, 5).map(describeWorkflow),
      });
    }
    return { active, stranded, swept };
  } catch (e) {
    log.warn("workflow store unavailable this session", { error: e?.message || String(e) });
    return { active: [], stranded: [], swept: 0, error: e?.message || String(e) };
  }
}
