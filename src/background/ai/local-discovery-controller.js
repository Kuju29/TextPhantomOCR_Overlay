import { discoverLocalModels } from '../../shared/ai/direct-local/model-discovery.js';
import { normalizeLocalAiAdapter, serializeLocalAiAdapter } from '../../shared/ai/providers/local-registry.js';
import { buildLocalVerificationSnapshot, normalizeLocalConnectionIdentity, LOCAL_CAPABILITY_SNAPSHOTS_KEY } from '../../shared/ai/direct-local/verification-snapshot.js';
import { normalizeReasoningPreference } from '../../shared/reasoning-preference.js';

// Discovery is worker-owned: closing/reopening a popup joins the existing check.
// Discovery proves runtime/model availability from model metadata. It must never
// run a dummy generation merely to populate the model picker.
export function createLocalDiscoveryController({
  discover = discoverLocalModels, emit = () => {}, publish = () => {},
  read = async () => ({}), write = async () => {}, now = Date.now,
  randomId = () => crypto.randomUUID(), keepAlive = () => {},
  probeTimeoutMs = 5_000,
} = {}) {
  const active = new Map(), owners = new Map(), acknowledgements = new Set();
  let writes = Promise.resolve();
  const log = (entry, reason, extra = {}) => emit({ schema: 'tp.audit/1', event: 'local_discovery',
    operationId: entry.id, route: 'direct-local', reason, elapsedMs: Math.max(0, now() - entry.started), ...extra });
  const notify = (entry, progress) => {
    entry.progress = progress;
    for (const requestId of entry.requests) {
      try { publish({ type: 'TP_LOCAL_AI_DISCOVERY_PROGRESS', requestId, discoveryId: entry.id, ...progress }); } catch {}
    }
  };
  const persist = (entry, result) => {
    const key = normalizeLocalConnectionIdentity(entry.provider, entry.adapter.baseUrl);
    const snapshot = result ? buildLocalVerificationSnapshot({ provider: entry.provider, endpoint: entry.adapter.baseUrl,
      models: result.models, capability: result.capability, verification: result.selectedModelVerification,
      thinking: entry.thinking, checkedAt: result.selectedModelVerification?.checkedAt || result.checkedAt }) : null;
    writes = writes.catch(() => {}).then(async () => {
      const stored = await read([LOCAL_CAPABILITY_SNAPSHOTS_KEY]);
      if (owners.get(key) !== entry.id) return;
      const records = { ...(stored?.[LOCAL_CAPABILITY_SNAPSHOTS_KEY] || {}) };
      if (snapshot) records[key] = snapshot; else delete records[key];
      const keys = Object.keys(records).sort((a,b) => (records[b]?.checkedAt || 0) - (records[a]?.checkedAt || 0));
      for (const stale of keys.slice(16)) delete records[stale];
      await write({ [LOCAL_CAPABILITY_SNAPSHOTS_KEY]: records });
      log(entry, 'snapshot_written', { connectionStage: 'save_snapshot' });
    }).catch(() => log(entry, 'persistence_failed', { connectionStage: 'save_snapshot' }));
  };
  const run = async (message = {}) => {
    const provider = String(message.provider || message.adapter?.protocol || 'local').toLowerCase();
    const adapter = normalizeLocalAiAdapter(message.adapter || {}, { provider });
    const model = String(message.model || '').trim(), thinking = normalizeReasoningPreference(message.thinking, 'minimum');
    // Model metadata/availability is independent from the user's reasoning preference.
    // Do not repeat the same Local runtime check when only Think changes.
    const key = JSON.stringify([provider, serializeLocalAiAdapter(adapter), model]);
    const requestId = String(message.discoveryId || randomId());
    const existing = active.get(key);
    if (existing) {
      existing.requests.add(requestId);
      log(existing, 'discovery_joined', { requestId, connectionStage: 'list_models' });
      if (existing.progress) notify(existing, existing.progress);
      return existing.promise;
    }
    const entry = { id: requestId, provider, adapter, model, thinking, started: now(), requests: new Set([requestId]), progress: null };
    active.set(key, entry);
    owners.set(normalizeLocalConnectionIdentity(provider, adapter.baseUrl), entry.id);
    log(entry, 'initial', { requestId, connectionStage: 'list_models' });
    const lease = setInterval(() => { try { keepAlive(); } catch {} }, 20_000);
    lease.unref?.();
    entry.promise = Promise.resolve().then(() => discover(adapter, {
      provider, model, thinking, verifySelected: true, probeTimeoutMs,
      onProgress: progress => {
        notify(entry, progress);
        log(entry, progress.stage === 'models_loaded' ? 'models_loaded' : 'metadata_check_started', {
          connectionStage: progress.stage === 'models_loaded' ? 'list_models' : 'model_metadata',
          counts: { count: progress.models?.length ?? null }, metadataOnly: true,
        });
      },
    })).then(result => {
      const verification = result.selectedModelVerification || {};
      const checkedAt = verification.checkedAt || now();
      const response = { ...result, discoveryId: entry.id, snapshotOwner: 'worker', checkedAt };
      log(entry, 'finished', { connectionStage: 'result', verificationStatus: verification.status || 'not_tested',
        ready: verification.status === 'passed', metadataOnly: verification.metadataOnly === true,
        counts: { count: result.models?.length || 0 },
        timing: { metadataMs: verification.elapsedMs ?? null } });
      persist(entry, response);
      return response;
    }).catch(error => {
      const code = String(error?.code || 'local_ai_discovery_failed');
      log(entry, 'failed', { connectionStage: 'result', errorCode: code, ready: false,
        retryable: ['local_ai_unreachable','local_ai_timeout'].includes(code) });
      persist(entry, null);
      return { ok: false, snapshotOwner: 'worker', discoveryId: entry.id, code, error: String(error?.message || 'Local AI discovery failed') };
    }).finally(() => { clearInterval(lease); if (active.get(key) === entry) active.delete(key); });
    return entry.promise;
  };
  const acknowledge = message => {
    const key = `${message.discoveryId}|${message.requestId}`;
    if (acknowledgements.has(key)) return;
    acknowledgements.add(key); while (acknowledgements.size > 64) acknowledgements.delete(acknowledgements.values().next().value);
    emit({ schema: 'tp.audit/1', event: 'local_discovery', operationId: message.discoveryId,
      requestId: message.requestId, reason: message.applied ? 'ui_applied' : 'stale_discard',
      connectionStage: 'ui_apply', ready: message.ready === true });
  };
  return { run, acknowledge, flush: () => writes, activeCount: () => active.size };
}
