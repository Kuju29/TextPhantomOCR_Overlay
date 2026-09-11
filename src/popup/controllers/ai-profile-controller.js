import { normalizeModelCapabilities } from "../../shared/model-capabilities.js";
import {
  buildAiProfileStoragePatch,
  createAiProfiles,
  getAiProfilePrompt,
  makeProfilePromptKey,
  makeProviderIdentity,
  resolveAiProfile,
  setAiProfilePrompt,
  updateAiProfile,
} from "../../shared/ai-profiles.js";
import { ensureAiProfileStorageV2 } from "../../shared/ai-profile-storage.js";
import { isLocalAiProvider } from "../../shared/constants.js";
import { cloudProviderSpec } from "../../shared/ai/providers/cloud-registry.js";
import { localProviderSpec } from "../../shared/ai/providers/local-registry.js";
import { isLocalHostUrl } from "../../shared/ai/providers/local-spec.js";


function safeEndpointForProvider(provider, endpoint) {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();
  const normalizedEndpoint = String(endpoint || "").trim();
  const localSpec = localProviderSpec(normalizedProvider);
  if (localSpec) {
    // Older popup builds could persist the previously-selected Cloud endpoint
    // under a named Local Provider identity. Repair only registered presets;
    // Custom Local remains fail-closed so an invalid user adapter is visible.
    if (!normalizedEndpoint) return localSpec.baseUrl;
    if (isLocalHostUrl(normalizedEndpoint)) return normalizedEndpoint;
    // Only a syntactically-valid public HTTP(S) endpoint matches the stale
    // Cloud-profile bug. Other malformed input remains visible to validation.
    try {
      const parsed = new URL(normalizedEndpoint);
      if (["http:", "https:"].includes(parsed.protocol)) return localSpec.baseUrl;
    } catch {
      /* rejected by the canonical endpoint validator below */
    }
    return normalizedEndpoint;
  }
  if (isLocalAiProvider(normalizedProvider)) return normalizedEndpoint;
  const cloudSpec = cloudProviderSpec(normalizedProvider);
  // A registered Cloud provider owns its transport endpoint. Carrying a base
  // URL from the previously-selected provider is a credential-routing bug, not
  // a customization feature. Unknown/custom identities retain their explicit
  // endpoint so this safety rule never destroys a separate custom contract.
  return cloudSpec ? cloudSpec.baseUrl : normalizedEndpoint;
}

