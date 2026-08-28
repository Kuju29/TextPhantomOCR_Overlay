import assert from "node:assert/strict";

const storage = Object.create(null);
globalThis.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        for (const key of keys || []) out[key] = storage[key];
        cb(out);
      },
      set(patch, cb) { Object.assign(storage, patch); cb?.(); },
    },
  },
  runtime: { lastError: null },
  contextMenus: { removeAll() {}, create() {} },
  tabs: {
    sendMessage(_tabId, message, _options, callback) {
      // The readiness ping succeeds. A configuration failure must occur before
      // the production handler asks the tab for an image payload.
      callback?.(message?.type === "TP_PING" ? { ok: true } : null);
    },
  },
  extension: { isAllowedFileSchemeAccess(callback) { callback(true); } },
};

const { readFullSettings } = await import("../src/shared/settings.js");
const { autoAiSettingsIssue } = await import("../src/shared/ai-settings-contract.js");
const contextMenuSource = await (await import("node:fs/promises")).readFile(
  new URL("../src/background/context-menu.js", import.meta.url), "utf8",
);

storage.lang = "en";
storage.aiModel = "gemini-test";
storage.aiPromptByLang = { en: "English style", th: "Thai style" };
let settings = await readFullSettings({ lang: "th" });
assert.equal(settings.lang, "th");
assert.equal(settings.aiPrompt, "Thai style", "Auto override language must select its own prompt");

storage.aiProvider = "ollama";
storage.aiBaseUrl = "http://192.168.1.22:11434/v1";
storage.localAiAdapter = {
  version: 1, protocol: "openai", baseUrl: "http://192.168.1.11:11434/v1",
  modelsPath: "/models", chatPath: "/chat/completions",
  modelsResponsePath: "data.*.id", chatResponsePath: "choices.0.message.content",
};
settings = await readFullSettings({ lang: "th" });
assert.equal(settings.localAiAdapter.baseUrl, "http://192.168.1.22:11434",
  "native Ollama must use the newly visible endpoint root, never a stale stored /v1 adapter");
assert.equal(settings.localAiAdapter.protocol, "ollama",
  "legacy Ollama OpenAI-compatible settings must migrate to the native protocol");
storage.aiProvider = "";
storage.aiBaseUrl = "";
delete storage.localAiAdapter;

assert.equal(autoAiSettingsIssue({ aiProvider: "gemini", aiKey: "" }, { hasServerKey: true }), null,
  "a server-owned cloud key must remain valid");
assert.equal(autoAiSettingsIssue({ aiProvider: "auto", aiModel: "auto", aiKey: "" }, { hasServerKey: null }), null,
  "unknown server key state and auto resolution must not be falsely blocked");
assert.equal(autoAiSettingsIssue(
  { aiOnDevice: true, aiProvider: "auto", aiModel: "auto", aiKey: "", aiBaseUrl: "" },
  { hasServerKey: false },
 )?.code, "missing_api_key",
  "the current server-owned text.ai path must not pretend on-device is a keyless route");
assert.equal(autoAiSettingsIssue(
  { aiOnDevice: true, aiProvider: "ollama", aiModel: "auto", aiKey: "", aiBaseUrl: "" },
  { hasServerKey: false },
 )?.code, "ai_endpoint_missing",
  "an explicit local provider still requires its HTTP endpoint");
assert.equal(autoAiSettingsIssue({ aiProvider: "gemini", aiKey: "" }, { hasServerKey: false })?.code,
  "missing_api_key");
assert.equal(autoAiSettingsIssue({ aiProvider: "ollama", aiBaseUrl: "", aiKey: "" })?.code,
  "ai_endpoint_missing");
assert.equal(autoAiSettingsIssue({ aiProvider: "auto", aiBaseUrl: "http://127.0.0.1:11434", aiKey: "" }), null,
  "a keyless local URL with auto provider is supported");
