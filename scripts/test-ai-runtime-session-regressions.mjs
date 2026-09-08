import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSessionLifecycle } from "../src/background/session-lifecycle.js";

for (const [method, reason, href] of [
  ["onTabLoading", "navigation", "https://example.test/next"],
  ["onKeepaliveDisconnect", "page_unloaded", ""],
  ["onLocationChanged", "spa_navigation", "https://example.test/spa"],
  ["onMangaDexChapterChanged", "chapter_change", "https://mangadex.org/chapter/next"],
]) {
  const calls = [];
  const lifecycle = createSessionLifecycle({
    getTabSessionId: (tabId) => (calls.push(["get", tabId]), "old-session"),
    cancelTabWork: (...args) => calls.push(["cancel", ...args]),
    bumpTabSession: (...args) => calls.push(["bump", ...args]),
  });
  lifecycle[method](7, href);
  assert.deepEqual(calls, [
    ["get", 7],
    ["cancel", 7, reason, "old-session"],
    ["bump", 7, href],
  ], `${method} must cancel the old session before bumping`);
}

const index = await readFile(new URL("../src/background/index.js", import.meta.url), "utf8");
assert.match(index, /import\s*\{\s*bumpTabSession\s*,\s*dropTabSession\s*,\s*ensureTabSession\s*,\s*getTabSessionId\s*,?\s*\}/,
  "the composition root must import every tab-session identifier it uses");
const aiLocal = await readFile(new URL("../src/background/ai/transports/server.js", import.meta.url), "utf8");
const translateBody = aiLocal.slice(aiLocal.indexOf("export async function translateViaServer"));
assert.doesNotMatch(translateBody, /payload\?\.lang/,
  "translateUnits must not reference a payload outside its scope");
assert.match(translateBody, /targetLang:\s*String\(targetLang \|\| ""\)/,
  "post-response trace must use the targetLang parameter");

// Exercise the real Cloud/server success path beyond response parsing. This
// is the point where the former out-of-scope `payload` reference discarded a
// valid, already-billed provider response.
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "test" }) },
  storage: { local: {
    get: (_keys, callback) => callback?.({}),
    set: (_patch, callback) => callback?.(),
  } },
};
const originalFetch = globalThis.fetch;
const traceEvents = [];
globalThis.fetch = async () => new Response(JSON.stringify({
  schema: "tp.ai.result/1",
  translations: [{ id: "g0", text: "สวัสดี" }],
  missing: [],
  meta: {
    generationAttempts: 1, providerAttempts: 1,
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, source: "provider" },
  },
}), { status: 200, headers: { "Content-Type": "application/json" } });
try {
  const { translateUnits } = await import("../src/background/ai/translation-service.js");
  for (const ai of [
    { provider: "gemini", model: "gemini-2.5-flash", api_key: "test", prompt: "full style" },
    { provider: "openrouter", model: "deepseek/test", base_url: "https://openrouter.ai/api/v1", api_key: "test", prompt: "full style" },
  ]) {
    const result = await translateUnits([{ id: "g0", text: "Hello" }], {
      route: "server", ai, base: "https://api.textphantom.test", targetLang: "th",
      trace: (event, data) => traceEvents.push([event, data]),
    });
    assert.equal(result.translations[0].text, "สวัสดี");
  }
  const replies = traceEvents.filter(([event]) => event === "text-only AI reply");
  assert.equal(replies.length, 2);
  assert.ok(replies.every(([, data]) => data.targetLang === "th"));
} finally {
  globalThis.fetch = originalFetch;
}

console.log("AI runtime/session regressions passed: old-session ordering and undefined identifiers.");
