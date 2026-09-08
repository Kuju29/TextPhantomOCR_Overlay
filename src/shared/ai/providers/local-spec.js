const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,160}$/;
const SAFE_RESPONSE_PATH = /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+|\*)){0,7}$/;
const THINKING_PARAMETERS = new Set(["think", "reasoning", "reasoning_effort"]);

export function isLocalHostUrl(value) {
  try {
    const host = new URL(String(value || "")).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" ||
      host === "0.0.0.0" || host.startsWith("127.") || /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch { return false; }
}

export function defineLocalProvider(spec) {
  return Object.freeze({ version: 1, translationContract: "v2", auth: "none", capacity: "runtime", ...spec });
}

export function normalizeAdapter(spec, value = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const protocol = String(raw.protocol || spec.protocol).trim().toLowerCase();
  if (!new Set(["openai", "ollama"]).has(protocol)) throw new Error("protocol must be openai or ollama");
  let baseUrl = String(raw.baseUrl || spec.baseUrl).trim().replace(/\/+$/, "");
  const legacyOllama = spec.id === "ollama" && baseUrl.endsWith("/v1") && (!raw.protocol || raw.protocol === "openai");
  if (spec.id === "ollama") baseUrl = baseUrl.replace(/\/v1$/i, "");
  if (!isLocalHostUrl(baseUrl)) throw new Error("baseUrl must use localhost or a private LAN address");
  const parsed = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("baseUrl must be a credential-free local HTTP(S) URL");
  const out = { version: 1, protocol: legacyOllama ? "ollama" : protocol,
    translationContract: String(raw.translationContract || spec.translationContract).trim().toLowerCase(), baseUrl };
  if (!new Set(["v1", "v2"]).has(out.translationContract)) throw new Error("translationContract must be v1 or v2");
  for (const key of ["modelsPath", "chatPath"]) {
    const legacy = legacyOllama && ((key === "modelsPath" && raw[key] === "/models") || (key === "chatPath" && raw[key] === "/chat/completions"));
    const path = String(legacy ? spec[key] : (raw[key] || spec[key]));
    if (!SAFE_PATH.test(path) || path.includes("..") || /%2e/i.test(path)) throw new Error(`${key} must be a safe relative HTTP path`);
    out[key] = path;
  }
  for (const key of ["modelsResponsePath", "chatResponsePath"]) {
    const legacy = legacyOllama && ((key === "modelsResponsePath" && raw[key] === "data.*.id") || (key === "chatResponsePath" && raw[key] === "choices.0.message.content"));
    const path = String(legacy ? spec[key] : (raw[key] || spec[key]));
    if (!SAFE_RESPONSE_PATH.test(path)) throw new Error(`${key} is not a safe JSON response path`);
    out[key] = path;
  }
  const includeUsage = raw.includeUsage ?? spec.includeUsage;
  if (typeof includeUsage === "boolean") out.includeUsage = includeUsage;
  const thinking = raw.thinking ?? spec.thinking;
  if (thinking) {
    if (!THINKING_PARAMETERS.has(String(thinking.parameter || ""))) throw new Error("thinking.parameter must be think, reasoning, or reasoning_effort");
    const valid = (v) => ["string", "boolean", "number"].includes(typeof v) && (typeof v !== "number" || Number.isFinite(v));
    if (!valid(thinking.off) || !valid(thinking.on)) throw new Error("thinking.off and thinking.on must be finite primitive JSON values");
    out.thinking = { parameter: thinking.parameter, off: thinking.off, on: thinking.on };
  }
  return out;
}
