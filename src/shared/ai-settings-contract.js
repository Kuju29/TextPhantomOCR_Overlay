// Pure readiness checks shared by browser entry points. This module never
// receives/logs a raw key beyond testing whether a non-empty value exists.
import { isLocalAiProvider, isLocalHostUrl } from "./constants.js";

/**
 * Return a definitive Auto-text.ai configuration problem, or null.
 * `hasServerKey=null` means the server could not be checked, so absence of a
 * browser key is not grounds for blocking: the server may own the credential.
 * Provider/model "auto" are valid legacy/server-resolved contracts.
 */
export function autoAiSettingsIssue(settings, { hasServerKey = null } = {}) {
  const provider = String(settings?.aiProvider || "").trim().toLowerCase();
  const baseUrl = String(settings?.aiBaseUrl || "").trim();
  const userKey = String(settings?.aiKey || "").trim();
  const local = isLocalAiProvider(provider) || isLocalHostUrl(baseUrl);

  if (isLocalAiProvider(provider) && (!baseUrl || baseUrl.toLowerCase() === "auto")) {
    return {
      code: "ai_endpoint_missing",
      message: "Text.ai needs a local AI endpoint. Open the main popup and set the Endpoint before translating.",
    };
  }
  if (!local && !userKey && hasServerKey === false) {
    return {
      code: "missing_api_key",
      message: "Text.ai has no API key. Open the main popup and set Provider, API key and Model before translating.",
    };
  }
  return null;
}
