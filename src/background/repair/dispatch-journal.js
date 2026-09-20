// Small durable Conversation dispatch/result receipts. The immutable page
// source checkpoint lives under its own prepared-page key; this journal keeps
// only dispatch IDs, provider-result deltas and delivery ACK state so those
// transitions never rewrite the OCR/render payload.
export const TRANSLATION_DISPATCH_PREFIX = 'tpTranslationDispatchV1:';
const enc = value => encodeURIComponent(String(value || ''));
export const translationDispatchKey = (runId, pageId) => `${TRANSLATION_DISPATCH_PREFIX}${enc(runId)}:${enc(pageId)}`;

const clone = value => value == null ? value : structuredClone(value);
const normalize = (value, runId = '', pageId = '', now = Date.now) => {
  if (!value) return {version:2,runId:String(runId),pageId:String(pageId),createdAt:now(),dispatches:[],
    accepted:[],failures:[],blocked:[],delivered:false,phase:'prepared'};
  const dispatches = Array.isArray(value.dispatches) ? value.dispatches.filter(Boolean)
    : value.evidence ? [value.evidence] : [];
  return {version:2,runId:String(value.runId || runId),pageId:String(value.pageId || pageId),
    createdAt:Number(value.createdAt || now()),dispatches,
    accepted:Array.isArray(value.accepted)?value.accepted:[],failures:Array.isArray(value.failures)?value.failures:[],
    blocked:Array.isArray(value.blocked)?value.blocked:[],delivered:value.delivered===true,phase:String(value.phase || 'prepared')};
};

export function createDispatchJournal({area = () => globalThis.chrome?.storage?.session, now = Date.now} = {}) {
  const cache = new Map();
  const requireArea = () => {
    const storage = area();
    if (!storage) throw Object.assign(new Error('Translation dispatch storage is unavailable'), {code:'session_storage_unavailable'});
    return storage;
  };
  async function read(key, runId, pageId) {
    if (cache.has(key)) return normalize(cache.get(key),runId,pageId,now);
    const value = (await requireArea().get(key))?.[key] || null;
    if (value) cache.set(key, value);
    return normalize(value,runId,pageId,now);
  }
  async function write(key, next) {
    cache.set(key, next);
    try { await requireArea().set({[key]: next}); }
    catch (error) {
      // Storage remains the source of truth after a failed write. Dropping the
      // cache forces the next read to recover the last durable receipt instead
      // of exposing a synthesized/half-written value.
      cache.delete(key);
      throw error;
    }
    return clone(next);
  }
  async function record(runId, pageId, evidence) {
    const key = translationDispatchKey(runId, pageId);
    // The first dispatch for a run/page is owner-exclusive; avoid a storage
    // read on the provider hot path. Hard-split follow-ups reuse the cache.
    const previous = cache.has(key) ? normalize(cache.get(key),runId,pageId,now)
      : normalize(null,runId,pageId,now);
    const dispatches = [...previous.dispatches];
    const prior = dispatches.find(row => row?.operationId === evidence?.operationId);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(evidence))
        throw Object.assign(new Error('Conversation dispatch evidence conflict'), {code:'source_evidence_conflict'});
    } else if (evidence) dispatches.push(clone(evidence));
    return write(key,{...previous,version:2,dispatches,phase:'translating'});
  }
  async function checkpointResult(runId, pageId, data = {}) {
    const key = translationDispatchKey(runId, pageId);
    const previous = await read(key, runId, pageId);
    if (!previous.dispatches.length)
      throw Object.assign(new Error('Conversation result has no durable dispatch receipt'), {code:'conversation_dispatch_receipt_missing'});
    const accepted = new Map(previous.accepted.map(row => [String(row.id), row]));
    for (const row of data.accepted || []) if (!accepted.has(String(row.id)))
      accepted.set(String(row.id), {id:String(row.id),text:String(row.text || '')});
    const failures = new Map(previous.failures.map(row => [String(row.id), row]));
    for (const row of data.failures || []) if (!accepted.has(String(row.id))) {
      const id=String(row.id), prior=failures.get(id);
      if (!prior || row.reason !== 'missing') failures.set(id,{id,reason:String(row.reason || 'missing')});
    }
    for (const id of accepted.keys()) failures.delete(id);
    const blocked=[...new Set([...previous.blocked.map(String),...(data.blocked || []).map(String)])];
    const phase=data.stage==='finished'?'finished':'progress';
    return write(key,{...previous,version:2,accepted:[...accepted.values()],failures:[...failures.values()],blocked,phase});
  }
  async function markDelivered(runId, pageId, delivered = true) {
    const key = translationDispatchKey(runId, pageId);
    const previous = await read(key, runId, pageId);
    return write(key,{...previous,version:2,delivered:delivered===true});
  }
  async function get(runId, pageId) {
    const key = translationDispatchKey(runId, pageId);
    const value = cache.has(key) ? cache.get(key) : (await requireArea().get(key))?.[key] || null;
    if (value) cache.set(key, value);
    if (!value) return null;
    const normalized=normalize(value,runId,pageId,now);
    // Preserve the old convenience field for callers/tests while v2 keeps all
    // dispatches for hard-split pages.
    normalized.evidence=normalized.dispatches.at(-1) || null;
    return clone(normalized);
  }
  async function remove(runId, pageId) {
    const key = translationDispatchKey(runId, pageId);
    cache.delete(key);
    await requireArea().remove?.(key);
  }
  async function listRun(runId) {
    const prefix = `${TRANSLATION_DISPATCH_PREFIX}${enc(runId)}:`;
    const all = await requireArea().get(null);
    const rows = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(prefix)) continue;
      const normalized=normalize(value,runId,value?.pageId,now);
      if (!normalized.dispatches.length && !normalized.accepted.length && !normalized.failures.length && !normalized.blocked.length && !normalized.delivered) continue;
      cache.set(key, normalized);
      normalized.evidence=normalized.dispatches.at(-1) || null;
      rows.push(clone(normalized));
    }
    return rows;
  }
  async function clearRun(runId) {
    const prefix = `${TRANSLATION_DISPATCH_PREFIX}${enc(runId)}:`;
    const all = await requireArea().get(null);
    const keys = Object.keys(all || {}).filter(key => key.startsWith(prefix));
    for (const key of keys) cache.delete(key);
    if (keys.length) await requireArea().remove?.(keys);
  }
  return {record,checkpointResult,markDelivered,get,remove,listRun,clearRun};
}

export const conversationDispatchJournal = createDispatchJournal();
