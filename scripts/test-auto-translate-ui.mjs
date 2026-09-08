import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, js, css] = await Promise.all([
  readFile(new URL("../src/auto/auto.html", import.meta.url), "utf8"),
  readFile(new URL("../src/auto/auto.js", import.meta.url), "utf8"),
  readFile(new URL("../src/auto/auto.css", import.meta.url), "utf8"),
]);
const [popupHtml, popupJs, promptJs] = await Promise.all([
  readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8"),
  readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8"),
  readFile(new URL("../src/prompt/prompt.js", import.meta.url), "utf8"),
]);
const popupEvents = await readFile(new URL("../src/popup/controllers/popup-event-controller.js", import.meta.url), "utf8");
const popupUi = await readFile(new URL("../src/popup/controllers/popup-ui-controller.js", import.meta.url), "utf8");
const promptHtml = await readFile(new URL("../src/prompt/prompt.html", import.meta.url), "utf8");

// Prompt Studio DOM integration: every required production binding must have
// a concrete element and the save/language/input events must target it.
for (const id of ["ps-lang", "ps-load-default", "ps-clear", "ps-back", "ps-forward",
  "ps-save", "ps-text", "ps-count", "ps-key", "ps-status"]) {
  assert.match(promptHtml, new RegExp(`id=["']${id}["']`), `Prompt Studio DOM must contain #${id}`);
  assert.match(promptJs, new RegExp(`getElementById\\(["']${id}["']\\)`),
    `Prompt Studio script must bind #${id}`);
}
assert.match(promptJs, /els\.lang\.addEventListener\("change"/);
assert.match(promptJs, /els\.text\.addEventListener\("input"/);
assert.match(promptJs, /els\.save\.addEventListener\("click", save\)/);

const controls = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
const modeLabel = controls.find(([, , body]) => /id="auto-mode"/.test(body));
const langLabel = controls.find(([, , body]) => /id="auto-lang"/.test(body));
assert.ok(modeLabel, "Mode label must remain present");
assert.doesNotMatch(modeLabel[1], /id="auto-lang-wrap"/,
  "the Language wrapper id must not be placed on Mode");
assert.ok(langLabel, "Language label must remain present");
assert.match(langLabel[1], /id="auto-lang-wrap"/,
  "the wrapper that directly contains #auto-lang must own the visibility id");
assert.match(js, /langWrap:\s*document\.getElementById\("auto-lang-wrap"\)/);
assert.match(js, /isText\s*&&\s*state\.source\s*===\s*"original"\s*\?\s*"none"\s*:\s*""/);
assert.match(js, /els\.source\.addEventListener\("change"[\s\S]*applyModeVisibility\(\)/);
assert.doesNotMatch(js, /state\.lang\s*=\s*""/);

assert.match(css, /\.tp-gtext\s*\{[\s\S]*pointer-events:\s*none\s*!important;[\s\S]*user-select:\s*none\s*!important;/);
assert.match(css, /html\.translated-ltr[\s\S]*\.tp-src \.tp-line[\s\S]*pointer-events:\s*none\s*!important;/);
assert.match(css, /html\.translated-rtl[\s\S]*\.tp-gtext[\s\S]*pointer-events:\s*auto\s*!important;[\s\S]*user-select:\s*text\s*!important;/);

assert.match(js, /function autoTranslateSources[\s\S]*!==\s*"ai"/,
  "Auto Translate must filter AI from built-in and server source lists");
assert.match(js, /stored\.autoSource\s*===\s*"ai"[\s\S]*autoSource:\s*"translated"/,
  "legacy Auto AI selections must migrate to Translated");
assert.match(js, /if \(state\.source === "ai"\)[\s\S]*auto_ai_source_removed/,
  "request-time guard must cancel legacy AI work and force Translated");
assert.match(html, /AI translation is disabled here\./);
assert.match(js, /aiSettingsChanged[\s\S]*resultCache\.clear\(\)/);
assert.match(js, /AI settings changed in the main UI[^`"]*next run will use the new settings/);
assert.match(js, /resetForNavigation\?\.\("auto_ai_settings_changed"\)/,
  "an in-flight AI result must be rejected by the existing page-generation contract");
assert.match(js, /runId !== state\.runId \|\| !settingsEpochGuard\.accepts\(settingsEpoch\)/,
  "the async start response must also respect the settings generation");

// Exercise the production epoch helper rather than merely checking its text.
// Sequence: start A -> settings change -> completion A -> start B. A is not
// allowed to populate the cache, therefore B is a real cache miss/network run.
const guardSource = js.match(/function createSettingsEpochGuard\(\)\s*\{[\s\S]*?\n\}/)?.[0] || "";
assert.ok(guardSource, "settings epoch guard must remain independently testable");
const makeGuard = Function(`${guardSource}; return createSettingsEpochGuard;`)();
const guard = makeGuard();
const cache = new Map();
const runA = guard.capture();
await Promise.resolve();
guard.invalidate();
if (guard.accepts(runA)) cache.set("answer", "A");
assert.equal(cache.has("answer"), false, "stale completion A must not be remembered");
const runB = guard.capture();
assert.equal(guard.accepts(runB), true);
assert.equal(cache.has("answer"), false, "run B must miss cache and reach the network");

const cacheKeyBody = js.match(/function cacheKey\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
assert.ok(cacheKeyBody);
assert.doesNotMatch(cacheKeyBody, /aiKey|AI_RESULT_SETTING_KEYS/);

globalThis.chrome = {
  runtime: { lastError: null },
  storage: { local: {
    get(_keys, callback) { callback({ ok: true }); },
    set(_patch, callback) { callback(); },
  } },
};
const storage = await import(`../src/shared/storage.js?test=${Date.now()}`);
assert.deepEqual(await storage.getStorage(["ok"]), { ok: true });
await assert.doesNotReject(storage.setStorage({ ok: true }));
chrome.storage.local.get = (_keys, callback) => {
  callback({ callbackWins: true });
  return Promise.reject(new Error("late promise rejection"));
};
assert.deepEqual(await storage.getStorage(["hybrid"]), { callbackWins: true },
  "hybrid APIs must settle once from the first completion");
chrome.storage.local.set = (_patch, callback) => {
  chrome.runtime.lastError = { message: "quota exceeded" };
  callback();
  chrome.runtime.lastError = null;
};
await assert.rejects(storage.setStorage({ tooLarge: true }), /quota exceeded/);
chrome.storage.local.get = (_keys, callback) => {
  chrome.runtime.lastError = { message: "read denied" };
  callback(undefined);
  chrome.runtime.lastError = null;
};
await assert.rejects(storage.getStorage(["secret"]), /read denied/);

delete globalThis.chrome;
globalThis.browser = { storage: { local: {
  get: async () => ({ promise: true }),
  set: async () => undefined,
} } };
assert.deepEqual(await storage.getStorage(["promise"]), { promise: true });
await assert.doesNotReject(storage.setStorage({ promise: true }));
browser.storage.local.get = () => Promise.reject(new Error("promise read failed"));
await assert.rejects(storage.getStorage(["x"]), /promise read failed/);
browser.storage.local.set = () => { throw new Error("sync write failed"); };
await assert.rejects(storage.setStorage({ x: true }), /sync write failed/);
delete globalThis.browser;
assert.deepEqual(await storage.getStorage(["outside"]), {});
await assert.doesNotReject(storage.setStorage({ outside: true }));

const links = await import(`../src/popup/provider-key-links.js?test=${Date.now()}`);
const officialKeyUrls = {
  gemini: "https://aistudio.google.com/app/apikey",
  openai: "https://platform.openai.com/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  anthropic: "https://platform.claude.com/settings/keys",
  groq: "https://console.groq.com/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  together: "https://api.together.ai/settings/api-keys",
  huggingface: "https://huggingface.co/settings/tokens",
  featherless: "https://featherless.ai/account/api-keys",
};
for (const [provider, url] of Object.entries(officialKeyUrls)) {
  assert.equal(links.providerKeyUrl(provider), url, `${provider} Get key URL`);
}
assert.equal(links.providerKeyUrl("ollama"), "");
assert.match(popupHtml, /class="label-row label-row--inline"[\s\S]*<label for="ai-key">API key<\/label>\s*<a id="ai-key-get"[^>]*target="_blank"[^>]*rel="noopener noreferrer">\(get key\)<\/a>/);
assert.match(popupHtml, /id="ai-key"[\s\S]*aria-describedby="ai-key-hint"/);
assert.match(popupUi, /applyProviderKeyLink\(els\.aiKeyGet, local \? "" : provider\)/,
  "popup UI controller must uniquely own provider key-link updates");
assert.match(popupJs, /createPopupUiController\(\{[\s\S]*isLocalProvider:\s*isLocalAiProvider[\s\S]*toggleDom:\s*toggleUiDom/,
  "popup composition root must inject the provider and DOM dependencies");
assert.match(popupJs, /const toggleUi = popupUiController\.toggle/,
  "popup composition root must wire the controller toggle into existing callers");
const mockKeyLink = { href: "", hidden: false };
for (const [provider, url] of Object.entries(officialKeyUrls)) {
  assert.equal(links.applyProviderKeyLink(mockKeyLink, provider), url, `${provider} switching URL`);
  assert.equal(mockKeyLink.href, url, `${provider} link href`);
  assert.equal(mockKeyLink.hidden, false, `${provider} link remains visible`);
}
for (const provider of ["ollama", "lmstudio", "localai", "jan", "text-generation-webui", "koboldcpp", "vllm", "llamafile", ""]) {
  assert.equal(links.applyProviderKeyLink(mockKeyLink, provider), "", `${provider || "empty"} has no key URL`);
  assert.equal(mockKeyLink.href, "#", `${provider || "empty"} safe fallback href`);
  assert.equal(mockKeyLink.hidden, true, `${provider || "empty"} key link hidden`);
}
assert.match(popupEvents, /const pendingEdits = flushPendingAiEditsForSwitch[\s\S]*await pendingEdits[\s\S]*beginProviderTransition/);
assert.match(popupEvents, /aiModel\.addEventListener\("change"[\s\S]*await flushPendingAiEditsForSwitch[\s\S]*selectModel/);
assert.match(promptJs, /aiProfilePromptsV1/);
assert.match(promptHtml, /Saved separately for this Provider, Model and Language\./);
assert.match(promptJs, /makeProfilePromptKey\(\s*state\.providerIdentity,\s*state\.model/);
assert.match(promptJs, /if \(state\.dirty\) await saveLanguage\(previous[\s\S]*loadCurrent\(next\)/,
  "language A must auto-save before language B is loaded");
const persistBody = promptJs.match(/function persistPromptMaps\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
assert.doesNotMatch(persistBody, /aiPromptByLang/, "Prompt Studio must never dual-write the legacy language-only map");
const { makeProfilePromptKey } = await import(`../src/shared/prompt.js?profile=${Date.now()}`);
const identity = "openrouter::default";
const model = "model-A";
const promptMap = {};
promptMap[makeProfilePromptKey(identity, model, "A")] = "prompt A";
promptMap[makeProfilePromptKey(identity, model, "B")] = "prompt B";
assert.equal(promptMap[makeProfilePromptKey(identity, model, "A")], "prompt A");
assert.equal(promptMap[makeProfilePromptKey(identity, model, "B")], "prompt B");
assert.equal(promptMap[makeProfilePromptKey(identity, model, "C")], undefined,
  "fresh language C must not inherit prompt A or B");
assert.match(popupEvents, /prompt\/prompt\.html\?lang=.*&model=.*&identity=/);
assert.match(popupEvents, /changes\.aiProfilePromptsV1/);

console.log("auto translate UI tests passed");
