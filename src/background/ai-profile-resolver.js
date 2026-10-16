/** Resolves one immutable Provider + Model settings snapshot per job batch. */
import { dataConsentError } from "../shared/data-consent.js";
import { readAccountSession, withAccountSignal } from "../shared/account-gate.js";
import { loginEntry, loginModelUnavailable } from "../shared/login-profile.js";
import { loginAuthScope } from "../shared/login-auth.js";
import { paidEntry } from "../shared/paid-profile.js";
import { activeTokenCeiling } from "../shared/token-ceiling.js";
import { normalizeModelCapabilities } from "../shared/model-capabilities.js";
import { diagnosticFetch, recordDiagnostic } from "../shared/diagnostics.js";
import { classifyAiRuntime } from "../shared/ai-settings-contract.js";
import {
  AI_PROFILES_SCHEMA_VERSION,
  requireActiveAiProfile,
} from "../shared/ai-profiles.js";
import { ensureAiProfileStorageV2 } from "../shared/ai-profile-storage.js";
import {
  createAiProfileActivationController,
  resolveEffectiveAiProfile,
} from "../shared/ai-profile-activation.js";
import { cloudProviderSpec } from "../shared/ai/providers/cloud-registry.js";
import {
  isNamedLocalProvider,
  localAiPreset,
  localProviderTranslationMode,
  normalizeLocalAiAdapter,
  savedCustomLocalAdapter,
} from "../shared/ai/providers/local-registry.js";
import { resolveApiBase } from "../shared/api-defaults.js";
import { normalizeUrl } from "../shared/url.js";

function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`)
    .join(",")}}`;
}

async function shortHash(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function immutableCopy(value) {
  const copy = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(copy);
}

function canonicalDefaults(local) {
  return {
    thinking: "minimum",
    tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
    temperature: null,
    pageImage: "off",
    memoryMode: "off",
    styleExamples: false,
    translationMode: local ? "independent" : "conversation",
    conversationReset: "0",
    concurrency: {
      mode: "auto",
      max: 0,
    },
    providerOptions: {},
  };
}

async function validationStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    if (error && typeof error === "object") {
      error.profileValidationStage ||= stage;
      error.profileValidationReason ||= String(error.message || error.code || "unknown");
    }
    throw error;
  }
}

/**
 * Resolve the currently selected pair once. Unsupported profile fields are
 * reported but deliberately not projected into the established wire payload.
 */
