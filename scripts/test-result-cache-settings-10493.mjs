// .93 owner report: "the AI translation cache does not respect new settings
// (prompt, Series memory, Send page image, token ceiling)". Every setting that
// changes what the AI is asked or how it answers is part of the cache identity;
// settings that do not (UI language, display font) are not; a change keeps the
// entries made under the old settings, so switching back reuses them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
globalThis.crypto ||= webcrypto;

const checks = [];
const ev = () => ({ addListener() {}, removeListener() {} });
const local = {}, session = {};
const area = store => ({
  get(keys, cb) {
    const out = keys == null ? { ...store } : typeof keys === "string" ? { [keys]: store[keys] }
      : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, store[k]])) : { ...keys, ...store };
    cb?.(out); return Promise.resolve(out);
  },
  set(v, cb) { Object.assign(store, structuredClone(v)); cb?.(); return Promise.resolve(); },
  remove(k, cb) { for (const x of [].concat(k)) delete store[x]; cb?.(); return Promise.resolve(); },
  setAccessLevel: async () => {},
});
globalThis.chrome = {
  runtime: { lastError: null, id: "fixture", getManifest: () => ({ version: "10493" }), sendMessage: async () => ({}),
    getURL: x => x, onMessage: ev(), onInstalled: ev(), onStartup: ev() },
  storage: { local: area(local), session: area(session), onChanged: ev() },
  alarms: { create() {}, clear: async () => true, onAlarm: ev() },
  contextMenus: { create() {}, removeAll(cb) { cb?.(); }, update() {}, onClicked: ev() },
  tabs: { sendMessage: async () => ({}), get: async () => ({}), query: async () => [], onRemoved: ev(), onUpdated: ev() },
};
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const { buildAiPayload } = await import("../src/background/context-menu.js");
const { resultCacheKey, generationFingerprint, createResultCache } = await import("../src/background/result-cache.js");
const { translationSettingsChanged } = await import("../src/background/translation-settings.js");
const md = await import("../src/background/mangadex.js");
const { seriesMemoryKey } = await import("../src/shared/series.js");

// ---------------------------------------------------------------- settings -> real job payload -> key
const SERIES = "site.test/my-series";
const settingsBase = {
  lang: "th", aiProvider: "openrouter", aiModel: "qa/model", aiBaseUrl: "https://openrouter.ai/api/v1", aiKey: "sk-secret-1",
  aiPrompt: "Translate naturally. SECRET-PROMPT-TEXT", aiPageImage: "off", aiMemoryMode: "off", aiStyleExamples: false,
  aiTokenCeiling: null, aiThinking: "off", aiConversationReset: "0", aiModelCapabilities: { vision: { supported: true } },
};
async function payloadFor(settings, { lang = settings.lang, mode = "lens_text", source = "ai", engine = "extension", extra = {} } = {}) {
  const ai = await buildAiPayload(mode, source, settings, SERIES, lang, "https://site.test/my-series/ch1");
  return { src: "https://site.test/ch1/p1.jpg", lang, mode, source, engine, ai, render: { lensDocument: true },
    layout: { relayout_translated: true }, metadata: { image_id: "img-1", batch_id: "b1" },
    context: { page_url: "https://site.test/ch1", series_key: SERIES, page_index: 0, batch_id: "b1" }, ...extra };
}
const keyOf = (payload, apiBase = "http://api.test") => resultCacheKey(payload, { apiBase });
const base = await payloadFor(settingsBase);
const k0 = await keyOf(base);
assert.ok(k0, "an AI page has a cache key");
assert.equal(await keyOf(await payloadFor(settingsBase)), k0, "same settings = same key (Translate again reuses)");

const generation = [
  ["provider", { aiProvider: "openai", aiBaseUrl: "https://api.openai.com/v1" }],
  ["model", { aiModel: "qa/other" }],
  ["base URL", { aiBaseUrl: "https://openrouter.example/api/v1" }],
  ["prompt text (custom prompt / Set prompt per language)", { aiPrompt: "Translate naturally. SECRET-PROMPT-TEXT!" }],
  ["Series memory on (terms)", { aiMemoryMode: "terms" }],
  ["Series memory full", { aiMemoryMode: "full" }],
  ["human examples", { aiStyleExamples: true }],
  ["Send page image", { aiPageImage: "always" }],
  ["token ceiling", { aiTokenCeiling: 4096 }],
  ["AI think level", { aiThinking: "high" }],
  ["conversation reset", { aiConversationReset: "5" }],
  ["on-device runtime", { aiOnDevice: true }],
];
for (const [label, change] of generation)
  assert.notEqual(await keyOf(await payloadFor({ ...settingsBase, ...change })), k0, `${label} change must miss`);
assert.notEqual(await keyOf(await payloadFor({ ...settingsBase, aiTokenCeiling: 4096 })),
  await keyOf(await payloadFor({ ...settingsBase, aiTokenCeiling: 8192 })), "token ceiling value change must miss");
assert.notEqual(await keyOf(await payloadFor(settingsBase, { lang: "en" })), k0, "target language change must miss");
assert.notEqual(await keyOf({ ...base, ai: { ...base.ai, translation_mode: "independent" } }), k0,
  "translation mode (Conversation/Independent) change must miss");
