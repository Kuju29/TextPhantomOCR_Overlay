import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, js, css] = await Promise.all([
  readFile(new URL("../src/auto/auto.html", import.meta.url), "utf8"),
  readFile(new URL("../src/auto/auto.js", import.meta.url), "utf8"),
  readFile(new URL("../src/auto/auto.css", import.meta.url), "utf8"),
]);

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

for (const key of ["aiKey", "aiModel", "aiProvider", "aiPromptByLang", "customApiUrl"]) {
  assert.match(js, new RegExp(`"${key}"`), `${key} must invalidate Auto's result cache`);
}
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

console.log("auto translate UI tests passed");
