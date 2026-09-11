/** One-time persisted migration boundary for the strict AI profile runtime. */
import { getStorage, setStorage } from "./storage.js";
import {
  makeProviderIdentity,
  migrateAiProfiles,
  normalizeAiProfilePrompts,
  requireActiveAiProfile,
} from "./ai-profiles.js";
import { classifyAiRuntime } from "./ai-settings-contract.js";
import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../generated/canonical-prompt-plans.js";

export const AI_PROFILE_STORAGE_VERSION = 4;
export const AI_PROFILE_STORAGE_VERSION_KEY = "aiProfileStorageVersion";
export const AI_PROFILE_STORAGE_KEYS = [
  AI_PROFILE_STORAGE_VERSION_KEY,
  "aiProfilesV1",
  "aiProfileCredentialsV1",
  "aiProfilePromptsV1",
];

let migrationInFlight = null;

// This is the exact SHA-256 of the Thai built-in shipped through 2026.9.5.8.
// It is not a pattern or a generic fallback: only that immutable historical
// default may be advanced to the current bundled default. User-authored text
// remains authoritative, including text that differs by a single byte.
export const HISTORICAL_THAI_BUILTIN_SHA256 =
  "63dab12ca8e9f67b8b765542b72eaed4efd66e9d265d177719e35fc163b3ccff";

async function sha256Text(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value || "")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Replace only a byte-identical historical built-in; never infer/customize. */
export async function migrateKnownBuiltInPromptRecords(
  input,
  { historicalThaiHashes = [HISTORICAL_THAI_BUILTIN_SHA256] } = {},
) {
  const prompts = plain(input) ? structuredClone(input) : {};
  const currentThai = String(
    BUNDLED_CANONICAL_PROMPT_PLANS?.th?.pieces?.editableStyle || "",
  );
  let changed = false;
  if (!currentThai) return { prompts, changed };
  for (const [key, value] of Object.entries(prompts)) {
    const decoded = decodePromptKey(key);
    if (!decoded || String(decoded[2]).toLowerCase() !== "th") continue;
    const text = typeof value === "string" ? value : String(value?.text || "");
    if (!historicalThaiHashes.includes(await sha256Text(text))) continue;
    prompts[key] = { text: currentThai, mode: "replace" };
    changed = true;
  }
  return { prompts, changed };
}

function migrationError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeUnique(target, key, value, label) {
  if (!Object.hasOwn(target, key)) target[key] = value;
  else if (!equal(target[key], value))
    throw migrationError(
      "AI_PROFILE_MIGRATION_CONFLICT",
      `AI profile migration found conflicting ${label}`,
    );
}

function decodePromptKey(key) {
  const pieces = String(key).split("::");
  if (pieces.length !== 3) return null;
  try {
    return pieces.map((piece) => decodeURIComponent(piece));
  } catch {
    return null;
  }
}

function encodePromptKey(identity, model, language) {
  return [identity, model, language].map((part) => encodeURIComponent(part)).join("::");
}

function migratePromptRecordsToReplace(input) {
  const output = {};
  for (const [key, value] of Object.entries(plain(input) ? input : {}))
    output[key] = {
      text: typeof value === "string" ? value : String(value?.text || ""),
      mode: "replace",
    };
  return output;
}

