import { normImgSrc } from "../job-keys.js";

// Credentials are isolated by the server's owner scope. Transient diagnostics
// and refreshed capability estimates must not turn a safe retry into new work.
const OMIT = new Set(["idempotency_key", "apikey", "api_key", "authorization",
  "tp_trace", "request_id", "requestid", "operationid", "operation_id",
  "batch_id", "batchid", "job_id", "jobid", "image_id", "imageid",
  "tp_tab_session", "session", "timestamp"]);
function semantic(value, path = []) {
  if (Array.isArray(value)) return value.map(v => semantic(v, path));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !OMIT.has(key.toLowerCase()) && !(path.length === 1 && path[0] === "ai" &&
      ["model_capabilities", "workload", "rate", "on_device", "conversation_reset"].includes(key.toLowerCase())) &&
      !(path.length === 1 && path[0] === "metadata" && ["pipeline", "ocr_image", "extra"].includes(key.toLowerCase())))
    .map(([key, v]) => [key, semantic(v, [...path, key])]));
}

function stableString(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text || "")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function idempotencyKeyForPayload(payload) {
  const dataUri =
    typeof payload?.imageDataUri === "string" ? payload.imageDataUri : "";
  const dataFingerprint = dataUri
    ? await sha256Hex(dataUri)
    : "";
  const ai =
    payload?.ai && typeof payload.ai === "object"
      ? semantic(payload.ai, ["ai"])
      : null;
  return sha256Hex(
    stableString({
      mode: String(payload?.mode || ""),
      lang: String(payload?.lang || ""),
      source: String(payload?.source || ""),
      src: normImgSrc(payload?.src || ""),
      dataFingerprint,
      ai,
      type: payload?.type || "",
      engine: payload?.engine || "",
      layout: semantic(payload?.layout || null),
      render: semantic(payload?.render || null),
      context: semantic(payload?.context || null),
      metadata: semantic(payload?.metadata || null, ["metadata"]),
      naturalSize: payload?.naturalSize || null,
    }),
  );
}
