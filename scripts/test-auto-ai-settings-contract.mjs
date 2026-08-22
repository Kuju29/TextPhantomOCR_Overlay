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

// Keep this test dependency-light: context-menu imports the whole service-worker
// graph, which expects browser APIs at module evaluation time. The source checks
// protect the authoritative placement and its conservative server-key policy.
assert.match(contextMenuSource, /has_env_ai_key/);
assert.match(contextMenuSource, /if \(overrides && mode === "lens_text" && source === "ai"\)/,
  "preflight must be limited to the Auto override text.ai path");
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
