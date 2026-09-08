import { note as traceNote } from "../../shared/trace.js";
import { wrongLanguageRepairInstruction } from "../../shared/ai/repair-instruction.js";
import { targetLanguagePriority } from "../../shared/ai/direct-local/prompt.js";
import { getStorage, setStorage } from '../../shared/storage.js';
import { workloadSelection, normalizedWorkloadIdentity } from '../../shared/ai/workload/contract.js';
import { initialProfile, normalizeLimits, textWeight, validProfile, reasoningIsActive,
  takeWorkloadBatch, WORKLOAD_VERSION } from '../../shared/ai/workload/model.js';
import { learnWorkload, observeWorkload } from '../../shared/ai/workload/learning.js';
export const WORKLOAD_STORAGE_KEY = 'aiWorkloadProfilesV1';
const MAX_PROFILES = 128;
function stable(value) {
  if (value === undefined) return 'null';
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
const bounded = async (promise, fallback) => {
  let timer; try { return await Promise.race([promise, new Promise(r => { timer = setTimeout(() => r(fallback), 800); })]); }
  catch { return fallback; } finally { clearTimeout(timer); }
};
export function createWorkloadController({ read = getStorage, write = setStorage, now = Date.now, emit = data => traceNote("background/ai/workload-controller.js", "workloadDecision", data) } = {}) {
  const profileVersion = {}, persistedVersion = {};
  const metrics = p => ({outputTarget:p.target,recordTarget:p.records,revision:p.revision,epoch:p.epoch,samples:p.samples});
  const event = data => { try { emit({schema:"tp.audit/1",...data}); } catch {} };
  const storageState = key => !persistence ? 'memory_only' :
    (profileVersion[key] || 0) === (persistedVersion[key] || 0) ? 'persisted' : 'pending';
  let loaded = null, persistence = false, profiles = {}, writes = Promise.resolve(), writing = false, dirty = false;
  async function load() {
    if (!loaded) loaded = (async () => {
      const saved = await bounded(read(WORKLOAD_STORAGE_KEY), null);
      persistence = saved != null;
      const data = saved?.[WORKLOAD_STORAGE_KEY];
      if (data?.version === WORKLOAD_VERSION && data.profiles && typeof data.profiles === 'object') {
        for (const [key, value] of Object.entries(data.profiles).slice(-MAX_PROFILES)) {
          if (/^[a-f0-9]{64}$/.test(key)) {
            profiles[key] = validProfile(value, now());
            const currentTime=now();
            const reason=!value || value.version!==WORKLOAD_VERSION ? 'version_mismatch' :
              !Number.isFinite(value.updatedAt) || value.updatedAt>currentTime+60000 ? 'invalid_profile' :
              currentTime-value.updatedAt>30*86400000 ? 'expired_profile' : 'loaded';
            if(reason!=='loaded') profileVersion[key]=1;
            event({event:'workload_profile',scope:{profileId:key.slice(0,16)},reason,
              after:metrics(profiles[key]),persistence:reason==='loaded'?'persisted':'pending'});
          }
        }
      } else if (data) {
        event({event:'workload_profile',reason:'version_mismatch',persistence:'memory_only'});
      } else if (!persistence) {
        event({event:'workload_profile',reason:'storage_unavailable',persistence:'memory_only'});
      }
    })();
    return loaded;
  }
  function prune(keep = "") {
    const keys = Object.keys(profiles).sort((a,b) => profiles[a].updatedAt - profiles[b].updatedAt);
    for (const key of keys) {
      if (Object.keys(profiles).length <= MAX_PROFILES) break;
      if (key !== keep) delete profiles[key];
    }
  }
  function persist() {
    prune();
    if (!persistence) return;
    dirty = true;
    if (writing) return;
    writing = true;
    // Coalesce concurrent pages and stop after a storage timeout; never block
    // generation indefinitely or accumulate one pending write per request.
    writes = (async () => {
      try {
        while (dirty && persistence) {
          dirty = false;
          const snapshot = structuredClone(profiles), versions = {...profileVersion};
          const saved = await bounded(Promise.resolve().then(() => write({ [WORKLOAD_STORAGE_KEY]: {
            version: WORKLOAD_VERSION, profiles: snapshot,
          } })).then(() => true), false);
          if (!saved) persistence = false;
          for (const [key, version] of Object.entries(versions)) {
            if (version === persistedVersion[key]) continue;
            if (saved) persistedVersion[key] = version;
            event({event:'workload_persisted',scope:{profileId:key.slice(0,16)},
              reason:saved ? 'snapshot_written' : 'storage_unavailable',
              after:metrics(snapshot[key] || initialProfile(now())),
              persistence:saved ? 'persisted' : 'memory_only'});
          }
        }
      } finally { writing = false; }
    })();
  }

  return {
    async open({ ai = {}, route = '', sourceLang = '', targetLang = '', image = false } = {}) {
      await load();
      ai = structuredClone(ai);
      const selection = workloadSelection(ai, route);
      const caps = selection.caps;
      ai.model_capabilities = caps;
      delete ai.modelCapabilities;
      const limits = normalizeLimits(caps.limits || { contextTokens: caps.contextLength });
      const contract = selection.kind;
      const expectedIdentity = selection.model && selection.contract
        ? `${selection.model}|${selection.contract}` : '';
      const key = await hash({ version: WORKLOAD_VERSION, route, provider: ai.provider, model: ai.model,
        endpoint: ai.base_url, account: ai.api_key || '', sourceLang, targetLang, contract,
        thinking: ai.thinking, temperature: ai.temperature, style: ai.prompt,
        memory: ai.memory_mode, image, localAdapter: ai.local_adapter,
        maxOutput: ai.max_output_tokens, revision: limits.modelRevision, context: limits.contextTokens, reasoning: caps.reasoning });
      // Unconfirmed execution must never borrow a persisted limit from a different
      // server-selected contract. It can still calibrate within this image.
      let privateProfile = initialProfile(now());
      let planningDecision = expectedIdentity ? 'profile_matches_execution' : 'unconfirmed_contract_cold_start';
      function checkedProfile() {
        if (!expectedIdentity) return privateProfile;
        let profile = profiles[key], replaced = false;
        if (!profile) {
          profile = profiles[key] = initialProfile(now());
          planningDecision = 'cold_start';
          replaced = true;
        } else if ((profile.samples || profile.actualIdentity) &&
            normalizedWorkloadIdentity(profile.actualIdentity) !== expectedIdentity) {
          profile = profiles[key] = { ...initialProfile(now()), epoch: profile.epoch + 1,
            lastDecision: 'execution_identity_reset_before_dispatch' };
          planningDecision = profile.lastDecision;
          replaced = true;
        }
        profile.actualIdentity = expectedIdentity;
        if (replaced) { profileVersion[key] = (profileVersion[key] || 0)+1; persist(); }
        return profile;
      }
      const opened = checkedProfile();
      event({event:'workload_profile',scope:{profileId:key.slice(0,16)},reason:planningDecision,
        after:metrics(opened),persistence:expectedIdentity ? storageState(key) : 'memory_only',
        effective:{contract:selection.contract || 'unconfirmed'}});
      prune(key);
      const context = { contract, limits, reasoningActive: reasoningIsActive(ai, caps),
        userMaxOutput: Number.isSafeInteger(ai.max_output_tokens) && ai.max_output_tokens > 0 ? ai.max_output_tokens : null,
        // Counts full fixed prompt/context conservatively; not only OCR.
        fixedInput: textWeight(ai.prompt) + (ai.repair_reason ? textWeight(wrongLanguageRepairInstruction(targetLanguagePriority(targetLang), ai.repair_reason)) : 0) + textWeight(stable({ glossary: ai.glossary,
          characters: ai.characters, state: ai.series_state, previous: ai.prev_context })) + 512 + (image ? 2048 : 0) };
      const currentProfile = checkedProfile;
      return {
        key,
        get ai() { return structuredClone(ai); },
        next(rows, offset) {
          const chunk = takeWorkloadBatch(rows, offset, currentProfile(), context);
          chunk.estimate.planningContract = selection.contract || 'unconfirmed';
          chunk.estimate.profileDecision = planningDecision;
          return chunk;
        },
        observe({ units, answer, error, defects, plan }) {
          const observation = observeWorkload({ units, answer, error, defects, plan, ai });
          const current = currentProfile();
          const before = metrics(current);
          const actual = normalizedWorkloadIdentity(observation.actualIdentity);
          let next = current, decision;
          if (expectedIdentity && actual !== expectedIdentity) {
            // A legacy/misconfigured server must not poison this confirmed scope.
            // Translation validation remains independent; this only rejects training.
            decision = actual ? 'unplanned_execution_observation_ignored' : 'unconfirmed_execution_observation_ignored';
          } else {
            if (actual) observation.actualIdentity = actual;
            next = learnWorkload(current, observation, now());
            if (expectedIdentity) {
              profiles[key] = next;
              if (next !== current) { profileVersion[key] = (profileVersion[key] || 0)+1; persist(); }
            } else privateProfile = next;
          }
          const changed = next.target !== before.outputTarget || next.records !== before.recordTarget || next.epoch !== before.epoch;
          const eventDecision = decision || (changed ? next.lastDecision : 'unchanged');
          const transition = {schema:'tp.audit/1',event:'workload_observed',scope:{profileId:key.slice(0,16)},
            before,after:metrics(next),changed,reason:eventDecision,
            evidence:{unitCount:units?.length || 0},effectiveFrom:'next_request',
            persistence:expectedIdentity ? storageState(key) : 'memory_only'};
          event(transition);
          return { transition, profileId: key.slice(0,16), outcome: observation.outcome,
            finishReason: observation.finishReason,
            requestedOutputTokens: observation.requestedOutputTokens,
            usage: { inputTokens: observation.providerInputTokens, outputTokens: observation.providerOutputTokens,
              visible: observation.visibleTokens, thinkingTokens: observation.reasoningTokens,
              cachedInput: observation.cachedInputTokens },
            validation: { missingCount: observation.missingCount, wrongLanguageCount: observation.wrongLanguageCount },
            learning: { samples: next.samples, outputTarget: next.target, recordTarget: next.records,
              revision: next.revision, decision: eventDecision, previousDecision: next.lastDecision } };
        },
        snapshot() { return structuredClone(currentProfile()); },
      };
    },
    async flush() { await bounded(writes, null); },
  };
}
export const workloadController = createWorkloadController();