/** Convert a markerless 9.4.12/9.4.13 record without accepting it at runtime. */
function migrateMarkerlessCanonical(stored, credentials, prompts, legacy) {
  if (!plain(stored) || stored.version !== 1 || !plain(stored.providers))
    throw migrationError(
      "AI_PROFILE_MIGRATION_INCOMPLETE",
      "Stored AI profile cannot be migrated because its canonical record is incomplete",
    );

  const next = {
    version: 1,
    active: { providerIdentity: "", model: String(stored.active?.model || "") },
    providers: {},
  };
  const identityMap = new Map();
  for (const [oldIdentity, raw] of Object.entries(stored.providers)) {
    if (!plain(raw) || !plain(raw.models))
      throw migrationError(
        "AI_PROFILE_MIGRATION_INCOMPLETE",
        "Stored AI provider record is incomplete",
      );
    if (classifyAiRuntime({
      aiProvider: raw.provider,
      aiBaseUrl: raw.endpoint === "default" ? "" : raw.endpoint,
    }).conflict)
      throw migrationError(
        "AI_PROFILE_MIGRATION_CONFLICT",
        "Stored Cloud provider points to a Local endpoint",
      );
    let identity;
    try {
      identity = makeProviderIdentity(raw.provider, raw.endpoint);
    } catch {
      throw migrationError(
        "AI_PROFILE_MIGRATION_INCOMPLETE",
        "Stored AI provider endpoint is invalid",
      );
    }
    identityMap.set(oldIdentity, identity);
    const candidate = { ...structuredClone(raw), models: {} };
    for (const [model, entry] of Object.entries(raw.models)) {
      if (!plain(entry) || !plain(entry.profile))
        throw migrationError(
          "AI_PROFILE_MIGRATION_INCOMPLETE",
          "Stored AI model profile is incomplete",
        );
      mergeUnique(candidate.models, model, structuredClone(entry), "model profiles");
    }
    if (!Object.hasOwn(next.providers, identity)) next.providers[identity] = candidate;
    else {
      const existing = next.providers[identity];
      if (String(existing.provider) !== String(candidate.provider) ||
          makeProviderIdentity(existing.provider, existing.endpoint) !== identity)
        throw migrationError("AI_PROFILE_MIGRATION_CONFLICT", "AI provider identities conflict");
      for (const [model, entry] of Object.entries(candidate.models))
        mergeUnique(existing.models, model, entry, "model profiles");
      existing.updatedAt = Math.max(Number(existing.updatedAt) || 0, Number(candidate.updatedAt) || 0);
    }
  }

  const oldActive = String(stored.active?.providerIdentity || "");
  next.active.providerIdentity = identityMap.get(oldActive) || oldActive;
  const activeExists = Boolean(
    next.providers[next.active.providerIdentity]?.models?.[next.active.model],
  );
  if (!activeExists) {
    // Flat selection is migration evidence only. It may repair the pointer,
    // never synthesize a Provider/Model that was not already persisted.
    let flatIdentity = "";
    try {
      flatIdentity = makeProviderIdentity(legacy?.aiProvider, legacy?.aiBaseUrl);
    } catch {
      flatIdentity = "";
    }
    const flatModel = String(legacy?.aiModel || "").trim();
    if (flatIdentity && flatModel && next.providers[flatIdentity]?.models?.[flatModel])
      next.active = { providerIdentity: flatIdentity, model: flatModel };
    else
      throw migrationError(
        "AI_PROFILE_MIGRATION_INCOMPLETE",
        "Stored AI profile has no usable active Provider and Model",
      );
  }

  const nextCredentials = {};
  for (const [oldIdentity, secret] of Object.entries(plain(credentials) ? credentials : {})) {
    const identity = identityMap.get(oldIdentity) || oldIdentity;
    mergeUnique(nextCredentials, identity, secret, "provider credentials");
  }

  const nextPrompts = {};
  for (const [oldKey, value] of Object.entries(plain(prompts) ? prompts : {})) {
    const decoded = decodePromptKey(oldKey);
    if (!decoded)
      throw migrationError("AI_PROFILE_MIGRATION_INCOMPLETE", "Stored AI prompt key is invalid");
    const [oldIdentity, model, language] = decoded;
    const identity = identityMap.get(oldIdentity) || oldIdentity;
    const record = { text: typeof value === "string" ? value : String(value?.text || ""), mode: "replace" };
    const normalized = normalizeAiProfilePrompts({ value: record }).value;
    mergeUnique(nextPrompts, encodePromptKey(identity, model, language), normalized, "prompt records");
  }

  // Reuse the strict validators before anything can be persisted or activated.
  requireActiveAiProfile(next);
  return migrateAiProfiles({
    stored: next,
    credentials: nextCredentials,
    prompts: nextPrompts,
    legacy,
  });
}

