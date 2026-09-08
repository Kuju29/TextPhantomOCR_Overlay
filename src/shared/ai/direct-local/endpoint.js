import { isLocalHostUrl } from "../providers/local-spec.js";
import { LocalAiError } from "./error.js";

export function assertPrivateCredentialFreeEndpoint(rawUrl) {
  const raw = String(rawUrl || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LocalAiError("Local AI endpoint is not a valid URL", {
      code: "invalid_local_endpoint",
    });
  }
  if (!isLocalHostUrl(raw) || !/^https?:$/.test(parsed.protocol)) {
    throw new LocalAiError(
      "Local AI endpoints must stay on this PC or private LAN",
      { code: "local_endpoint_not_private" },
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new LocalAiError(
      "Local AI endpoint cannot contain credentials, query text or a fragment",
      { code: "invalid_local_endpoint" },
    );
  }
  return parsed;
}

export function localOpenAiBase(rawUrl) {
  const raw = String(rawUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw || raw.toLowerCase() === "auto") {
    throw new LocalAiError("Local AI endpoint is missing", {
      code: "ai_endpoint_missing",
    });
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalAiError("Local AI endpoint is not a valid URL", {
      code: "invalid_local_endpoint",
    });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new LocalAiError("Local AI endpoint must use HTTP or HTTPS", {
      code: "invalid_local_endpoint",
    });
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = !path || path === "/" ? "/v1" : path;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