async function resolveManualJobAiProfile(settings, { language = "en" } = {}) {
  const migration = await validationStage("storage_contract", () =>
    ensureAiProfileStorageV2(settings));
  const active = await validationStage("active_profile", () =>
    requireActiveAiProfile(migration.state));
  const selectedSettings = {
    ...settings,
    aiProvider: active.provider.provider,
    aiBaseUrl:
      active.provider.endpoint === "default" ? "" : active.provider.endpoint,
    aiModel: active.model,
  };
  const classification = classifyAiRuntime(selectedSettings);
  if (classification.conflict) {
    const error = new TypeError(
      "The selected Cloud AI provider has a Local AI endpoint. Re-select the Provider before translating.",
    );
    error.code = "ai_provider_endpoint_conflict";
    throw error;
  }
  const controller = createAiProfileActivationController({
    state: migration.state,
    credentials: migration.credentials,
    prompts: migration.prompts,
    defaults: canonicalDefaults(classification.local),
  });
  const selected = await validationStage("profile_selection", () => controller.select(
    {
      runtime: classification.runtime,
      provider: selectedSettings.aiProvider,
      endpoint: selectedSettings.aiBaseUrl,
      model: selectedSettings.aiModel,
    },
    { language },
  ));
  const activated = await validationStage("effective_profile", () =>
    resolveEffectiveAiProfile(selected));
  const profile = activated.profile || {};
  const local = classification.local;
  const registeredCloud = local ? null : cloudProviderSpec(selectedSettings.aiProvider);
  const canonicalCloudBase = local
    ? ""
    : registeredCloud
      ? String(registeredCloud.baseUrl || "")
      : String(selectedSettings.aiBaseUrl || "");
  const localAdapter = !local ? null
    : selectedSettings.aiProvider === "customlocal"
      // An old flat rollback field must never bring a named preset into a
      // canonically selected Custom Local profile.
      ? settings.aiProvider === "customlocal"
        ? savedCustomLocalAdapter(settings.localAiAdapter, selectedSettings.aiBaseUrl)
        : null
      : isNamedLocalProvider(selectedSettings.aiProvider)
        ? normalizeLocalAiAdapter({
          ...localAiPreset(selectedSettings.aiProvider),
          ...(selectedSettings.aiBaseUrl ? { baseUrl: selectedSettings.aiBaseUrl } : {}),
        }, { provider: selectedSettings.aiProvider })
        : settings.localAiAdapter;
  const staleCloudEndpointCorrected = Boolean(
    canonicalCloudBase &&
    String(selectedSettings.aiBaseUrl || "").trim() &&
    String(selectedSettings.aiBaseUrl || "").trim() !== canonicalCloudBase
  );
  if (!local && !activated.credential) {
    const error = new TypeError("Canonical AI cloud profile credential is missing");
    error.code = "AI_PROFILE_INCOMPLETE";
    throw error;
  }
  const effective = {
    ...selectedSettings,
    aiBaseUrl: local ? selectedSettings.aiBaseUrl : canonicalCloudBase,
    localAiAdapter: localAdapter,
    aiKey: local ? "" : activated.credential,
    // Empty is an intentional canonical value; never resurrect a legacy prompt.
    aiPrompt: activated.prompt,
    aiPromptMode: activated.promptMode,
    aiPageImage: profile.pageImage || "off",
    aiMemoryMode: profile.memoryMode || "off",
    aiStyleExamples: profile.styleExamples === true,
    // User token ceiling for this model; null = the model/app default.
    aiTokenCeiling: activeTokenCeiling(profile),
    aiTranslationMode: local ? localProviderTranslationMode(selectedSettings.aiProvider) : "conversation",
    aiConversationReset: String(profile.conversationReset || "0"),
    aiThinking: profile.thinking || "minimum",
    aiLocalThinking: profile.thinking || "minimum",
    aiLocalCapacityMode:
      profile.concurrency?.mode || "auto",
    aiLocalManualConcurrency:
      Number(profile.concurrency?.max) || 0,
    aiModelCapabilities:
      local
        ? selectedSettings.aiLocalCapabilityHint?.modelCapabilities || {}
        : profile.providerOptions?.capabilityAccountHash === await shortHash(activated.credential)
          ? profile.providerOptions?.modelCapabilities || {}
          : {},
  };
  const unsupported = activated.unsupported;
  const audit = {
    version: AI_PROFILES_SCHEMA_VERSION,
    source: migration.fallbackUsed ? "profile_migrated" : "profile",
    providerHash: await shortHash(selectedSettings.aiProvider),
    identityHash: await shortHash(activated.providerIdentity),
    profileHash: await shortHash(stableString(profile)),
    profileRevision: Number(
      migration.state?.providers?.[activated.providerIdentity]?.models?.[
        activated.target?.model
      ]?.updatedAt || 0,
    ),
    provider: String(selectedSettings.aiProvider || "auto"),
    model: String(selectedSettings.aiModel || "auto"),
    runtime: classification.runtime,
    classificationReason: classification.reason,
    configurationConflict: classification.conflict,
    endpointCorrection: staleCloudEndpointCorrected
      ? { reason: "named_cloud_provider_endpoint_bound", effective: canonicalCloudBase }
      : null,
    unsupported,
  };
  return immutableCopy({ settings: effective, audit });
}

// Share only an in-flight read; no cached wallet can authorize a later job.
const paidProfileReads = new Map();
async function paidProfileRead(url, options, fetcher) {
  const key = JSON.stringify([url, options.headers?.Authorization || '']);
  let pending = paidProfileReads.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetcher(url, options);
      return {ok:response.ok,status:response.status,data:response.ok ? await response.json() : null};
    })();
    paidProfileReads.set(key, pending);
    const clear = () => { if (paidProfileReads.get(key) === pending) paidProfileReads.delete(key); };
    pending.then(clear, clear);
  }
  return structuredClone(await pending);
}

