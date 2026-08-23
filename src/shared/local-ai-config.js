import { isLocalHostUrl } from "./constants.js";

export const LOCAL_AI_PROTOCOLS = new Set(["openai", "ollama"]);

export const LOCAL_AI_PRESETS = Object.freeze({
  ollama: { version: 1, protocol: "openai", baseUrl: "http://localhost:11434/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  lmstudio: { version: 1, protocol: "openai", baseUrl: "http://localhost:1234/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  localai: { version: 1, protocol: "openai", baseUrl: "http://localhost:8080/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  jan: { version: 1, protocol: "openai", baseUrl: "http://localhost:1337/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  textgen: { version: 1, protocol: "openai", baseUrl: "http://localhost:5000/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  koboldcpp: { version: 1, protocol: "openai", baseUrl: "http://localhost:5001/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  vllm: { version: 1, protocol: "openai", baseUrl: "http://localhost:8000/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  llamafile: { version: 1, protocol: "openai", baseUrl: "http://localhost:8080/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  gpt4all: { version: 1, protocol: "openai", baseUrl: "http://localhost:4891/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
  llamacpp: { version: 1, protocol: "openai", baseUrl: "http://localhost:8080/v1", modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" },
});

const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,160}$/;
const SAFE_RESPONSE_PATH = /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+|\*)){0,7}$/;

export function localAiPreset(provider) {
  const preset = LOCAL_AI_PRESETS[String(provider || "").trim().toLowerCase()];
  return preset ? { ...preset } : null;
}

export function normalizeLocalAiAdapter(value, { provider = "" } = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const preset = localAiPreset(provider) || {};
  const protocol = String(raw.protocol || preset.protocol || "openai").trim().toLowerCase();
  if (!LOCAL_AI_PROTOCOLS.has(protocol)) throw new Error("protocol must be openai or ollama");
  const baseUrl = String(raw.baseUrl || preset.baseUrl || "").trim().replace(/\/+$/, "");
  if (!isLocalHostUrl(baseUrl)) throw new Error("baseUrl must use localhost or a private LAN address");
  const parsedBase = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("baseUrl must be a credential-free local HTTP(S) URL");
  }
  const defaults = protocol === "ollama"
    ? { modelsPath: "/api/tags", chatPath: "/api/chat", modelsResponsePath: "models.*.name", chatResponsePath: "message.content" }
    : { modelsPath: "/models", chatPath: "/chat/completions", modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content" };
  const out = { version: 1, protocol, baseUrl };
  for (const key of ["modelsPath", "chatPath"]) {
    const path = String(raw[key] || preset[key] || defaults[key]);
    if (!SAFE_PATH.test(path) || path.includes("..") || /%2e/i.test(path)) throw new Error(`${key} must be a safe relative HTTP path`);
    out[key] = path;
  }
  for (const key of ["modelsResponsePath", "chatResponsePath"]) {
    const path = String(raw[key] || preset[key] || defaults[key]);
    if (!SAFE_RESPONSE_PATH.test(path)) throw new Error(`${key} is not a safe JSON response path`);
    out[key] = path;
  }
  return out;
}

export function parseLocalAiAdapterJson(text) {
  let value;
  try { value = JSON.parse(String(text || "")); }
  catch { throw new Error("Custom adapter must be valid JSON"); }
  const allowed = new Set(["version", "protocol", "baseUrl", "modelsPath", "chatPath", "modelsResponsePath", "chatResponsePath"]);
  const extra = Object.keys(value && typeof value === "object" ? value : {}).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`Unsupported field: ${extra[0]}`);
  if (Number(value?.version) !== 1) throw new Error("version must be 1");
  return normalizeLocalAiAdapter(value);
}

export function serializeLocalAiAdapter(adapter) {
  return JSON.stringify(normalizeLocalAiAdapter(adapter), null, 2);
}