assert.notEqual(await keyOf({ ...base, ai: { ...base.ai, prompt_mode: "append" } }), k0, "prompt mode change must miss");
assert.notEqual(await keyOf({ ...base, engine: "api" }), k0, "engine change must miss");
assert.notEqual(await keyOf({ ...base, layout: { relayout_translated: false } }), k0, "relayout change must miss");
assert.notEqual(await keyOf(base, "http://other-api.test"), k0, "API server change must miss");
checks.push(`each generation setting changes the key (${generation.length + 7} settings incl. language, mode, layout, API server)`);

// Series memory CONTENT (not only on/off): the stored memory travels in the prompt.
const termsSettings = { ...settingsBase, aiMemoryMode: "terms" };
const memKey = seriesMemoryKey(SERIES, "th");
local.aiSeriesMemory = { [memKey]: { glossary: [{ src: "Hero", tgt: "ฮีโร่" }], characters: [], state: "", prevContext: [], at: 1 } };
const kTerms1 = await keyOf(await payloadFor(termsSettings));
assert.equal(await keyOf(await payloadFor(termsSettings)), kTerms1, "unchanged memory content: same key");
local.aiSeriesMemory = { [memKey]: { glossary: [{ src: "Hero", tgt: "พระเอก" }], characters: [], state: "", prevContext: [], at: 2 } };
const kTerms2 = await keyOf(await payloadFor(termsSettings));
assert.notEqual(kTerms2, kTerms1, "edited Series memory (glossary) must miss");
delete local.aiSeriesMemory;
assert.notEqual(await keyOf(await payloadFor(termsSettings)), kTerms2, "cleared Series memory must miss");
const fullSettings = { ...settingsBase, aiMemoryMode: "full" };
local.aiSeriesMemory = { [memKey]: { glossary: [], characters: [{ name: "Aki", gender: "female" }], state: "", prevContext: [{ src: "a", tgt: "ก" }], at: 3 } };
const kFull1 = await keyOf(await payloadFor(fullSettings));
local.aiSeriesMemory = { [memKey]: { glossary: [], characters: [{ name: "Aki", gender: "male" }], state: "", prevContext: [{ src: "a", tgt: "ก" }], at: 4 } };
assert.notEqual(await keyOf(await payloadFor(fullSettings)), kFull1, "edited character memory must miss");
delete local.aiSeriesMemory;
checks.push("Series memory content (glossary, characters, previous context) is part of the identity, not only on/off");

// Settings that do not change the AI output.
for (const [label, change] of [["credential", { aiKey: "sk-secret-2" }], ["UI language", { uiLanguageV1: "th" }],
  ["display font size", { fontScale: 1.4 }], ["model capability estimate", { aiModelCapabilities: { vision: { supported: false } } }]])
  assert.equal(await keyOf(await payloadFor({ ...settingsBase, ...change })), k0, `${label} must not split the key`);
assert.equal(await keyOf({ ...base, ai: { ...base.ai, conversation: { documentId: "d2", owner: "o2" }, workload: { x: 1 } },
  metadata: { image_id: "img-2", batch_id: "b2" }, context: { page_url: "https://site.test/x", batch_id: "b2" } }), k0,
"per-run ids (conversation owner, workload, image/batch ids) must not split the key");
for (const key of ["uiLanguageV1", "fontScale"])
  assert.equal(translationSettingsChanged({ [key]: { oldValue: 1, newValue: 2 } }, "local"), false, `${key} is not a translation setting`);
checks.push("credential, UI language, display font, capability estimates and per-run ids do not invalidate");

assert.ok(!k0.includes("SECRET-PROMPT-TEXT") && !k0.includes("sk-secret") && !k0.includes("Translate naturally"),
  "no raw prompt text or credential in the key");
assert.match(k0, /::g[0-9a-f]{64}::v[0-9a-f]{64}$/, "generation + presentation settings are SHA-256 hashes");
checks.push("prompt text and credentials are hashed, never in the key");

// ---------------------------------------------------------------- old entries stay; switching back reuses
const cache = createResultCache();
const page = text => ({ lensDocument: { paragraphs: [{ aiText: text }] } });
const kPromptB = await keyOf(await payloadFor({ ...settingsBase, aiPrompt: "Prompt B" }));
assert.equal(cache.store(k0, page("A"), { mode: "lens_text", hasHtml: true }).stored, true);
assert.equal(cache.get(kPromptB), null, "new prompt: miss -> a new AI request");
cache.store(kPromptB, page("B"), { mode: "lens_text", hasHtml: true });
assert.equal(cache.get(k0)?.result.lensDocument.paragraphs[0].aiText, "A", "switching back to the old prompt reuses its entry");
assert.equal(cache.get(kPromptB)?.result.lensDocument.paragraphs[0].aiText, "B", "the other settings' entry is not wiped");
const jobs = readFileSync(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobs, /resultCacheKey\(payload, \{ apiBase: base, normalizeUrl: normImgSrc \}\)/,
  "the job key is built without the settings epoch");