export function prepareAiProfileStorageV2(stored, legacy = {}) {
  const marker = stored?.[AI_PROFILE_STORAGE_VERSION_KEY];
  if (marker === AI_PROFILE_STORAGE_VERSION) {
    if (stored.aiProfilesV1 == null)
      throw migrationError("AI_PROFILE_MIGRATION_INCOMPLETE", "AI profile v2 storage is incomplete");
    // A v2 marker is a strict boundary: never repair, sanitize, or consult flat keys.
    const result = migrateAiProfiles({
      stored: stored.aiProfilesV1,
      credentials: stored.aiProfileCredentialsV1,
      prompts: stored.aiProfilePromptsV1,
      legacy: {},
    });
    return { ...result, changed: false, patch: null };
  }
  if (marker === 2 || marker === 3) {
    const migratedPrompts = marker === 2
      ? migratePromptRecordsToReplace(stored.aiProfilePromptsV1)
      : stored.aiProfilePromptsV1;
    const result = migrateAiProfiles({
      stored: stored.aiProfilesV1,
      credentials: stored.aiProfileCredentialsV1,
      prompts: migratedPrompts,
      legacy: {},
    });
    return {
      ...result,
      changed: true,
      patch: {
        [AI_PROFILE_STORAGE_VERSION_KEY]: AI_PROFILE_STORAGE_VERSION,
        aiProfilesV1: result.state,
        aiProfileCredentialsV1: result.credentials,
        aiProfilePromptsV1: result.prompts,
      },
    };
  }
  if (marker != null)
    throw migrationError("AI_PROFILE_INVALID", "Unsupported AI profile storage version");

  const result = stored?.aiProfilesV1 == null
    ? migrateAiProfiles({
        stored: undefined,
        credentials: stored?.aiProfileCredentialsV1,
        prompts: migratePromptRecordsToReplace(stored?.aiProfilePromptsV1),
        legacy,
      })
    : migrateMarkerlessCanonical(
        stored.aiProfilesV1,
        stored.aiProfileCredentialsV1,
        stored.aiProfilePromptsV1,
        legacy,
      );
  return {
    ...result,
    changed: true,
    patch: {
      [AI_PROFILE_STORAGE_VERSION_KEY]: AI_PROFILE_STORAGE_VERSION,
      aiProfilesV1: result.state,
      aiProfileCredentialsV1: result.credentials,
      aiProfilePromptsV1: result.prompts,
    },
  };
}

/** Read/migrate/write as one idempotent activation gate within this context. */
export async function ensureAiProfileStorageV2(
  legacy = {},
  {
    read = getStorage,
    write = setStorage,
    migrateKnown = migrateKnownBuiltInPromptRecords,
  } = {},
) {
  if (migrationInFlight) return migrationInFlight;
  migrationInFlight = (async () => {
    const stored = await read(AI_PROFILE_STORAGE_KEYS);
    // Validate the complete profile/schema boundary before considering the
    // narrow historical-default migration. Invalid state must fail without a
    // write, even when one prompt happens to match a known historical hash.
    let prepared = prepareAiProfileStorageV2(stored, legacy);
    const knownDefault = await migrateKnown(
      prepared.prompts,
    );
    if (knownDefault.changed) {
      const latest = await read(AI_PROFILE_STORAGE_KEYS);
      const latestPrepared = prepareAiProfileStorageV2(latest, legacy);
      const latestDefault = await migrateKnown(
        latestPrepared.prompts,
      );
      if (latestDefault.changed) {
        const patch = {
          ...(latestPrepared.patch || {}),
          aiProfilePromptsV1: latestDefault.prompts,
        };
        await write(patch);
        return prepareAiProfileStorageV2({ ...latest, ...patch }, {});
      } else {
        return latestPrepared;
      }
    }
    if (prepared.patch) {
      // Popup and service worker are separate JS contexts, so a module-local
      // promise alone cannot arbitrate them. Re-read immediately before the
      // atomic patch: if another context already committed v2, validate and
      // use that winner instead of overwriting it with our stale snapshot.
      const latest = await read(AI_PROFILE_STORAGE_KEYS);
      if (latest?.[AI_PROFILE_STORAGE_VERSION_KEY] === AI_PROFILE_STORAGE_VERSION)
        return prepareAiProfileStorageV2(latest, {});
      await write(prepared.patch);
    }
    return prepared;
  })();
  try {
    return await migrationInFlight;
  } finally {
    migrationInFlight = null;
  }
}
