import { normalizeModelCapabilities } from "./model-capabilities.js";
/** Pure, opt-in Provider + Model profile core. Runtime activation is external. */
import { normalizePrompt, makeProfilePromptKey } from "./prompt.js";
import { isLocalAiProvider, isLocalAiTarget } from "./constants.js";
import { AI_PROMPT_MODE } from "./ai-prompt-policy.js";

export { makeProfilePromptKey };
export const AI_PROFILES_SCHEMA_VERSION = 1;
export const AI_PROFILE_PROVIDER_OPTIONS = new Set([
  "reasoningEffort",
  "reasoningExclude",
  "responseFormat",
  "modelCapabilities",
  "capabilityAccountHash",
]);

const object = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const clone = (v) => JSON.parse(JSON.stringify(v));
const bytesOf = (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const providerName = (v) =>
  safeKey(
    String(v || "")
      .trim()
      .toLowerCase() || "auto",
    "provider",
  );
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROFILE_FIELDS = new Set([
  "thinking",
  "tokenPolicy",
  "temperature",
  "pageImage",
  "memoryMode",
  "concurrency",
  "providerOptions",
]);
const TOKEN_FIELDS = new Set(["mode", "maxOutputTokens"]);
const CONCURRENCY_FIELDS = new Set(["mode", "max"]);
const TOKEN_MODES = new Set(["auto", "dynamic", "manual"]);
const CONCURRENCY_MODES = new Set(["auto", "safe", "manual"]);
const SENSITIVE_QUERY =
  /(?:^|[-_])(api[-_]?key|key|token|secret|password|passwd|auth|authorization|signature)(?:$|[-_])/i;

function safeKey(value, label) {
  const key = String(value || "").trim();
  if (!key || RESERVED_KEYS.has(key))
    throw new TypeError(`Invalid ${label} key`);
  return key;
}

function endpointUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || ["default", "auto"].includes(raw.toLowerCase())) return "default";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("Invalid provider endpoint URL");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new TypeError("Unsupported provider endpoint protocol");
  if (url.username || url.password)
    throw new TypeError("Credentials are not allowed in provider endpoint URL");
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key))
      throw new TypeError("Sensitive provider endpoint query is not allowed");
  }
  const sortedQuery = [...url.searchParams.entries()].sort(
    ([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv),
  );
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();
  for (const [key, value] of sortedQuery) url.searchParams.append(key, value);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function providerIdentityFromNormalized(provider, endpoint) {
  return `${encodeURIComponent(providerName(provider))}::${encodeURIComponent(endpoint)}`;
}

function profileProviderIsLocal(provider, endpoint) {
  const id = providerName(provider);
  return isLocalAiProvider(id) ||
    (id === "auto" && isLocalAiTarget(id, endpoint === "default" ? "" : endpoint));
}

export function makeProviderIdentity(provider, endpoint) {
  return providerIdentityFromNormalized(provider, endpointUrl(endpoint));
}

function promptRecord(value, { allowLegacyString = false } = {}) {
  if (typeof value === "string") {
    if (!allowLegacyString) {
      const error = new TypeError("Canonical AI prompt record must include text and mode");
      error.code = "AI_PROFILE_INVALID";
      throw error;
    }
    return { text: normalizePrompt(value), mode: AI_PROMPT_MODE };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.text !== "string" || value.mode !== AI_PROMPT_MODE) {
    const error = new TypeError("Canonical AI prompt record is invalid");
    error.code = "AI_PROFILE_INVALID";
    throw error;
  }
  const source = value;
  return {
    text: normalizePrompt(source.text),
    mode: source.mode,
  };
}

export function normalizeAiProfilePrompts(input, { allowLegacyStrings = false } = {}) {
  const output = {};
  for (const [key, value] of Object.entries(object(input))) {
    try {
      safeKey(key, "prompt");
    } catch {
      if (allowLegacyStrings) continue;
      const error = new TypeError("Canonical AI prompt key is invalid");
      error.code = "AI_PROFILE_INVALID";
      throw error;
    }
    output[key] = promptRecord(value, { allowLegacyString: allowLegacyStrings });
  }
  return output;
}

export function getAiProfilePrompt(prompts, key) {
  safeKey(key, "prompt");
  const source = object(prompts);
  if (!Object.hasOwn(source, key)) return { text: "", mode: AI_PROMPT_MODE };
  return promptRecord(source[key]);
}

export function setAiProfilePrompt(prompts, key, { text = "", mode = AI_PROMPT_MODE } = {}) {
  safeKey(key, "prompt");
  if (mode !== AI_PROMPT_MODE)
    throw new TypeError("Unsupported AI prompt mode");
  return {
    ...normalizeAiProfilePrompts(prompts),
    [key]: { text: normalizePrompt(text), mode },
  };
}

export function resetAiProfilePrompt(prompts, key) {
  safeKey(key, "prompt");
  const output = normalizeAiProfilePrompts(prompts);
  delete output[key];
  return output;
}

export function createAiProfiles() {
  return {
    version: 1,
    active: { providerIdentity: "", model: "auto" },
    providers: {},
  };
}

function validState(v) {
  if (
    !v ||
    Array.isArray(v) ||
    v.version !== 1 ||
    !v.active ||
    typeof v.active !== "object" ||
    Array.isArray(v.active) ||
    typeof v.active.providerIdentity !== "string" ||
    typeof v.active.model !== "string" ||
    !v.active.model.trim() ||
    !v.providers ||
    typeof v.providers !== "object" ||
    Array.isArray(v.providers)
  )
    return false;
  try {
    for (const [identity, provider] of Object.entries(v.providers)) {
      safeKey(identity, "provider");
      if (!provider || typeof provider !== "object" || Array.isArray(provider))
        return false;
      if (typeof provider.provider !== "string" || !provider.provider.trim() ||
          typeof provider.endpoint !== "string" ||
          !Number.isFinite(provider.updatedAt) || provider.updatedAt < 0 ||
          (Object.hasOwn(provider, "credentialRef") && typeof provider.credentialRef !== "string"))
        return false;
      if (
        !provider.models ||
        typeof provider.models !== "object" ||
        Array.isArray(provider.models)
      )
        return false;
      if (makeProviderIdentity(provider.provider, provider.endpoint) !== identity)
        return false;
      for (const [model, entry] of Object.entries(provider.models)) {
        safeKey(model, "model");
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return false;
        if (!Number.isFinite(entry.updatedAt) || entry.updatedAt < 0) return false;
        if (
          !entry.profile ||
          typeof entry.profile !== "object" ||
          Array.isArray(entry.profile)
        )
          return false;
        // Canonical v1 is a contract, not a bag of best-effort legacy values.
        // Validate persisted profile values strictly so corrupt enums cannot be
        // silently dropped and then mistaken for defaults.
        mergedProfile({}, {}, entry.profile);
      }
    }
  } catch {
    return false;
  }
  return true;
}

function normalizeState(input) {
  if (!validState(input)) {
    const error = new TypeError("Canonical AI profile schema is invalid");
    error.code = "AI_PROFILE_INVALID";
    throw error;
  }
  const source = clone(input);
  const state = createAiProfiles();
  state.active = {
    providerIdentity:
      typeof source.active?.providerIdentity === "string"
        ? source.active.providerIdentity
        : "",
    model:
      typeof source.active?.model === "string" && source.active.model
        ? source.active.model
        : "auto",
  };
  state.providers = {};
  for (const [identity, rawProvider] of Object.entries(source.providers)) {
    safeKey(identity, "provider");
    const providerId = providerName(rawProvider.provider);
    const endpoint = endpointUrl(rawProvider.endpoint);
    const provider = {
      provider: providerId,
      endpoint,
      models: {},
      updatedAt: Number(rawProvider.updatedAt) || 0,
      ...(!profileProviderIsLocal(providerId, endpoint)
        ? { credentialRef: String(rawProvider.credentialRef || identity) }
        : {}),
    };
    for (const [model, entry] of Object.entries(rawProvider.models)) {
      safeKey(model, "model");
      provider.models[model] = {
        profile: mergedProfile({}, entry.profile),
        updatedAt: Number(entry.updatedAt) || 0,
      };
    }
    state.providers[identity] = provider;
  }
  return state;
}

/** Validate a canonical v1 state for dispatch and return its active record. */
export function requireActiveAiProfile(input) {
  if (!validState(input)) {
    const error = new TypeError("Canonical AI profile schema is invalid");
    error.code = "AI_PROFILE_INVALID";
    throw error;
  }
  const state = normalizeState(input);
  const identity = state.active.providerIdentity;
  const model = state.active.model;
  const provider = state.providers[identity];
  if (!identity || !model || !provider || !provider.models?.[model]) {
    const error = new TypeError("Canonical AI profile active selection is incomplete");
    error.code = "AI_PROFILE_INCOMPLETE";
    throw error;
  }
  return { state, identity, model, provider, profile: provider.models[model].profile };
}

function plainNested(input, label, strict) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    if (strict) throw new TypeError(`${label} must be an object`);
    return {};
  }
  return input;
}

