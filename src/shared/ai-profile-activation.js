/** Canonical runtime activation boundary for immutable Provider + Model profiles. */
import {
  AI_PROFILES_SCHEMA_VERSION,
  getAiProfilePrompt,
  makeProfilePromptKey,
  resolveAiProfile,
} from "./ai-profiles.js";
import { AI_PROMPT_MODE, requireAiPrompt } from "./ai-prompt-policy.js";

const clone = (value) => structuredClone(value);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value))
    return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function frozenCopy(value) {
  return deepFreeze(clone(value));
}

function requirePromptMode(value) {
  if (value === AI_PROMPT_MODE) return value;
  const error = new TypeError("Canonical AI prompt mode is missing or invalid");
  error.code = "AI_PROFILE_INVALID";
  throw error;
}

/** Creates a synchronous selector over a fixed storage snapshot. */
export function createAiProfileActivationController({
  state,
  credentials = {},
  prompts = {},
  defaults = {},
} = {}) {
  const storage = frozenCopy({ state, credentials, prompts, defaults });
  return Object.freeze({
    select(target, { language = "en" } = {}) {
      const resolved = resolveAiProfile(storage.state, {
        ...target,
        defaults: storage.defaults,
      });
      const provider = storage.state?.providers?.[resolved.providerIdentity];
      const promptKey = makeProfilePromptKey(
        resolved.providerIdentity,
        resolved.model,
        language,
      );
      const prompt = getAiProfilePrompt(storage.prompts, promptKey);
      return frozenCopy({
        version: AI_PROFILES_SCHEMA_VERSION,
        target: {
          runtime: String(target?.runtime || ""),
          provider: String(target?.provider || provider?.provider || ""),
          endpoint: String(
            target?.endpoint ||
              (provider?.endpoint === "default" ? "" : provider?.endpoint) ||
              "",
          ),
          model: resolved.model,
        },
        providerIdentity: resolved.providerIdentity,
        profile: resolved.profile,
        credential:
          typeof storage.credentials?.[resolved.providerIdentity] === "string"
            ? storage.credentials[resolved.providerIdentity]
            : "",
        prompt: prompt.text,
        promptMode: prompt.mode,
      });
    },
  });
}

/** Converts a selected immutable snapshot into provider-neutral effective values. */
export function resolveEffectiveAiProfile(snapshot) {
  const promptMode = requirePromptMode(snapshot?.promptMode);
  const profile =
    snapshot?.profile && typeof snapshot.profile === "object"
      ? snapshot.profile
      : {};
  const unsupported = [];
  if (
    profile.tokenPolicy?.mode === "manual" ||
    Number(profile.tokenPolicy?.maxOutputTokens) > 0
  )
    unsupported.push("tokenPolicy");
  if (profile.temperature != null) unsupported.push("temperature");
  if (Object.keys(profile.providerOptions || {}).length)
    unsupported.push("providerOptions");
  return frozenCopy({
    version: Number(snapshot?.version) || AI_PROFILES_SCHEMA_VERSION,
    target: snapshot?.target || {},
    providerIdentity: String(snapshot?.providerIdentity || ""),
    credential: String(snapshot?.credential || ""),
    prompt: requireAiPrompt(snapshot?.prompt),
    promptMode,
    thinking: profile.thinking === "on" ? "on" : "off",
    pageImage: profile.pageImage || "off",
    memoryMode: profile.memoryMode || "off",
    concurrency: profile.concurrency || { mode: "auto", max: 0 },
    providerOptions: profile.providerOptions || {},
    unsupported,
    profile,
  });
}

/**
 * Builds the established AI wire shape. Engine is accepted for parity checks
 * but never changes the effective AI values.
 */
export function buildEffectiveAiPayload(
  effective,
  { engine: _engine = "runsextension" } = {},
) {
  const promptMode = requirePromptMode(effective?.promptMode);
  const target = effective?.target || {};
  const local = target.runtime === "local";
  return frozenCopy({
    ai: {
      api_key: local ? "" : String(effective?.credential || ""),
      model: String(target.model || "auto"),
      provider: String(target.provider || ""),
      base_url: String(target.endpoint || "auto") || "auto",
      prompt: requireAiPrompt(effective?.prompt),
      prompt_mode: promptMode,
      memory_mode: String(effective?.memoryMode || "off"),
      send_image: effective?.pageImage === "always" ? "always" : false,
      thinking: effective?.thinking === "on" ? "on" : "off",
    },
  });
}
