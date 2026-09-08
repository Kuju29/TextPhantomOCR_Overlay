/** Resolves one immutable Provider + Model settings snapshot per job batch. */
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
    thinking: "off",
    tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
    temperature: null,
    pageImage: "off",
    memoryMode: "off",
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
export async function resolveJobAiProfile(settings, { language = "en" } = {}) {
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
    aiKey: local ? "" : activated.credential,
    // Empty is an intentional canonical value; never resurrect a legacy prompt.
    aiPrompt: activated.prompt,
    aiPromptMode: activated.promptMode,
    aiPageImage: profile.pageImage || "off",
    aiMemoryMode: profile.memoryMode || "off",
    aiThinking: profile.thinking === "on" ? "on" : "off",
    aiLocalThinking: profile.thinking || "off",
    aiLocalCapacityMode:
      profile.concurrency?.mode || "auto",
    aiLocalManualConcurrency:
      Number(profile.concurrency?.max) || 0,
    aiModelCapabilities:
      !local && profile.providerOptions?.capabilityAccountHash === await shortHash(activated.credential)
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