/** Testable close/debounce lifecycle for canonical Provider-profile writes. */
export function createAiProfilePagehideFlush({
  controller,
  eventTarget = null,
  persist,
  debounceMs = 400,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  cancelPending = null,
} = {}) {
  if (!controller?.buildClosePatch || typeof persist !== "function") {
    throw new TypeError(
      "AI Profile pagehide flush requires controller and persist",
    );
  }
  let timer = null;
  let generation = 0;
  let pending = null;
  let writing = false;
  const writeQueue = [];
  const idleWaiters = [];
  let lastResult = { ok: true, status: "idle" };

  function settleIdle() {
    if (writing || writeQueue.length) return;
    while (idleWaiters.length) idleWaiters.shift()(lastResult);
  }

  function runWrite(entry) {
    writing = true;
    let operation;
    try {
      // The first queued write starts synchronously. Later writes wait for the
      // previous one to settle, so an older completion can never overwrite a
      // newer Provider identity.
      operation = Promise.resolve(persist(entry.patch));
    } catch (error) {
      operation = Promise.reject(error);
    }
    operation
      .then(
        (value) => ({ ok: true, status: "written", value }),
        (error) => ({ ok: false, status: "write_failed", error }),
      )
      .then((result) => {
        lastResult = result;
        entry.resolve(result);
        writing = false;
        const next = writeQueue.shift();
        if (next) runWrite(next);
        else settleIdle();
      });
  }

  function enqueuePatch(patch) {
    return new Promise((resolve) => {
      const entry = { patch, resolve };
      if (writing) writeQueue.push(entry);
      else runWrite(entry);
    });
  }

  function startWrite(snapshot) {
    let patch;
    try {
      // Snapshot construction is immediate and bound to the identity active at
      // this call. Persistence itself is serialized below.
      patch = controller.buildClosePatch(snapshot || {});
    } catch (error) {
      lastResult = { ok: false, status: "snapshot_failed", error };
      settleIdle();
      return Promise.resolve(lastResult);
    }
    return enqueuePatch(patch);
  }

  function flush(snapshot = pending) {
    generation += 1;
    if (timer !== null) clearTimer(timer);
    timer = null;
    pending = null;
    cancelPending?.();
    return snapshot
      ? startWrite(snapshot)
      : Promise.resolve({ ok: true, status: "nothing_pending" });
  }

  function schedule(snapshot) {
    pending = { ...(snapshot || {}) };
    const mine = ++generation;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      if (mine !== generation || !pending)
        return Promise.resolve({ ok: true, status: "stale_skipped" });
      const latest = pending;
      timer = null;
      pending = null;
      return startWrite(latest);
    }, debounceMs);
    return timer;
  }

  const onPagehide = () => {
    void flush();
  };
  eventTarget?.addEventListener?.("pagehide", onPagehide);

  return {
    flush,
    schedule,
    whenIdle: () =>
      !writing && !writeQueue.length
        ? Promise.resolve(lastResult)
        : new Promise((resolve) => idleWaiters.push(resolve)),
    dispose() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
      eventTarget?.removeEventListener?.("pagehide", onPagehide);
    },
  };
}

function defaultsFor(provider) {
  const local = isLocalAiProvider(provider);
  return {
    thinking: "off",
    tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
    temperature: null,
    pageImage: "off",
    memoryMode: "off",
    concurrency: { mode: "auto", max: 0 },
    providerOptions: {},
  };
}