assert.equal(autoAiSettingsIssue({
  aiProvider: "customlocal", aiBaseUrl: "http://127.0.0.1:9000/v1",
  aiKey: "", engineMode: "api",
})?.code, "custom_local_extension_only",
"the API engine must fail early with a clear instruction for custom adapters");
assert.equal(autoAiSettingsIssue({
  aiProvider: "customlocal", aiBaseUrl: "http://127.0.0.1:9000/v1",
  aiKey: "", engineMode: "extension",
}), null, "custom adapters remain available on the direct Extension engine");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "extension",
}, { mainApiBaseUrl: "https://example.hf.space" }), null,
"Extension mode reaches Local AI directly even when the main API is remote");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "api",
}, { mainApiBaseUrl: "https://example.hf.space" })?.code, "local_ai_unreachable_from_remote_api",
"a remote API must not mistake its localhost for the user's PC");
assert.equal(autoAiSettingsIssue({
  aiProvider: "ollama", aiBaseUrl: "http://127.0.0.1:11434", engineMode: "api",
}, { mainApiBaseUrl: "http://192.168.1.20:8000" }), null,
"a self-hosted local API may reach Local AI on its network");

// Keep this test dependency-light: context-menu imports the whole service-worker
// graph, which expects browser APIs at module evaluation time. The source checks
// protect the authoritative placement and its conservative server-key policy.
assert.match(contextMenuSource, /has_env_ai_key/);
assert.match(contextMenuSource, /if \(mode === "lens_text" && source === "ai"\)/,
  "preflight must cover both manual and Auto text.ai paths");
assert.match(contextMenuSource, /readFullSettings\(\{ lang: effectiveLang \}\)/);
assert.match(contextMenuSource, /if \(options\?\.propagateErrors === true\) throw e;/,
  "programmatic callers must receive failures caught by the menu boundary");
const backgroundSource = await (await import("node:fs/promises")).readFile(
  new URL("../src/background/index.js", import.meta.url), "utf8",
);
assert.match(backgroundSource, /propagateErrors:\s*true/);
assert.match(backgroundSource, /catch\(\(e\) => sendResponse\(\{[\s\S]*?ok:\s*false,[\s\S]*?tpError:\s*publicTpError\(e\)/,
  "TP_RUN must turn a propagated start failure into a structured negative response");
assert.doesNotMatch(contextMenuSource, /apiKey.*message|message.*aiKey/,
  "configuration messages must not expose a credential");

// Exercise the real outer catch boundary, not just its source text. A local
// provider without an endpoint makes assertAutoAiReady throw before enqueue.
// Programmatic Auto must reject; legacy browser menu invocation must retain
// its historical log-and-resolve behavior.
storage.aiProvider = "ollama";
storage.aiBaseUrl = "";
storage.aiKey = "do-not-print-this-key";
const { onContextMenuClicked } = await import("../src/background/context-menu.js");
const savedConsoleError = console.error;
console.error = () => {};
try {
  await assert.rejects(
    onContextMenuClicked(
      { menuItemId: "img_one" },
      { id: 7, url: "chrome-extension://test/auto.html", title: "Auto" },
      {
        overrides: { mode: "lens_text", lang: "th", source: "ai" },
        propagateErrors: true,
      },
    ),
    (error) => error?.tpError?.code === "ai_endpoint_missing" &&
      !String(error?.message || "").includes(storage.aiKey),
    "TP_RUN's programmatic path must reject with a safe structured preflight error",
  );
  await assert.doesNotReject(
    onContextMenuClicked(
      { menuItemId: "img_one" },
      { id: 7, url: "https://example.invalid/page", title: "Page" },
      { overrides: { mode: "lens_text", lang: "th", source: "ai" } },
    ),
    "legacy context-menu behavior must continue to consume and log the same failure",
  );
} finally {
  console.error = savedConsoleError;
}

console.log("Auto AI settings contract test passed: effective-language prompt and conservative preflight are wired.");