assert.doesNotMatch(readFileSync(new URL("../src/background/result-cache.js", import.meta.url), "utf8"), /settingsEpoch/,
  "no settings epoch in the result-cache identity");
checks.push("a settings change keeps other entries; switching back reuses the old settings' entry");

// ---------------------------------------------------------------- semantic epoch (MangaDex / new jobs)
const profiles = ceiling => ({ version: 1, active: { providerIdentity: "p", model: "m" }, providers: { p: { provider: "OpenRouter",
  endpoint: "https://openrouter.ai/api/v1", models: { m: { profile: { thinking: "off", pageImage: "off", memoryMode: "off", ...ceiling } } } } } });
assert.equal(translationSettingsChanged({ aiProfilesV1: { oldValue: profiles({}), newValue: profiles({ tokenCeilingEnabled: true, tokenCeiling: 4096 }) } }, "local"), true,
  "token ceiling on is a semantic change (MangaDex epoch)");
assert.equal(translationSettingsChanged({ aiProfilesV1: { oldValue: profiles({ tokenCeilingEnabled: true, tokenCeiling: 4096 }),
  newValue: profiles({ tokenCeilingEnabled: true, tokenCeiling: 2048 }) } }, "local"), true, "token ceiling value change is semantic");
assert.equal(translationSettingsChanged({ aiProfilesV1: { oldValue: profiles({ tokenCeilingEnabled: false, tokenCeiling: 4096 }),
  newValue: profiles({ tokenCeilingEnabled: false, tokenCeiling: 2048 }) } }, "local"), false, "an OFF ceiling's stored number is not");
for (const field of [{ pageImage: "always" }, { memoryMode: "terms" }, { thinking: "high" }, { styleExamples: true }])
  assert.equal(translationSettingsChanged({ aiProfilesV1: { oldValue: profiles({}), newValue: profiles(field) } }, "local"), true,
    `${Object.keys(field)[0]} is semantic`);
checks.push("token ceiling now advances the semantic settings epoch (page image, memory, think, examples already did)");

// ---------------------------------------------------------------- MangaDex: pressed generation decides reuse
const pressA = await payloadFor(settingsBase, { extra: { src: "https://uploads.mangadex.org/data/h1/p1.png" } });
const pressB = await payloadFor({ ...settingsBase, aiPrompt: "Prompt B" }, { extra: { src: "https://uploads.mangadex.org/data/h1/p1.png" } });
const genA = await generationFingerprint(pressA), genB = await generationFingerprint(pressB);
assert.notEqual(genA, genB);
assert.equal(genA, await generationFingerprint({ mode: "lens_text", lang: "th", source: "ai", engine: "extension", ai: pressA.ai }),
  "the dispatcher's fingerprint (no render/metadata/context) equals the job's");
const mdKey = md.mdCacheKey(md.mdKeyFromUrl(pressA.src), "th", "lens_text", "ai", 5);
md.setCachedResult(mdKey, { newImg: null, generation: genA, result: { html: "A" } });
md.setCachedResult(mdKey, { newImg: null, result: { html: "A repaired" } });
assert.equal(md.getCachedResult(mdKey).generation, genA, "a repair keeps the page's generation");
const scope = { lang: "th", mode: "lens_text", source: "ai" };
assert.equal(md.tabGeneration(7, scope), "", "no press yet: hydration keeps the epoch rule");
md.rememberTabGeneration(7, scope, genB);
assert.equal(md.tabGeneration(7, scope), genB);
assert.equal(md.tabGeneration(7, { ...scope, lang: "en" }), "", "per language/mode/source");
assert.notEqual(md.getCachedResult(mdKey).generation, md.tabGeneration(7, scope), "page made under prompt A is not reused for a prompt-B press");
md.rememberTabGeneration(7, scope, genA);
assert.equal(md.getCachedResult(mdKey).generation, md.tabGeneration(7, scope), "switching back to prompt A reuses it");
md.forgetTabGenerations(7);
assert.equal(md.tabGeneration(7, scope), "", "chapter change / tab close forgets the press");
const index = readFileSync(new URL("../src/background/index.js", import.meta.url), "utf8");
assert.match(index, /if \(pressed && rec\.generation !== pressed\) continue;/, "md hydration filters by the pressed generation");
assert.match(index, /forgetTabGenerations\(tabId\);\s*sessionLifecycle\.onMangaDexChapterChanged/);
const menu = readFileSync(new URL("../src/background/context-menu.js", import.meta.url), "utf8");
assert.match(menu, /rememberTabGeneration\(tab\.id, \{ lang, mode, source \}, await generationFingerprint\(\{\s*mode, lang, source, engine: engineMode, ai: aiPayload \}\)\)/);
const delivery = readFileSync(new URL("../src/background/jobs/result-delivery.js", import.meta.url), "utf8");
assert.match(delivery, /generation: String\(ctx\.generationKey \|\| ""\)/, "md pages record their generation");
checks.push("MangaDex cache: a press reuses only pages made under its generation settings; switching back reuses");

console.log(JSON.stringify({ passed: checks.length, checks }));
process.exit(0);
