import { normImgSrc } from "../job-keys.js";

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
    ? await sha256Hex(
        `${dataUri.length}:${dataUri.slice(0, 4096)}:${dataUri.slice(-4096)}`,
      )
    : "";
  const ai =
    payload?.ai && typeof payload.ai === "object"
      ? {
          model: payload.ai.model || "",
          provider: payload.ai.provider || "",
          prompt: payload.ai.prompt || "",
        }
      : null;
  return sha256Hex(
    stableString({
      mode: String(payload?.mode || ""),
      lang: String(payload?.lang || ""),
      source: String(payload?.source || ""),
      src: normImgSrc(payload?.src || ""),
      dataFingerprint,
      ai,
    }),
  );
}