function boundedInteger(value, min, max, label, strict) {
  if (Number.isInteger(value) && value >= min && value <= max) return value;
  if (strict)
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  return undefined;
}

function tokenPolicy(input, strict = false) {
  const source = plainNested(input, "tokenPolicy", strict);
  for (const key of Object.keys(source)) {
    if (!TOKEN_FIELDS.has(key) && strict)
      throw new TypeError(`Unsupported tokenPolicy field: ${key}`);
  }
  const output = {};
  if (Object.hasOwn(source, "mode")) {
    if (TOKEN_MODES.has(source.mode)) output.mode = source.mode;
    else if (strict) throw new TypeError("Unsupported tokenPolicy mode");
  }
  if (Object.hasOwn(source, "maxOutputTokens")) {
    const minimum =
      output.mode === "manual" || source.mode === "manual" ? 1 : 0;
    const value = boundedInteger(
      source.maxOutputTokens,
      minimum,
      1_000_000,
      "maxOutputTokens",
      strict,
    );
    if (value !== undefined) output.maxOutputTokens = value;
  }
  return output;
}

function concurrencyPolicy(input, strict = false) {
  const source = plainNested(input, "concurrency", strict);
  for (const key of Object.keys(source)) {
    if (!CONCURRENCY_FIELDS.has(key) && strict)
      throw new TypeError(`Unsupported concurrency field: ${key}`);
  }
  const output = {};
  if (Object.hasOwn(source, "mode")) {
    if (CONCURRENCY_MODES.has(source.mode)) output.mode = source.mode;
    else if (strict) throw new TypeError("Unsupported concurrency mode");
  }
  if (Object.hasOwn(source, "max")) {
    const minimum =
      output.mode === "manual" || source.mode === "manual" ? 1 : 0;
    const value = boundedInteger(
      source.max,
      minimum,
      32,
      "concurrency max",
      strict,
    );
    if (value !== undefined) output.max = value;
  }
  return output;
}

