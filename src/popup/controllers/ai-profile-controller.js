import { AI_PROMPT_MAX_CHARS } from "../../shared/prompt.js";
import { LOGIN_PROFILE_KEY, loginEntry, putLoginEntry, loginPromptKey } from "../../shared/login-profile.js";
import { PAID_PROFILE_KEY, paidEntry, putPaidEntry, paidPromptKey } from "../../shared/paid-profile.js";
import { setThinkingPreference } from "./reasoning-select.js";
import { defaultTokenCeiling, validTokenCeiling } from "../../shared/token-ceiling.js";
import { uiTemplate } from "../../shared/ui-template.js";
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
import { localProviderSpec, localProviderTranslationMode } from "../../shared/ai/providers/local-registry.js";
import { isLocalHostUrl } from "../../shared/ai/providers/local-spec.js";


function safeEndpointForProvider(provider, endpoint) {
  const normalizedProvider = String(provider || "")
    .trim()
    .toLowerCase();
  const normalizedEndpoint = String(endpoint || "").trim();
  const localSpec = localProviderSpec(normalizedProvider);
  if (localSpec) {
    // A named Local Provider can carry a previously selected Cloud endpoint.
    // Repair only registered presets; Custom Local stays fail-closed so an
    // invalid user adapter is visible.
    if (!normalizedEndpoint) return localSpec.baseUrl;
    if (isLocalHostUrl(normalizedEndpoint)) return normalizedEndpoint;
    // Only a valid public HTTP(S) endpoint is treated as that stale Cloud
    // endpoint; other malformed input stays visible to validation.
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
    thinking: "minimum",
    tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
    temperature: null,
    pageImage: "off",
    memoryMode: "off",
    styleExamples: false,
    translationMode: local ? "independent" : "conversation",
    conversationReset: "0",
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
  let loginStored = {};
  let paidStored = {}, paidSeed = {}, paidContext = null, paidSignature = "";
  let serviceProfilesSeeded=false;
  function seedServiceProfiles(stored={}) {
    if(serviceProfilesSeeded)return;
    // Paid/Login paint before Manual migration finishes. Their existing scoped
    // choices must be present before setPaidContext can persist a first entry.
    paidSeed=structuredClone(stored);
    paidStored=structuredClone(stored[PAID_PROFILE_KEY]||{});
    loginStored=structuredClone(stored[LOGIN_PROFILE_KEY]||{});
    serviceProfilesSeeded=true;
  }
  const paidActive = () => Boolean(paidContext?.active);
  const serviceProfileReady = () => paidContext?.source !== "login" || Boolean(
    paidContext.provider && paidContext.accountScope && paidContext.model && paidContext.model !== "auto");
  const paidKey = (api, model, language) => paidContext?.source === "login"
    ? loginPromptKey(api, paidContext.provider, paidContext.accountScope, model, language) : paidPromptKey(api, model, language);
  const selectedEntry = (language) => paidContext?.source === "login"
    ? loginEntry({[LOGIN_PROFILE_KEY]:loginStored}, paidContext.apiBase, paidContext.provider, paidContext.accountScope, paidContext.model, language)
    : paidEntry({[PAID_PROFILE_KEY]:paidStored}, paidContext.apiBase, paidContext.model, language);
  const paidSelection = () => paidContext?.source === "login" ? selectedEntry(languageValue()) : paidEntry({...paidSeed, aiProfilesV1: profiles || paidSeed.aiProfilesV1, aiProfilePromptsV1: prompts, [PAID_PROFILE_KEY]: paidStored},
    paidContext.apiBase, paidContext.model, languageValue());
  function putPaid(entry) {
    if (paidContext?.source === "login") {
      loginStored = putLoginEntry(loginStored, paidContext.apiBase, paidContext.provider, paidContext.accountScope, paidContext.model, entry);
      return {[LOGIN_PROFILE_KEY]: structuredClone(loginStored)};
    }
    paidStored = putPaidEntry(paidStored, paidContext.apiBase, paidContext.model, entry);
    return {[PAID_PROFILE_KEY]: structuredClone(paidStored)};
  }
  function persistPaidSelection(entry) {
    const patch = putPaid(entry);
    const failed = () => {
      state.aiProfileBlocked = true; state.aiProfileErrorCode = "AI_PROFILE_SAVE_FAILED";
      if (els.aiPaidStatus) els.aiPaidStatus.textContent = "Could not save AI settings. Check browser storage and try again.";
    };
    try { Promise.resolve(setStorage(patch)).then(() => {
      if (state.aiProfileErrorCode === "AI_PROFILE_SAVE_FAILED") {state.aiProfileBlocked=false;state.aiProfileErrorCode="";}
    }, failed); } catch { failed(); }
  }
  function paidPromptMap(entry) {
    return Object.fromEntries(Object.entries(entry.prompts).map(([lang, record]) =>
      [paidKey(paidContext.apiBase, paidContext.model, lang), record]));
  }
  // Per-model token ceiling: OFF shows the model's default; ON uses the
  // user's number for this model (Paid, Manual Cloud and Local; not Login).
  function setTemplate(element, phrase, values) {
    if (!element) return;
    if (typeof element.replaceChildren === "function" && typeof document !== "undefined" &&
        typeof element.ownerDocument?.createDocumentFragment === "function") {
      element.replaceChildren(uiTemplate(phrase, values));
      return;
    }
    element.textContent = phrase.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? "—"));
  }
  function tokenCeilingProfile() {
    if (paidActive()) return serviceProfileReady() ? paidSelection().profile : {};
    try { return resolveAiProfile(profiles, currentRequest()).profile || {}; } catch { return {}; }
  }
  const localLimitsFor = hint => hint ? {...(hint.limits || {}),
    contextTokens: hint.limits?.contextTokens ?? (Number.isSafeInteger(hint.contextLength) ? hint.contextLength : undefined)} : null;
  function tokenCeilingDefault(profile = tokenCeilingProfile()) {
    // Login: OFF keeps the current automatic size (no published window).
    if (paidActive()) return paidContext?.source === "login" ? {tokens:null, source:"login"}
      : defaultTokenCeiling({service:"paid", paidCeiling:paidContext?.requestCeiling});
    const local = isLocalAiProvider(providerValue());
    const model = modelValue();
    return defaultTokenCeiling({local, modelCapabilities:profile.providerOptions?.modelCapabilities,
      localLimits: local ? localLimitsFor(state.localAiCapability?.models?.[model]) : null});
  }
  function renderTokenCeiling(profile = tokenCeilingProfile()) {
    if (!els.aiTokenCeilingEnabled || !els.aiTokenCeiling) return;
    const info = tokenCeilingDefault(profile);
    const saved = validTokenCeiling(profile.tokenCeiling) ? profile.tokenCeiling : null;
    const enabled = profile.tokenCeilingEnabled === true && saved !== null;
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    // "pending": switched ON but no valid number saved yet (user is typing).
    if (els.aiTokenCeilingEnabled.dataset?.pending !== "1") els.aiTokenCeilingEnabled.checked = enabled;
    els.aiTokenCeiling.disabled = !els.aiTokenCeilingEnabled.checked;
    // OFF shows the size actually used (the default), not the stored
    // number; the stored number comes back when the switch is turned on.
    if (focused !== els.aiTokenCeiling)
      els.aiTokenCeiling.value = els.aiTokenCeilingEnabled.checked && saved !== null ? String(saved)
        : els.aiTokenCeilingEnabled.checked || !info?.tokens ? (saved !== null ? String(saved) : "") : String(info.tokens);
    // 10496: an automatic default (no number) is said in the field itself;
    // the full default sentence is part of the "Set a token ceiling" explanation.
    els.aiTokenCeiling.placeholder = info?.tokens ? String(info.tokens)
      : info?.source === "login" ? "Auto · about 3–5 images" : "Auto · context loaded in your Local app";
    const model = paidActive() ? String(paidContext?.model || "") : modelValue();
    if (els.aiTokenCeilingDefault) {
      if (info?.source === "login") setTemplate(els.aiTokenCeilingDefault,
        "Default for {model}: automatic size, about 3–5 images per request.", {model: model || "auto"});
      else if (!info?.tokens) els.aiTokenCeilingDefault.textContent =
        "Default: the context loaded in your Local app (shown after the model is checked).";
      else setTemplate(els.aiTokenCeilingDefault, info.source === "center"
        ? "Default for {model}: {tokens} tokens (Control Center model ceiling)."
        : info.source === "model"
          ? "Default for {model}: {tokens} tokens (context loaded in your Local app)."
          : "Default for {model}: {tokens} tokens (application default).",
        {model: model || "auto", tokens: info.tokens.toLocaleString("en-US")});
    }
    if (els.aiTokenCeilingWarning) {
      const typed = Math.floor(Number(els.aiTokenCeiling.value));
      const loginLimit = info?.source === "login" ? 8192 : null;
      const above = els.aiTokenCeilingEnabled.checked && (info?.tokens || loginLimit) && Number.isFinite(typed) &&
        typed > (info?.tokens || loginLimit);
      const missing = els.aiTokenCeilingEnabled.checked && !validTokenCeiling(typed);
      els.aiTokenCeilingWarning.hidden = !(above || missing);
      if (missing) els.aiTokenCeilingWarning.textContent = "Enter the number of tokens for each AI request.";
      else if (above && loginLimit) setTemplate(els.aiTokenCeilingWarning,
        "Web chats publish no limit. Above {tokens} tokens a reply can be cut off and translation can fail.",
        {tokens: loginLimit.toLocaleString("en-US")});
      else if (above) setTemplate(els.aiTokenCeilingWarning,
        "Above the default of {tokens} tokens. If a reply no longer fits, translation can fail.",
        {tokens: info.tokens.toLocaleString("en-US")});
    }
  }
  function renderPaid() {
    const entry = paidSelection(), profile = entry.profile;
    renderTokenCeiling(serviceProfileReady() ? profile : {});
    const editable=serviceProfileReady();
    // The saved value only: the popup controller owns the AI think state for
    // the current selection (an older catalogue cannot overwrite it here).
    setThinkingPreference(els.aiThinking, profile.thinking);
    for(const field of [els.aiPageImage,els.aiMemoryMode,els.aiStyleExamples,els.aiPrompt])
      if(field)field.disabled=!editable;
    if(!editable&&els.aiThinking)els.aiThinking.disabled=true;
    if (els.aiPageImage) els.aiPageImage.checked = profile.pageImage === "always";
    if (els.aiMemoryMode) els.aiMemoryMode.value = profile.memoryMode;
    if (els.aiTranslationMode) els.aiTranslationMode.value = "conversation";
    if (els.aiStyleExamplesWrap) els.aiStyleExamplesWrap.style.display = "";
    if (els.aiStyleExamples) els.aiStyleExamples.checked = profile.styleExamples === true;
    const key = paidKey(paidContext.apiBase, paidContext.model, languageValue());
    state.aiPromptByLang = {...prompts, ...paidPromptMap(entry)};
    if (els.aiPrompt && !state.aiPromptDirtyByLang?.[key]) els.aiPrompt.value = entry.prompts[languageValue()].text;
    if (els.aiPromptCount) els.aiPromptCount.textContent = `${String(els.aiPrompt?.value || "").length}/${AI_PROMPT_MAX_CHARS}`;
    return {key, value: entry.prompts[languageValue()].text, promptMode: "replace"};
  }
  function setPaidContext(context) {
    const signature = JSON.stringify([!!context.active, context.source || "tp", context.provider || "", context.accountScope || "", context.apiBase || "", context.model || "auto", languageValue()]);
    const changed = signature !== paidSignature;
    if (changed) state.promptSeq = (Number(state.promptSeq) || 0) + 1;
    if (changed && paidActive() && serviceProfileReady()) {
      const key = paidKey(paidContext.apiBase, paidContext.model, paidContext.language);
      if (state.aiPromptDirtyByLang?.[key]) {
        const entry = selectedEntry(paidContext.language);
        entry.prompts[paidContext.language] = {text: String(els.aiPrompt?.value || ""), mode: "replace"};
        persistPaidSelection(entry);
        state.aiPromptDirtyByLang[key] = false;
      }
    }
    const wasPaid = paidActive();
    paidContext = {...context, language: languageValue()}; paidSignature = signature;
    if (paidActive() && changed) {
      const entry = paidSelection();
      // Persist a first selection once, so later Manual changes cannot reseed it.
      if(serviceProfileReady())persistPaidSelection(entry);
      return renderPaid();
    }
    if (!paidActive() && wasPaid && profiles) {
      return render(resolveAiProfile(profiles, currentRequest()).profile);
    }
  }

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
    if (paidActive()) return paidKey(paidContext.apiBase, paidContext.model, lang);
    return makeProfilePromptKey(
      identity || makeProviderIdentity(providerValue(), endpointValue()),
      model,
      lang,
    );
  }

  function render(profile) {
    if (paidActive()) return renderPaid();
    renderTokenCeiling(profile);
    for(const field of [els.aiPageImage,els.aiMemoryMode,els.aiStyleExamples,els.aiPrompt])
      if(field)field.disabled=false;
    setThinkingPreference(els.aiThinking, profile.thinking || "minimum");
    if (els.aiPageImage)
      els.aiPageImage.checked = profile.pageImage === "always";
    if (els.aiMemoryMode) els.aiMemoryMode.value = profile.memoryMode || "off";
    const local = isLocalAiProvider(providerValue());
    const translationMode = local ? localProviderTranslationMode(providerValue()) : "conversation";
    if (els.aiStyleExamples) {
      els.aiStyleExamples.checked = profile.styleExamples === true;
      els.aiStyleExamples.disabled = false;
    }
    if (els.aiStyleExamplesWrap) els.aiStyleExamplesWrap.style.display = "";
    if (els.aiTranslationMode) els.aiTranslationMode.value = translationMode;
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
    state.promptSeq = (Number(state.promptSeq) || 0) + 1;
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
      ...(local ? { aiLocalThinking: profile.thinking || "minimum" } : {}),
      aiCharMemory: profile.memoryMode === "full",
      aiStyleExamples: profile.styleExamples === true,
      // The profile owns this selection; Cloud always renders Conversation.
      aiTranslationMode: local ? localProviderTranslationMode(providerValue()) : "conversation",
      aiConversationReset: String(profile.conversationReset || "0"),
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

  async function persist(overrides = {}, isCurrent = () => true) {
    const patch = buildPersistPatch(overrides);
    await setStorage(patch);
    if (isCurrent()) {
      state.aiProfileBlocked = false;
      state.aiProfileErrorCode = "";
    }
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
    setStorage.seed?.(stored);
    seedServiceProfiles(stored);
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
    paidSeed = {...stored, ...(migrated.effective || {}), aiProfilesV1: profiles, aiProfilePromptsV1: prompts};
    // A valid canonical profile is authoritative. Flat legacy keys are only
    // migration input; letting them win would make the popup jump back to an
    // older Provider/Model on every open.
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
            !setStorage.orderedProfileWrites &&
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
      profiles?.active?.model === "auto" &&
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

  async function activateResolvedModel(model, isCurrent = () => true) {
    const selectedModel = String(model || "").trim();
    const request = currentRequest({ model: selectedModel });
    const identity = makeProviderIdentity(request.provider, request.endpoint);
    if (!selectedModel || selectedModel === "auto" || !isCurrent() ||
        currentIdentity !== identity || modelValue() !== selectedModel) return false;
    if (profiles.active?.providerIdentity === identity &&
        profiles.active?.model === selectedModel) return false;
    // Resolving auto is completion of the same selection, not a user switch
    // to another model. Preserve edits made while its catalogue was loading.
    // An existing concrete model always retains its own saved profile.
    const providerRecord = profiles.providers[identity];
    if (profiles.active?.model === "auto" && !providerRecord?.models?.[selectedModel]) {
      const autoProfile = resolveAiProfile(profiles, currentRequest({model:"auto"})).profile;
      const { providerOptions: _autoCapabilities, ...intent } = autoProfile;
      profiles = updateAiProfile(profiles, {
        ...request, patch: intent, select: false, now: now(),
      });
    }
    const dirtyPrompt = state.promptDirty ? String(els.aiPrompt?.value || "") : null;
    state.desiredAiModel = selectedModel;
    selectModel(selectedModel);
    // A metadata response is not permission to discard a pending style edit.
    if (dirtyPrompt !== null && els.aiPrompt) els.aiPrompt.value = dirtyPrompt;
    await persist(request, isCurrent);
    return true;
  }

  async function saveProfile(patch) {
    if (paidActive()) {
      if(!serviceProfileReady()){renderPaid();return;}
      const entry = paidSelection(); entry.profile = {...entry.profile, ...patch};
      await setStorage(putPaid(entry));
      return;
    }
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

  async function saveModelCapabilities(modelCapabilities, capabilityAccountHash,
    target = currentRequest(), isCurrent = () => true) {
    const request = currentRequest(target);
    const selected = currentRequest();
    if (!isCurrent() ||
        makeProviderIdentity(request.provider, request.endpoint) !== makeProviderIdentity(selected.provider, selected.endpoint) ||
        request.model !== selected.model) return false;
    const current = resolveAiProfile(profiles, request).profile?.providerOptions || {};
    modelCapabilities = normalizeModelCapabilities(modelCapabilities);
    const next = { modelCapabilities, capabilityAccountHash };
    if (JSON.stringify(normalizeModelCapabilities(current.modelCapabilities)) === JSON.stringify(modelCapabilities)
        && current.capabilityAccountHash === capabilityAccountHash) return false;
    profiles = updateAiProfile(profiles, {
      ...request, patch: { providerOptions: next }, select: false, now: now(),
    });
    // No await between the identity check and starting this write. Late probe
    // results must not activate a different Provider/model or change intent.
    await persist(request, isCurrent);
    return true;
  }

  async function savePrompt(lang, text) {
    if (paidActive()) {
      if(!serviceProfileReady()){renderPaid();return;}
      const entry = paidSelection(); entry.prompts[lang] = {text: String(text || ""), mode: "replace"};
      const patch = putPaid(entry);
      state.aiPromptByLang = {...prompts, ...paidPromptMap(entry)};
      await setStorage(patch); return;
    }
    const key = promptKey(lang);
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
    savePrompt: saveText = false,
  } = {}) {
    if (paidActive()) {
      if(!serviceProfileReady())return {};
      const entry = paidSelection();
      if (saveText) entry.prompts[language || languageValue()] = {text: String(prompt || ""), mode: "replace"};
      state.aiPromptByLang = {...prompts, ...paidPromptMap(entry)};
      return putPaid(entry); // Never persist the hidden Manual credential from a Paid close.
    }
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
    seedServiceProfiles,
    whenIdle: () => setStorage.whenIdle?.() || Promise.resolve(),
    setPaidContext,
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
    renderTokenCeiling: () => renderTokenCeiling(),
    tokenCeilingDefault: () => tokenCeilingDefault(),
    savedTokenCeiling: () => { const p = tokenCeilingProfile(); return validTokenCeiling(p.tokenCeiling) ? p.tokenCeiling : null; },
    activateResolvedModel,
    saveModelCapabilities,
    savePrompt,
    selectModel,
    selectProvider,
    credentialForCurrent,
    currentProviderIdentity,
  };
}