export async function resolveJobAiProfile(settings, { language = "en" } = {}) {
  if (settings.aiServiceMode !== "paid")
    return resolveManualJobAiProfile(settings, { language });
  // 10495: Paid and every Login provider use the TextPhantom account. Without
  // data-use consent nothing is sent (not even the public /meta read) and the
  // balance is untouched; the account token is read only through the gate.
  const session = await readAccountSession();
  if (!session.consent) throw dataConsentError();
  const base = await resolveApiBase();
  if (!base) {
    const error = new Error("Paid requires the TextPhantom API URL");
    error.code = "PAID_CENTER_UNAVAILABLE";
    throw error;
  }
  let advertised;
  try {
    const response = await paidProfileRead(base.replace(/\/+$/, "") + "/meta", {
      cache: "no-store", signal: AbortSignal.timeout(6000),
    }, fetch);
    if (!response.ok) throw new Error("API metadata unavailable");
    advertised = response.data;
  } catch {
    const error = new Error("Cannot verify the Paid service on this API");
    error.code = "PAID_CENTER_UNAVAILABLE";
    throw error;
  }
  if (advertised?.paid?.available !== true) {
    const error = new Error("Paid is unavailable on this API. Select Manual explicitly to use your own provider.");
    error.code = "PAID_CENTER_UNAVAILABLE";
    throw error;
  }
  const token = session.ok ? String(session.token).trim() : "";
  const model = String(settings.paidModel || "").trim();
  if (!token || (settings.paidTranslationSource !== "login" && !model) || normalizeUrl(session.base) !== normalizeUrl(base)) {
    const error = new Error("Sign in and select a Paid model in AI option");
    error.code = "PAID_LOGIN_REQUIRED";
    throw error;
  }
  const response = await paidProfileRead(base.replace(/\/+$/, "") + "/paid/me", {
    method: "GET", cache: "no-store", credentials: "omit", redirect: "error",
    headers: {Authorization: "Bearer " + token}, signal: withAccountSignal(AbortSignal.timeout(16000)),
  }, diagnosticFetch).catch(() => { const error = new Error("Cannot verify your Paid account. No translation was started."); error.code = "PAID_CENTER_UNAVAILABLE"; throw error; });
  if (!response.ok) {
    const error = new Error("Paid account verification failed. Refresh your account in AI option.");
    error.code = response.status === 401 ? "PAID_LOGIN_REQUIRED" : "PAID_CENTER_UNAVAILABLE";
    throw error;
  }
  const account = response.data;
  if (settings.paidTranslationSource === "login") {
    if (settings.loginMemoryStorageError) throw Object.assign(new Error("Login session storage is unavailable."), {code:"login_memory_storage_unavailable", stage:"browser_session_storage"});
    if (!account.addons?.entitlements?.some(x => x.code === "ai_login" && x.status === "active")) throw Object.assign(new Error("AI Login access is inactive. Contact support."), {code:"LOGIN_ADDON_REQUIRED"});
    const provider = String(settings.loginProvider || "");
    if (!/^login_(chatgpt|claude|gemini|deepseek|openrouter|huggingface)$/.test(provider)) throw Object.assign(new Error("Select a Login provider."), {code:"LOGIN_SESSION_REQUIRED"});
    const connectionKey = await loginAuthScope(base, token) + ":" + provider;
    const connection = settings.loginConnectionsV2?.[connectionKey];
    let sessionId = connection?.session?.provider === provider ? String(connection.session.id || "") : "";
    let loginModel = connection ? String(connection.model || settings.loginModel || "") : String(settings.loginModel || "");
    const apiRoot = base.replace(/\/+$/, "");
    const discover = async () => {
      // Discover the selected provider under the authenticated Center owner.
      // Popup hydration is presentation, never a prerequisite for translation.
      const response = await diagnosticFetch(apiRoot + "/login/providers", {
        method:"GET",cache:"no-store",credentials:"omit",redirect:"error",headers:{Authorization:"Bearer "+token},signal:withAccountSignal(AbortSignal.timeout(16000))});
      const discovered = await response.json();
      if (!response.ok) throw Object.assign(new Error(discovered?.error?.message || "Could not verify Login connections."), {code:discovered?.error?.code || "LOGIN_UNAVAILABLE"});
      const current = discovered.providers?.find(row => row.id === provider)?.session;
      if (current?.provider !== provider || !/^lgs_[a-f0-9]{48}$/.test(current?.id || "")) throw Object.assign(new Error("The " + provider.replace(/^login_/, "") + " Login connection ended (sign-in expired or the API restarted). Open TextPhantom and press Login once."), {code:settings.loginSessionId || connection ? "LOGIN_SESSION_EXPIRED" : "LOGIN_SESSION_REQUIRED"});
      return current.id;
    };
    const readModels = async id => {
      const res = await diagnosticFetch(apiRoot + "/login/providers/" + provider + "/models?session_id=" + encodeURIComponent(id), {
        method:"GET",cache:"no-store",credentials:"omit",redirect:"error",headers:{Authorization:"Bearer "+token},signal:withAccountSignal(AbortSignal.timeout(16000))});
      return {res, data: await res.json()};
    };
    const fromStorage = /^lgs_[a-f0-9]{48}$/.test(sessionId);
    if (!fromStorage) sessionId = await discover();
    let {res, data} = await readModels(sessionId);
    if (fromStorage && res.status === 401 && data?.error?.code === "login_session_expired") {
      // A stored handle can outlive its API session (restart, reconnect
      // in another window). Ask the API for this owner's current session once
      // instead of requiring the popup; never invent or reuse another owner.
      recordDiagnostic("login.session.rediscover", {provider, reason:"stored_session_expired"}, base);
      sessionId = await discover();
      ({res, data} = await readModels(sessionId));
    }
    if (!res.ok) throw Object.assign(new Error(data?.error?.message || "AI Login is unavailable."), {code:data?.error?.code || "LOGIN_UNAVAILABLE"});
    if (!loginModel) loginModel = data.models?.find(x => !loginModelUnavailable(x))?.id || "";
    const selected = data.models?.find(x => x.id === loginModel);
    if (!selected || data.session?.id !== sessionId || data.session?.provider !== provider) throw Object.assign(new Error("The Login model is unavailable. Refresh your connection."), {code:"LOGIN_MODEL_UNAVAILABLE"});
    // The website already refused this model for this account; nothing is sent.
    if (loginModelUnavailable(selected)) throw Object.assign(new Error("Your account on the website cannot use this model (it may need an upgraded plan). Choose another model in AI settings. Nothing was sent."), {code:"LOGIN_MODEL_ACCESS_DENIED", requestDispatched:false});
    const entry = loginEntry(settings, base, provider, data.session.account_id, loginModel, language);
    const profile = entry.profile;
    const scopedModel = sessionId + "/" + loginModel;
    const websiteThinking = ["browser_webchat","web_endpoint"].includes(data.session.transport) &&
      selected.model_capabilities?.reasoning?.app_controlled !== true;
    return immutableCopy({settings:{...settings, aiProvider:"login",aiModel:scopedModel,aiBaseUrl:"",aiKey:token,
      aiPrompt:entry.prompts[language].text,aiPromptMode:"replace",aiPageImage:profile.pageImage,aiMemoryMode:profile.memoryMode,
      aiCharMemory:profile.memoryMode === "full",aiStyleExamples:profile.styleExamples === true,aiConversationReset:profile.conversationReset,
      aiTranslationMode:"conversation",aiModelCapabilities:normalizeModelCapabilities(selected.model_capabilities || {}),
      aiTokenCeiling:activeTokenCeiling(profile),
      // A web chat with a verified switch (DeepSeek DeepThink) uses the
      // user's choice; other web chats keep the website's own default.
      aiThinking:websiteThinking ? "default" : profile.thinking,
      aiLocalThinking:websiteThinking ? "default" : profile.thinking},
      audit:{version:AI_PROFILES_SCHEMA_VERSION,source:"login_profile",runtime:"cloud",provider:"login",model:scopedModel,
      profileHash:await shortHash(stableString(profile)),identityHash:await shortHash(base+provider+data.session.account_id),credentialOwner:"customer_provider_account",unsupported:[]}});
  }
  if (account.paid_restriction?.blocked === true) {
    recordDiagnostic("paid.preflight.blocked", {error_code: account.paid_restriction.code || "PAID_ACCOUNT_RESTRICTED", reason: account.paid_restriction.reason || "refund_dispute_review", provider_dispatched: false, credit_reserved: false}, base);
    const error = new Error(account.paid_restriction.reason === "refund_pending" ? "Paid is temporarily paused while your refund is calculated and confirmed. Your account and history remain available." : "Paid is restricted while the operator reviews a refund/dispute. Contact the operator. Your account and history remain available.");
    error.code = account.paid_restriction.code || "PAID_ACCOUNT_RESTRICTED"; throw error;
  }
  if (account.paid_paused === true || account.paid_status?.state === "paused") {
    recordDiagnostic("paid.preflight.blocked", {error_code: "PAID_PAUSED", reason: account.paid_status?.reason || "unknown", provider_dispatched: false, credit_reserved: false}, base);
    const error = new Error("Paid translation is temporarily paused. No new translation was started.");
    error.code = "PAID_PAUSED"; throw error;
  }
  const selected = account.models?.find(item => item.id === model);
  if (!selected) { const error = new Error("The selected Paid model is not enabled. Refresh your Paid account."); error.code = "PAID_MODEL_NOT_ALLOWED"; throw error; }
  if (selected.availability?.available === false) throw Object.assign(new Error("This Paid model is temporarily paused. Choose a different model or try again later."), {code:"PAID_MODEL_PAUSED"});
  // Display metadata is not admission authority. Current prices and credit
  // admission are checked by the API/Center for each actual AI operation.
  // Migrate only intent, not credentials. The canonical Manual profile remains independent.
  let stored = settings;
  try {
    const migration = await ensureAiProfileStorageV2(settings);
    stored = {...settings, ...(migration.effective || {}), aiProfilesV1: migration.state, aiProfilePromptsV1: migration.prompts};
  } catch { /* Paid does not require a configured Manual credential/profile. */ }
  const entry = paidEntry(stored, base, model, language);
  const profile = entry.profile;
  const caps = normalizeModelCapabilities(selected.model_capabilities || {});
  // The API obtains a current options-bound quote after checking the owned
  // operation receipt. A click-time quote duplicated that work and is not used.
  const paidSettings = {...settings};
  delete paidSettings.aiPaidQuoteToken;
  delete paidSettings.aiPaidPricing;
  return immutableCopy({
    settings: {...paidSettings, aiProvider: "paid", aiModel: model, aiBaseUrl: "", aiKey: token,
      // Center's configured per-request ceiling for this model (planning only).
      aiPaidRequestBudget: Number.isSafeInteger(selected.max_output) && selected.max_output >= 256 ? selected.max_output : 8192,
      aiPrompt: entry.prompts[language].text, aiPromptMode: "replace",
      aiPageImage: profile.pageImage, aiMemoryMode: profile.memoryMode,
      aiCharMemory: profile.memoryMode === "full", aiStyleExamples: profile.styleExamples === true,
      aiTokenCeiling: activeTokenCeiling(profile),
      aiConversationReset: profile.conversationReset, aiTranslationMode: "conversation",
      aiModelCapabilities: caps, aiThinking: profile.thinking, aiLocalThinking: profile.thinking,
      // Click-time credit check only (never sent to the API or a provider).
      aiPaidCreditCheck: {apiBase: base, availableTp: account.credits?.available ?? null,
        pricing: selected.pricing ? {input_tp: selected.pricing.input_tp ?? null, output_tp: selected.pricing.output_tp ?? null} : null}},
    audit: {version: AI_PROFILES_SCHEMA_VERSION, source: "paid_profile", runtime: "cloud",
      provider: "paid", model, profileHash: await shortHash(stableString(profile)),
      identityHash: await shortHash(base), credentialOwner: "control_center", unsupported: []},
  });
}
