/** User intent only. No provider credentials or customer sessions in this store. */
import { normalizeUrl } from "./url.js";
import { normalizeUserReasoningPreference } from "./reasoning-preference.js";
import { makeProfilePromptKey } from "./ai-profiles.js";
import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../generated/canonical-prompt-plans.js";
import { cleanTokenCeiling } from "./token-ceiling.js";

export const PAID_PROFILE_KEY = "paidAiProfilesV1";
export const paidScope = (apiBase, model) => JSON.stringify([normalizeUrl(apiBase), String(model || "auto")]);
export const paidPromptKey = (apiBase, model, language) => makeProfilePromptKey(
  `paid:${normalizeUrl(apiBase)}`, String(model || "auto"), language || "en");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
export function cleanPaidProfile(value = {}) {
  return {
    thinking: normalizeUserReasoningPreference(value.thinking, "minimum"),
    pageImage: value.pageImage === "always" ? "always" : "off",
    memoryMode: ["off", "terms", "full"].includes(value.memoryMode) ? value.memoryMode : "off",
    // Old entries contain a forced value, not a user opt-in. Preserve their
    // other settings while defaulting this new scoped choice to OFF once.
    translationMode: "conversation",
    styleExamples: value.styleExamplesPreferenceVersion === 1 && value.styleExamples === true,
    styleExamplesPreferenceVersion: 1,
    conversationReset: String(value.conversationReset || "0").slice(0, 80),
    // Per-model token ceiling (OFF = the Center's model ceiling).
    ...cleanTokenCeiling(value),
  };
}
export function paidEntry(settings, apiBase, model, language = "en") {
  const store = settings[PAID_PROFILE_KEY];
  const entry = plain(store) && plain(store.entries) ? store.entries[paidScope(apiBase, model)] : null;
  // An unseen model has its own defaults. Existing entries, including empty
  // custom styles, remain intact; old seeds have no reliable provenance.
  const profile = cleanPaidProfile(plain(entry?.profile) ? entry.profile : {});
  const prompts = plain(entry?.prompts) ? {...entry.prompts} : {};
  if (!Object.hasOwn(prompts, language)) {
    prompts[language] = {text: BUNDLED_CANONICAL_PROMPT_PLANS?.[language]?.pieces?.editableStyle || "", mode: "replace"};
  }
  for (const [lang, value] of Object.entries(prompts)) {
    prompts[lang] = {text: typeof value === "string" ? value : typeof value?.text === "string" ? value.text : "", mode: "replace"};
  }
  return {profile, prompts};
}
export function putPaidEntry(store, apiBase, model, entry) {
  return {version: 1, entries: {...(plain(store?.entries) ? store.entries : {}),
    [paidScope(apiBase, model)]: {profile: cleanPaidProfile(entry.profile), prompts: structuredClone(entry.prompts || {})}}};
}
