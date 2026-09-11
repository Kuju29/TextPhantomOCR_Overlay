// Pure readiness checks shared by browser entry points. This module never
// receives/logs a raw key beyond testing whether a non-empty value exists.
import { isLocalAiProvider, isLocalHostUrl } from "./constants.js";

export const AI_SETTINGS_UI_PATHS = Object.freeze({
  provider: "[AI option > Provider]",
  model: "[AI option > Model]",
  prompt: "[AI option > Set prompt]",
  key: "[AI option > API key]",
  apiUrl: "[Tools > Custom API URL]",
  localUrl: "[AI option > Local server URL]",
});

const configurationIssue = (code, message, path) => ({
  code,
  message: `${message} ${path}`,
  path,
});

/** Maps profile-storage validation failures to one actionable UI location. */
export function aiConfigurationIssueForError(error) {
  const code = String(error?.code || "");
  if (code === "AI_PROMPT_REQUIRED")
    return configurationIssue(code, "ยังไม่ได้ตั้งค่า AI Style กรุณาตั้งค่าที่", AI_SETTINGS_UI_PATHS.prompt);
  if (code === "AI_PROFILE_INCOMPLETE") {
    const detail = String(error?.message || "").toLowerCase();
    if (/credential|key/.test(detail))
      return configurationIssue(code, "ยังไม่ได้ตั้งค่า API key กรุณาตั้งค่าที่", AI_SETTINGS_UI_PATHS.key);
    if (/model/.test(detail))
      return configurationIssue(code, "ยังไม่ได้เลือกโมเดล AI กรุณาเลือกที่", AI_SETTINGS_UI_PATHS.model);
    return configurationIssue(code, "การตั้งค่า Provider หรือ Model ยังไม่ครบ กรุณาตรวจที่", AI_SETTINGS_UI_PATHS.provider);
  }
  if (["AI_PROFILE_INVALID", "AI_PROFILE_MIGRATION_CONFLICT", "AI_PROFILE_MIGRATION_INCOMPLETE"].includes(code))
    return configurationIssue(code, "การตั้งค่า AI เดิมไม่สมบูรณ์ กรุณาเลือก Provider และ Model ใหม่ที่", AI_SETTINGS_UI_PATHS.provider);
  return null;
}

/**
 * Classify an AI target without allowing an old endpoint to override an
 * explicitly selected Provider. `auto` keeps the legacy endpoint inference;
 * named Cloud and Local providers are authoritative.
 */
export function classifyAiRuntime(settings) {
  const provider = String(settings?.aiProvider || "")
    .trim()
    .toLowerCase();
  const baseUrl = String(settings?.aiBaseUrl || "").trim();
  const endpointIsLocal = isLocalHostUrl(baseUrl);
  if (isLocalAiProvider(provider)) {
    return {
      runtime: "local",
      local: true,
      conflict: false,
      reason: "local_by_provider",
    };
  }
  if (provider && provider !== "auto") {
    return {
      runtime: "cloud",
      local: false,
      conflict: endpointIsLocal,
      reason: endpointIsLocal
        ? "cloud_provider_local_endpoint_conflict"
        : "cloud_by_provider",
    };
  }
  if (endpointIsLocal) {
    return {
      runtime: "local",
      local: true,
      conflict: false,
      reason: "local_by_auto_endpoint",
    };
  }
  return {
    runtime: "cloud",
    local: false,
    conflict: false,
    reason: "cloud_by_auto_or_default",
  };
}

/**
 * Return a definitive Auto-text.ai configuration problem, or null.
 * `hasServerKey=null` means the server could not be checked, so absence of a
 * browser key is not grounds for blocking: the server may own the credential.
 * Provider/model "auto" are valid legacy/server-resolved contracts.
 */
export function autoAiSettingsIssue(
  settings,
  { hasServerKey = null, mainApiBaseUrl = "", requireComplete = false } = {},
) {
  const provider = String(settings?.aiProvider || "")
    .trim()
    .toLowerCase();
  const baseUrl = String(settings?.aiBaseUrl || "").trim();
  const userKey = String(settings?.aiKey || "").trim();
  const classification = classifyAiRuntime(settings);
  const local = classification.local;

  if (requireComplete && (!provider || provider === "auto")) {
    return configurationIssue(
      "ai_provider_missing",
      "ยังไม่ได้เลือกผู้ให้บริการ AI กรุณาเลือกที่",
      AI_SETTINGS_UI_PATHS.provider,
    );
  }
  const model = String(settings?.aiModel || "").trim();
  if (requireComplete && (!model || model.toLowerCase() === "auto")) {
    return configurationIssue(
      "ai_model_missing",
      "ยังไม่ได้เลือกโมเดล AI กรุณาเลือกที่",
      AI_SETTINGS_UI_PATHS.model,
    );
  }
  if (requireComplete && !String(settings?.aiPrompt || "").trim()) {
    return configurationIssue(
      "ai_prompt_missing",
      "ยังไม่ได้ตั้งค่า AI Style กรุณาตั้งค่าที่",
      AI_SETTINGS_UI_PATHS.prompt,
    );
  }
  if (requireComplete && !String(mainApiBaseUrl || "").trim()) {
    return configurationIssue(
      "api_url_missing",
      "ยังไม่ได้ตั้งค่า TextPhantom API กรุณาตั้งค่าที่",
      AI_SETTINGS_UI_PATHS.apiUrl,
    );
  }

  if (classification.conflict) {
    return {
      code: "ai_provider_endpoint_conflict",
      message:
        "The selected Cloud AI provider has a Local AI endpoint. Re-select the Provider or save its Cloud endpoint before translating.",
    };
  }

  if (
    provider === "customlocal" &&
    String(settings?.engineMode || "extension") === "api"
  ) {
    return {
      code: "custom_local_extension_only",
      message:
        "Custom Local Adapter runs from the Extension only. Open the main popup and choose Where the work runs: Extension.",
    };
  }

  if (
    local &&
    provider !== "customlocal" &&
    String(settings?.engineMode || "extension") === "api" &&
    mainApiBaseUrl &&
    !isLocalHostUrl(mainApiBaseUrl)
  ) {
    return {
      code: "local_ai_unreachable_from_remote_api",
      message:
        "Local AI is on this PC, but runs: API would connect from the remote API server. Choose Where the work runs: Extension.",
    };
  }

  if (
    isLocalAiProvider(provider) &&
    (!baseUrl || baseUrl.toLowerCase() === "auto")
  ) {
    return configurationIssue(
      "ai_endpoint_missing",
      "ยังไม่ได้ตั้งค่า URL ของ Local AI กรุณาตั้งค่าที่",
      AI_SETTINGS_UI_PATHS.localUrl,
    );
  }
  if (!local && !userKey && hasServerKey === false) {
    return configurationIssue(
      "missing_api_key",
      "ยังไม่ได้ตั้งค่า API key กรุณาตั้งค่าที่",
      AI_SETTINGS_UI_PATHS.key,
    );
  }
  return null;
}