/** Popup-side activation layer for the shared Provider + Model profile core. */
export function createAiProfileController({
  els,
  state,
  setStorage,
  now = () => Date.now(),
}) {
  let profiles;
  let credentials = {};
  let prompts = {};
  let currentIdentity = "";
  let providerTransitionRevision = 0;
  let latestProviderPatch = null;

  const providerValue = () =>
    String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase() || "auto";
  const endpointValue = () => String(els.aiBaseUrl?.value || "").trim();
  const modelValue = () =>
    String(els.aiModel?.value || state.desiredAiModel || "auto").trim() ||
    "auto";
  const languageValue = () =>
    String(state.desiredLang || els.lang?.value || "en")
      .trim()
      .toLowerCase() || "en";

  function findProvider(provider) {
    return (
      Object.entries(profiles?.providers || {})
        .filter(([, item]) => item?.provider === provider)
        .sort(
          (a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0),
        )[0] || null
    );
  }

  function currentRequest(overrides = {}) {
    return {
      provider: overrides.provider ?? providerValue(),
      endpoint: overrides.endpoint ?? endpointValue(),
      model: overrides.model ?? modelValue(),
      defaults: defaultsFor(overrides.provider ?? providerValue()),
    };
  }

  function promptKey(
    lang = languageValue(),
    model = modelValue(),
    identity = currentIdentity,
  ) {
    return makeProfilePromptKey(
      identity || makeProviderIdentity(providerValue(), endpointValue()),
      model,
      lang,
    );
  }

  function render(profile) {
    if (els.aiThinking)
      els.aiThinking.value = profile.thinking === "on" ? "on" : "off";
    if (els.aiPageImage)
      els.aiPageImage.checked = profile.pageImage === "always";
    if (els.aiMemoryMode) els.aiMemoryMode.value = profile.memoryMode || "off";
    if (els.aiLocalCapacityMode)
      els.aiLocalCapacityMode.value = profile.concurrency?.mode || "auto";
    if (els.aiLocalManualConcurrency)
      els.aiLocalManualConcurrency.value = String(
        Math.min(4, Math.max(1, Number(profile.concurrency?.max) || 1)),
      );
    const key = promptKey();
    const prompt = getAiProfilePrompt(prompts, key);
    const value = prompt.text;
    state.aiPromptByLang = prompts;
    if (els.aiPrompt) els.aiPrompt.value = value;
    return { key, value, promptMode: prompt.mode };
  }

  function select(overrides = {}, { create = true } = {}) {
    const request = currentRequest(overrides);
    if (create) {
      profiles = updateAiProfile(profiles, {
        ...request,
        patch: {},
        select: true,
        now: now(),
      });
    }
    const resolved = resolveAiProfile(profiles, request);
    currentIdentity = resolved.providerIdentity;
    if (create)
      profiles.active = {
        providerIdentity: currentIdentity,
        model: resolved.model,
      };
    return { ...resolved, ...render(resolved.profile) };
  }

  function legacyExtras(profile, secret = undefined) {
    const local = isLocalAiProvider(providerValue());
    const max = Number(profile.concurrency?.max) || 1;
    return {
      ...(local ? { aiLocalThinking: profile.thinking === "on" ? "on" : "off" } : {}),
      aiCharMemory: profile.memoryMode === "full",
      aiLocalCapacityMode: profile.concurrency?.mode || "auto",
      aiLocalManualConcurrency: Math.min(4, Math.max(1, max)),
      aiPromptByLang: prompts,
      // storage.local merges objects; explicit empty values prevent a key from
      // the previous identity surviving a Provider/endpoint switch.
      aiKey: typeof secret === "string" ? secret : "",
      aiCloudKey: typeof secret === "string" ? secret : "",
    };
  }

  function buildPersistPatch(overrides = {}) {
    const provider = overrides.provider ?? providerValue();
    const endpoint = overrides.endpoint ?? endpointValue();
    const model = overrides.model ?? modelValue();
    const language = languageValue();
    const resolved = resolveAiProfile(
      profiles,
      currentRequest({ provider, endpoint, model }),
    );
    currentIdentity = resolved.providerIdentity;
    const patch = buildAiProfileStoragePatch({
      state: profiles,
      credentials,
      prompts,
      providerIdentity: currentIdentity,
      model,
      language,
    });
    return {
      ...patch,
      ...legacyExtras(resolved.profile, credentials[currentIdentity]),
    };
  }

  async function persist(overrides = {}) {
    const patch = buildPersistPatch(overrides);
    await setStorage(patch);
    state.aiProfileBlocked = false;
    state.aiProfileErrorCode = "";
    return patch;
  }

  function beginRecovery(stored = {}) {
    const provider = String(stored.aiProvider || providerValue() || "auto").trim().toLowerCase() || "auto";
    const endpoint = safeEndpointForProvider(provider, stored.aiBaseUrl || endpointValue());
    const model = String(stored.aiModel || modelValue() || "auto").trim() || "auto";
    profiles = updateAiProfile(createAiProfiles(), {
      provider, endpoint, model, defaults: defaultsFor(provider), patch: {}, select: true, now: now(),
    });
    currentIdentity = makeProviderIdentity(provider, endpoint);
    credentials = {};
    const secret = String(stored.aiCloudKey || stored.aiKey || "");
    if (!isLocalAiProvider(provider) && secret) credentials[currentIdentity] = secret;
    prompts = {};
    return { provider, endpoint, model };
  }

  async function initialize(stored) {
    const providerHint =
      String(stored.aiProvider || "auto")
        .trim()
        .toLowerCase() || "auto";
    const safeLegacyEndpoint = safeEndpointForProvider(
      providerHint,
      stored.aiBaseUrl,
    );
    const migrated = await ensureAiProfileStorageV2(
      { ...stored, aiBaseUrl: safeLegacyEndpoint },
      {
        read: async () => ({
          aiProfileStorageVersion: stored.aiProfileStorageVersion,
          aiProfilesV1: stored.aiProfilesV1,
          aiProfileCredentialsV1: stored.aiProfileCredentialsV1,
          aiProfilePromptsV1: stored.aiProfilePromptsV1,
        }),
        write: async (patch) => {
          await setStorage(patch);
          Object.assign(stored, structuredClone(patch));
        },
      },
    );
    profiles = migrated.state;
    credentials = migrated.credentials;
    prompts = migrated.prompts;
    // A valid canonical profile is authoritative. Flat legacy keys are only
    // migration input; letting them win here made the popup visibly jump back
    // to an older Provider/Model on every open.
    const effective = migrated.effective || {};
    const provider =
      String(
        migrated.fallbackUsed
          ? stored.aiProvider || effective.aiProvider || "auto"
          : effective.aiProvider || "auto",
      )
        .trim()
        .toLowerCase() || "auto";
    const known = findProvider(provider);
    const candidateEndpoint =
      known?.[1]?.endpoint === "default"
        ? ""
        : known?.[1]?.endpoint ||
          (migrated.fallbackUsed ? safeLegacyEndpoint : effective.aiBaseUrl);
    const endpoint = safeEndpointForProvider(provider, candidateEndpoint);
    const model = String(
      migrated.fallbackUsed
        ? stored.aiModel || effective.aiModel || "auto"
        : effective.aiModel || "auto",
    ).trim() || "auto";
    // Render from the same canonical identity that was resolved above. The
    // caller may have painted rollback keys before migration completed.
    if (els.aiProvider) els.aiProvider.value = provider;
    if (els.aiBaseUrl) els.aiBaseUrl.value = endpoint;
    if (els.aiModel) els.aiModel.value = model;
    state.desiredAiModel = model;
    state.activeAiProvider = provider;
    // Hydration is a read for an existing canonical record. A malformed/old
    // state can still name a missing model; only that migration-repair case is
    // allowed to create the record.
    const hydratedIdentity = makeProviderIdentity(provider, endpoint);
    const hasStoredModel = Boolean(
      profiles?.providers?.[hydratedIdentity]?.models?.[model],
    );
    const selected = select(
      { provider, endpoint, model },
      { create: !hasStoredModel },
    );
    if (endpoint !== candidateEndpoint) {
      await persist({ provider, endpoint, model });
    }
    return { provider, endpoint, model, ...selected };
  }

  function selectProvider(provider, fallbackEndpoint = "") {
    const normalizedProvider = String(provider || "")
      .trim()
      .toLowerCase();
    const known = findProvider(normalizedProvider);
    const candidateEndpoint =
      known?.[1]?.endpoint === "default"
        ? ""
        : known?.[1]?.endpoint || fallbackEndpoint;
    // A migrated Cloud profile can contain an old Ollama/Local endpoint. Do
    // not let that stale endpoint silently turn an explicit Cloud selection
    // back into a Local runtime.
    const endpoint = safeEndpointForProvider(
      normalizedProvider,
      candidateEndpoint,
    );
    const latestModel = Object.entries(known?.[1]?.models || {}).sort(
      (a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0),
    )[0]?.[0];
    const model =
      known?.[1] && profiles.active.providerIdentity === known[0]
        ? profiles.active.model
        : latestModel || "auto";
    return {
      endpoint,
      model,
      ...select({ provider: normalizedProvider, endpoint, model }),
    };
  }

  function beginProviderTransition(provider, fallbackEndpoint = "") {
    const revision = ++providerTransitionRevision;
    const snapshot = {
      profiles: structuredClone(profiles),
      credentials: structuredClone(credentials),
      prompts: structuredClone(prompts),
      currentIdentity,
    };
    const selected = selectProvider(provider, fallbackEndpoint);
    let settled = false;
    return {
      selected,
      async commit(extraPatch = {}) {
        if (settled) throw new TypeError("Provider transition already settled");
        // A transition can become stale before its caller reaches commit (for
        // example while async model discovery is still running). It must not
        // write an identity that has already been superseded.
        if (revision !== providerTransitionRevision) {
          settled = true;
          return { ...selected, stale: true };
        }
        let providerWriteCompleted = false;
        try {
          const patch = {
            ...buildPersistPatch({
              provider: profiles.providers[selected.providerIdentity]?.provider,
              endpoint: selected.endpoint,
              model: selected.model,
            }),
            ...(extraPatch || {}),
          };
          latestProviderPatch = { revision, patch: structuredClone(patch) };
          await setStorage(patch);
          state.aiProfileBlocked = false;
          state.aiProfileErrorCode = "";
          providerWriteCompleted = true;
          // chrome.storage writes cannot be cancelled. If this write started
          // first but completed after a newer Provider commit, restore the
          // newest canonical patch so the late completion cannot win.
          if (
            revision !== providerTransitionRevision &&
            latestProviderPatch?.revision === providerTransitionRevision
          ) {
            await setStorage(structuredClone(latestProviderPatch.patch));
          }
          settled = true;
          return revision === providerTransitionRevision
            ? selected
            : { ...selected, stale: true };
        } catch (error) {
          // A failed obsolete write is unrelated to the Provider currently
          // shown in the popup. Do not roll back the newer state or surface a
          // misleading current-Provider save error.
          if (
            revision !== providerTransitionRevision &&
            !providerWriteCompleted
          ) {
            settled = true;
            return { ...selected, stale: true, writeFailed: true };
          }
          profiles = snapshot.profiles;
          credentials = snapshot.credentials;
          prompts = snapshot.prompts;
          currentIdentity = snapshot.currentIdentity;
          // Invalidate every older in-flight transition. The failed current
          // transition has restored its predecessor, so no failed candidate
          // patch may be used later as a corrective latest write.
          providerTransitionRevision += 1;
          latestProviderPatch = null;
          settled = true;
          throw error;
        }
      },
      rollback() {
        if (settled) return false;
        profiles = snapshot.profiles;
        credentials = snapshot.credentials;
        prompts = snapshot.prompts;
        currentIdentity = snapshot.currentIdentity;
        settled = true;
        return true;
      },
    };
  }

  function selectModel(model) {
    const selectedModel = String(model || "auto").trim() || "auto";
    const language = languageValue();
    const identity =
      currentIdentity || makeProviderIdentity(providerValue(), endpointValue());
    const destinationKey = makeProfilePromptKey(
      identity,
      selectedModel,
      language,
    );
    const autoKey = makeProfilePromptKey(identity, "auto", language);
    let seededPrompt = false;

    // Model discovery commonly changes `auto` into a concrete model after the
    // popup is already visible. Seed that model once from the Provider's auto
    // Style so the user's text does not appear to vanish. Presence, rather
    // than truthiness, is intentional: an explicitly empty model Style must
    // remain empty and must never be overwritten by the auto profile.
    if (
      selectedModel !== "auto" &&
      !Object.prototype.hasOwnProperty.call(prompts, destinationKey) &&
      Object.prototype.hasOwnProperty.call(prompts, autoKey)
    ) {
      prompts = setAiProfilePrompt(
        prompts,
        destinationKey,
        getAiProfilePrompt(prompts, autoKey),
      );
      state.aiPromptByLang = prompts;
      seededPrompt = true;
    }

    return { ...select({ model: selectedModel }), seededPrompt };
  }

  async function saveProfile(patch) {
    const request = currentRequest();
    profiles = updateAiProfile(profiles, {
      ...request,
      patch,
      select: true,
      now: now(),
    });
    currentIdentity = makeProviderIdentity(request.provider, request.endpoint);
    await persist();
  }

  async function saveModelCapabilities(modelCapabilities, capabilityAccountHash) {
    const request = currentRequest();
    const current = resolveAiProfile(profiles, request).profile?.providerOptions || {};
    modelCapabilities = normalizeModelCapabilities(modelCapabilities);
    const next = { modelCapabilities, capabilityAccountHash };
    if (JSON.stringify(normalizeModelCapabilities(current.modelCapabilities)) === JSON.stringify(modelCapabilities)
        && current.capabilityAccountHash === capabilityAccountHash) return false;
    await saveProfile({ providerOptions: next });
    return true;
  }

  async function savePrompt(lang, text, mode = null) {
    const key = promptKey(lang);
    const current = getAiProfilePrompt(prompts, key);
    prompts = setAiProfilePrompt(prompts, key, {
      text: String(text || ""),
      mode: "replace",
    });
    state.aiPromptByLang = prompts;
    await persist();
  }

  function bindConnection({
    provider = providerValue(),
    endpoint = endpointValue(),
  } = {}) {
    const selected = select({ provider, endpoint, model: modelValue() });
    return {
      ...selected,
      credential: credentials[selected.providerIdentity] || "",
    };
  }

  async function saveConnection({
    provider = providerValue(),
    endpoint = endpointValue(),
  } = {}) {
    const selected = bindConnection({ provider, endpoint });
    await persist();
    return selected;
  }

  async function saveCredential(credential) {
    // This method never changes identity. Callers may use it only for an
    // explicit key edit after the UI has already bound the active identity.
    if (!currentIdentity) throw new TypeError("No active Provider identity");
    const provider =
      profiles?.providers?.[currentIdentity]?.provider || providerValue();
    if (isLocalAiProvider(provider)) delete credentials[currentIdentity];
    else credentials[currentIdentity] = String(credential || "");
    await persist();
  }

  function buildClosePatch({
    credential,
    saveCredential: saveKey = false,
    language,
    model,
    prompt,
    promptMode,
    savePrompt: saveText = false,
  } = {}) {
    if (!currentIdentity) throw new TypeError("No active Provider identity");
    const provider = profiles?.providers?.[currentIdentity];
    if (!provider) throw new TypeError("Unknown active Provider identity");
    const selectedModel =
      String(model || profiles.active?.model || "auto").trim() || "auto";
    const selectedLanguage =
      String(language || "en")
        .trim()
        .toLowerCase() || "en";
    // Never rebind from DOM during close. The snapshot belongs only to the
    // identity that was already active before pagehide fired.
    if (saveKey) {
      if (isLocalAiProvider(provider.provider))
        delete credentials[currentIdentity];
      else credentials[currentIdentity] = String(credential || "");
    }
    if (saveText) {
      const key = makeProfilePromptKey(
        currentIdentity,
        selectedModel,
        selectedLanguage,
      );
      prompts = setAiProfilePrompt(prompts, key, {
        text: String(prompt || ""),
        mode: "replace",
      });
    }
    state.aiPromptByLang = prompts;
    const patch = buildAiProfileStoragePatch({
      state: profiles,
      credentials,
      prompts,
      providerIdentity: currentIdentity,
      model: selectedModel,
      language: selectedLanguage,
    });
    const profile = provider.models?.[selectedModel]?.profile;
    return {
      ...patch,
      ...legacyExtras(profile || {}, credentials[currentIdentity]),
    };
  }

  const credentialForCurrent = () => credentials[currentIdentity] || "";
  const currentProviderIdentity = () => currentIdentity;
  return {
    beginProviderTransition,
    bindConnection,
    buildClosePatch,
    initialize,
    beginRecovery,
    persist,
    promptKey,
    saveConnection,
    saveCredential,
    saveProfile,
    saveModelCapabilities,
    savePrompt,
    selectModel,
    selectProvider,
    credentialForCurrent,
    currentProviderIdentity,
  };
}