function providerOptions(input, strict = false) {
  const source = plainNested(input, "providerOptions", strict);
  const output = {};
  for (const [key, value] of Object.entries(source)) {
    if (!AI_PROFILE_PROVIDER_OPTIONS.has(key)) {
      if (strict)
        throw new TypeError(`Unsupported providerOptions key: ${key}`);
      continue;
    }
    if (key === "modelCapabilities") {
      const normalized = normalizeModelCapabilities(value);
      if (Object.keys(normalized).length) output[key] = normalized;
      else if (strict && (!value || typeof value !== "object" || Array.isArray(value)))
        throw new TypeError("Invalid providerOptions value for modelCapabilities");
    } else if (key === "capabilityAccountHash") {
      if (typeof value === "string" && /^[a-f0-9]{16}$/.test(value)) output[key] = value;
      else if (strict) throw new TypeError("Invalid providerOptions value for capabilityAccountHash");
    } else if (key === "reasoningExclude" && typeof value === "boolean")
      output[key] = value;
    else if (
      key === "reasoningEffort" &&
      ["low", "medium", "high"].includes(value)
    )
      output[key] = value;
    else if (
      key === "responseFormat" &&
      ["text", "json_object"].includes(value)
    )
      output[key] = value;
    else if (strict)
      throw new TypeError(`Invalid providerOptions value for ${key}`);
  }
  return output;
}

