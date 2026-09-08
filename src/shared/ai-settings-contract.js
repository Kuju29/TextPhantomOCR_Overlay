// Pure readiness checks shared by browser entry points. This module never
// receives/logs a raw key beyond testing whether a non-empty value exists.
import { isLocalAiProvider, isLocalHostUrl } from "./constants.js";

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
  { hasServerKey = null, mainApiBaseUrl = "" } = {},
) {
  const provider = String(settings?.aiProvider || "")
    .trim()
    .toLowerCase();
  const baseUrl = String(settings?.aiBaseUrl || "").trim();
  const userKey = String(settings?.aiKey || "").trim();
  const classification = classifyAiRuntime(settings);
  const local = classification.local;

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
    return {
      code: "ai_endpoint_missing",
      message:
        "Text.ai needs a local AI endpoint. Open the main popup and set the Endpoint before translating.",
    };
  }
  if (!local && !userKey && hasServerKey === false) {
    return {
      code: "missing_api_key",
      message:
        "Text.ai has no API key. Open the main popup and set Provider, API key and Model before translating.",
    };
  }
  return null;
}
