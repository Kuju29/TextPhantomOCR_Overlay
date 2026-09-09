import { isLocalHostUrl } from "../../shared/constants.js";
import { readLimitedText } from "../images.js";
import { attachTpError } from "../../shared/error-contract.js";

function detail(body) {
  try {
    const parsed = JSON.parse(String(body || ""));
    return parsed?.detail && typeof parsed.detail === "object"
      ? parsed.detail
      : parsed;
  } catch {
    return {};
  }
}

export function httpFailure(
  label,
  res,
  body,
  stage,
  { includeBody = true } = {},
) {
  const data = detail(body);
  const html =
    String(res.headers.get("content-type") || "")
      .toLowerCase()
      .includes("html") ||
    /^\s*(?:<!doctype|<html|<)/i.test(String(body || ""));
  const gateway = Number(res.status) === 502 && html;
  return attachTpError(new Error(`${label}: HTTP ${res.status}`), {
    code: gateway
      ? "GATEWAY_502"
      : String(
          data?.code ||
            data?.error ||
            (res.status >= 500 ? "API_5XX" : "API_BAD_RESPONSE"),
        ),
    origin: gateway
      ? "hosting_gateway"
      : String(data?.origin || data?.actor || "api"),
    stage: String(data?.stage || data?.failedStage || stage),
    httpStatus: res.status,
    upstreamStatus: Number(data?.upstreamStatus) || 0,
    retryable:
      data?.retryable === true || res.status === 429 || res.status >= 500,
    traceId: String(data?.traceId || ""),
    requestId: String(data?.requestId || ""),
    jobId: String(data?.jobId || ""),
    batchId: String(data?.batchId || ""),
    imageId: String(data?.imageId || ""),
    correlationId: String(data?.correlationId || ""),
    upstream: String(data?.upstream || ""),
    diagnostic: `${label}: HTTP ${res.status}${includeBody && body ? ` - ${body}` : ""}`,
  });
}

export function networkFailure(
  error,
  stage,
  { timeout = false, cancelled = false } = {},
) {
  if (error?.tpError) return error;
  return attachTpError(error, {
    code: cancelled ? "CANCELLED" : timeout ? "NET_TIMEOUT" : "NET_OFFLINE",
    origin: "browser",
    category: "network",
    stage,
    retryable: !cancelled,
    diagnostic: error?.message || String(error),
  });
}

export async function readJson(res, what) {
  const ctype = String(res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("json")) return res.json();
  const body = await readLimitedText(res);
  if (ctype.includes("html") || /^\s*(?:<!doctype|<html|<)/i.test(body)) {
    throw new Error(
      `${what}: the API returned a web page instead of data — the server is probably still starting up. Try again in a moment.`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `${what}: expected JSON, got ${ctype || "no content type"}${body ? ` - ${body.slice(0, 200)}` : ""}`,
    );
  }
}

export function limitHeaders(base, unlimited, extra = {}) {
  return unlimited === true && isLocalHostUrl(base)
    ? { ...extra, "X-TP-Local-Unlimited": "1" }
    : { ...extra };
}

function clientVersion() {
  try {
    return String(chrome?.runtime?.getManifest?.()?.version || "");
  } catch {
    return "";
  }
}

export function correlationHeaders({
  jobId = "",
  imageId = "",
  batchId = "",
  traceId = "",
} = {}) {
  const headers = {
    "X-TP-Request-Id": crypto.randomUUID(),
    "X-TP-Job-Id": String(jobId || ""),
    "X-TP-Image-Id": String(imageId || ""),
    "X-TP-Batch-Id": String(batchId || ""),
    "X-TP-Trace-Id": String(traceId || ""),
    "X-TP-Client-Version": clientVersion(),
  };
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value),
  );
}