function mergedProfile(defaults, stored, patch = null) {
  const clean = (input, strict) => {
    const output = {};
    for (const [key, value] of Object.entries(object(input))) {
      if (!PROFILE_FIELDS.has(key)) {
        if (strict) throw new TypeError(`Unsupported profile field: ${key}`);
        continue;
      }
      output[key] = clone(value);
    }
    return output;
  };
  const base = clean(defaults, false);
  const current = clean(stored, false);
  // New writes reject unknown fields; stored legacy/corrupt fields are dropped.
  const change = clean(patch, patch != null);
  const output = { ...base, ...current, ...change };
  output.tokenPolicy = {
    ...tokenPolicy(base.tokenPolicy),
    ...tokenPolicy(current.tokenPolicy),
    ...tokenPolicy(
      change.tokenPolicy,
      patch != null && Object.hasOwn(change, "tokenPolicy"),
    ),
  };
  output.concurrency = {
    ...concurrencyPolicy(base.concurrency),
    ...concurrencyPolicy(current.concurrency),
    ...concurrencyPolicy(
      change.concurrency,
      patch != null && Object.hasOwn(change, "concurrency"),
    ),
  };
  output.providerOptions = {
    ...providerOptions(base.providerOptions),
    ...providerOptions(current.providerOptions),
    ...providerOptions(
      change.providerOptions,
      patch != null && Object.hasOwn(change, "providerOptions"),
    ),
  };
  // Off is the canonical safe default. Historical Auto/missing/malformed
  // values migrate to Off; only an explicit On survives normalization.
  output.thinking = output.thinking === true || output.thinking === "on" ? "on"
    : "off";
  if (
    output.temperature !== null &&
    !(
      typeof output.temperature === "number" &&
      Number.isFinite(output.temperature) &&
      output.temperature >= 0 &&
      output.temperature <= 2
    )
  )
    delete output.temperature;
  if (!["off", "always"].includes(output.pageImage)) delete output.pageImage;
  if (!["off", "terms", "full"].includes(output.memoryMode))
    delete output.memoryMode;
  for (const key of [
    "apiKey",
    "aiCloudKey",
    "credentialRef",
    "endpoint",
    "baseUrl",
  ])
    delete output[key];
  return output;
}

export function resolveAiProfile(state, request) {
  if (!validState(state)) {
    const error = new TypeError("Canonical AI profile schema is invalid");
    error.code = "AI_PROFILE_INVALID";
    throw error;
  }
  const providerIdentity = makeProviderIdentity(
    request?.provider,
    request?.endpoint,
  );
  const model = safeKey(String(request?.model || "").trim() || "auto", "model");
  const stored = object(object(state?.providers)[providerIdentity]?.models)[
    model
  ]?.profile;
  return {
    state,
    providerIdentity,
    model,
    profile: mergedProfile(request?.defaults, stored),
  };
}

export function updateAiProfile(input, request) {
  const state = normalizeState(input);
  const provider = providerName(request?.provider);
  const endpoint = endpointUrl(request?.endpoint);
  // `endpoint` is already canonical here. Do not parse the `default`
  // sentinel as a URL a second time.
  const providerIdentity = providerIdentityFromNormalized(provider, endpoint);
  const model = safeKey(String(request?.model || "").trim() || "auto", "model");
  const local = profileProviderIsLocal(provider, endpoint);
  const record = state.providers[providerIdentity] || {
    provider,
    endpoint,
    models: {},
    updatedAt: 0,
    ...(!local ? { credentialRef: providerIdentity } : {}),
  };
  if (local) delete record.credentialRef;
  const previous = object(record.models)[model]?.profile;
  record.models = object(record.models);
  record.models[model] = {
    profile: mergedProfile(request?.defaults, previous, request?.patch || {}),
    updatedAt: Number(request?.now) || 0,
  };
  record.updatedAt = Math.max(
    Number(record.updatedAt) || 0,
    Number(request?.now) || 0,
  );
  state.providers[providerIdentity] = record;
  if (request?.select === true) state.active = { providerIdentity, model };
  return state;
}

const legacyEffective = (legacy) => ({
  aiProvider: providerName(legacy?.aiProvider),
  aiBaseUrl: String(legacy?.aiBaseUrl || ""),
  aiModel: String(legacy?.aiModel || "").trim() || "auto",
});

function canonicalEffective(state) {
  const identity = String(state?.active?.providerIdentity || "");
  const provider = object(state?.providers)[identity];
  const model = String(state?.active?.model || "").trim() || "auto";
  return {
    aiProvider: provider.provider,
    aiBaseUrl: provider.endpoint === "default" ? "" : provider.endpoint,
    aiModel: model,
  };
}

function credentialsForState(state, input) {
  const output = {};
  for (const [identity, secret] of Object.entries(object(input))) {
    const provider = state.providers[identity];
    let local = false;
    if (provider) {
      local = profileProviderIsLocal(provider.provider, provider.endpoint);
    } else {
      // Credentials may outlive an inactive/stale model. Decode only the two
      // identity components needed to identify Local targets; malformed keys
      // remain untouched rather than risking deletion of a Cloud credential.
      const separator = identity.indexOf("::");
      if (separator > 0) {
        try {
          const providerId = decodeURIComponent(identity.slice(0, separator));
          const endpoint = decodeURIComponent(identity.slice(separator + 2));
          local = profileProviderIsLocal(providerId, endpoint);
        } catch {
          local = false;
        }
      }
    }
    if (local) continue;
    if (typeof secret === "string" && secret) output[identity] = secret;
  }
  return output;
}

export function migrateAiProfiles({
  stored,
  credentials = {},
  prompts = {},
  legacy = {},
  now = 0,
} = {}) {
  // Callers historically represent a missing chrome.storage key as either
  // undefined or null. No other falsey/coercive value is treated as absent.
  const canonicalPresent = stored != null;
  if (canonicalPresent && !validState(stored)) {
    const error = new TypeError("Canonical AI profile schema is invalid");
    error.code = "AI_PROFILE_INVALID";
    throw error;
  }
  const fallbackUsed = !canonicalPresent;
  const legacyFallback = legacyEffective(legacy);
  if (!fallbackUsed) {
    const { state } = requireActiveAiProfile(stored);
    const normalizedCredentials = credentialsForState(state, credentials);
    return {
      state,
      credentials: normalizedCredentials,
      prompts: normalizeAiProfilePrompts(prompts),
      // Once a valid canonical schema exists, stale rollback keys must never
      // choose the active Provider/endpoint/model. The flat values remain a
      // derived compatibility output of buildAiProfileStoragePatch().
      effective: canonicalEffective(state),
      // Reading/opening is side-effect free. In-memory credential sanitation
      // does not turn hydration into a storage write.
      changed: false,
      fallbackUsed: false,
    };
  }
  const effective = legacyFallback;
  const identity = makeProviderIdentity(
    effective.aiProvider,
    effective.aiBaseUrl,
  );
  const defaults = {
    thinking: legacy.aiThinking === true || legacy.aiThinking === "on" ? "on" : "off",
    tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
    temperature: null,
    pageImage:
      legacy.aiPageImage === "always" || legacy.aiSendImage === true
        ? "always"
        : "off",
    memoryMode: ["off", "terms", "full"].includes(legacy.aiMemoryMode)
      ? legacy.aiMemoryMode
      : "off",
    concurrency: { mode: "auto", max: 0 },
    providerOptions: {},
  };
  const state = updateAiProfile(createAiProfiles(), {
    provider: effective.aiProvider,
    endpoint: effective.aiBaseUrl,
    model: effective.aiModel,
    defaults,
    patch: {},
    select: true,
    now,
  });
  const nextCredentials = credentialsForState(state, credentials);
  const secret =
    typeof legacy.aiCloudKey === "string"
      ? legacy.aiCloudKey
      : typeof legacy.aiKey === "string"
        ? legacy.aiKey
        : "";
  const local = profileProviderIsLocal(effective.aiProvider, effective.aiBaseUrl || "default");
  if (!local && secret) nextCredentials[identity] = secret;
  if (local) delete nextCredentials[identity];
  const nextPrompts = normalizeAiProfilePrompts(prompts, { allowLegacyStrings: true });
  const fallbackLang =
    String(legacy.lang || "th")
      .trim()
      .toLowerCase() || "th";
  for (const [oldKey, value] of Object.entries(object(legacy.aiPromptByLang))) {
    if (typeof value !== "string" || !value.trim()) continue;
    const language = safeKey(
      String(oldKey).split("::")[0].trim().toLowerCase() || fallbackLang,
      "language",
    );
    nextPrompts[makeProfilePromptKey(identity, effective.aiModel, language)] =
      promptRecord(value, { allowLegacyString: true });
  }
  if (
    !Object.keys(nextPrompts).length &&
    typeof legacy.aiPrompt === "string" &&
    legacy.aiPrompt.trim()
  ) {
    nextPrompts[
      makeProfilePromptKey(identity, effective.aiModel, fallbackLang)
    ] = promptRecord(legacy.aiPrompt, { allowLegacyString: true });
  }
  return {
    state,
    credentials: nextCredentials,
    prompts: nextPrompts,
    effective,
    changed: true,
    fallbackUsed: true,
  };
}

export function buildAiProfileStoragePatch({
  state,
  credentials = {},
  prompts = {},
  providerIdentity,
  model,
  language,
} = {}) {
  const normalized = normalizeState(state);
  const provider = normalized.providers[providerIdentity];
  safeKey(providerIdentity, "provider");
  safeKey(model, "model");
  safeKey(language || "en", "language");
  const profile = provider?.models?.[model]?.profile;
  if (!provider || !profile)
    throw new TypeError("Unknown Provider + Model profile");
  const normalizedCredentials = credentialsForState(normalized, credentials);
  const secret = normalizedCredentials[providerIdentity];
  const local = profileProviderIsLocal(provider.provider, provider.endpoint);
  return {
    aiProfileStorageVersion: 4,
    aiProfilesV1: normalized,
    aiProfileCredentialsV1: normalizedCredentials,
    aiProfilePromptsV1: normalizeAiProfilePrompts(prompts),
    aiProvider: provider.provider,
    aiBaseUrl: provider.endpoint === "default" ? "" : provider.endpoint,
    aiModel: model,
    aiThinking: profile.thinking,
    aiPageImage: profile.pageImage,
    aiMemoryMode: profile.memoryMode,
    aiPrompt: getAiProfilePrompt(
      prompts,
      makeProfilePromptKey(providerIdentity, model, language),
    ).text,
    // Cloud identities explicitly clear the rollback field when they have no
    // credential; storage.set() merges objects and omission would retain the
    // previously selected Cloud endpoint's key. Local identities never emit it.
    ...(!local ? { aiCloudKey: typeof secret === "string" ? secret : "" } : {}),
  };
}

export function pruneAiProfiles(input, { maxBytes = Infinity } = {}) {
  const state = normalizeState(input);
  const evicted = [];
  const candidates = [];
  for (const [identity, provider] of Object.entries(state.providers)) {
    for (const [model, entry] of Object.entries(provider.models)) {
      if (
        identity !== state.active.providerIdentity ||
        model !== state.active.model
      ) {
        candidates.push({
          identity,
          model,
          updatedAt: Number(entry.updatedAt) || 0,
        });
      }
    }
  }
  candidates.sort(
    (a, b) =>
      a.updatedAt - b.updatedAt ||
      a.identity.localeCompare(b.identity) ||
      a.model.localeCompare(b.model),
  );
  while (bytesOf(state) > maxBytes && candidates.length) {
    const item = candidates.shift();
    delete state.providers[item.identity].models[item.model];
    evicted.push(`${item.identity}\u0000${item.model}`);
    if (!Object.keys(state.providers[item.identity].models).length)
      delete state.providers[item.identity];
  }
  const bytes = bytesOf(state);
  return {
    state,
    evicted,
    bytes,
    limit: maxBytes,
    overBudget: bytes > maxBytes,
  };
}

function shortHash(value) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function sanitizeAiProfileTrace({ state } = {}) {
  const normalized = normalizeState(state);
  return {
    version: normalized.version,
    active: {
      providerHash: normalized.active.providerIdentity
        ? shortHash(normalized.active.providerIdentity)
        : "",
      modelCounted: Boolean(normalized.active.model),
    },
    providers: Object.values(normalized.providers).map((provider) => ({
      providerHash: shortHash(provider.provider),
      endpointHash: shortHash(provider.endpoint),
      modelCount: Object.keys(provider.models).length,
    })),
  };
}

export const exportAiProfiles = sanitizeAiProfileTrace;
