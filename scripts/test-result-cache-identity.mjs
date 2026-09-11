import assert from "node:assert/strict";
import { mdCacheKey, getCachedResult, setCachedResult } from "../src/background/mangadex.js";
import { translationSettingsChanged } from "../src/background/translation-settings.js";

const image = "md:data/hash/page.png";
const exactA = mdCacheKey(image, "th", "lens_text", "ai", 17);
const exactB = mdCacheKey(image, "th", "lens_text", "ai", 17);
const changedModelOrPrompt = mdCacheKey(image, "th", "lens_text", "ai", 18);

assert.equal(exactA, exactB, "an unchanged semantic settings revision must hit");
assert.notEqual(exactA, changedModelOrPrompt,
  "a model/prompt/settings revision must miss the rendered-result cache");
setCachedResult(exactA, { newImg: null, result: { html: "translated" } });
assert.deepEqual(getCachedResult(exactB)?.result, { html: "translated" });
assert.equal(getCachedResult(changedModelOrPrompt), null);

const serialized = `${exactA}\n${changedModelOrPrompt}`;
for (const secret of ["sk-live-secret", "translate everything as pirates", "deepseek/private-model"])
  assert.equal(serialized.includes(secret), false,
    "cache identity must not contain credentials, raw prompt, or model names");
assert.match(exactA, /::r17$/);

const relayoutOffToOn = {
  relayoutTranslated: { oldValue: false, newValue: true },
};
assert.equal(translationSettingsChanged(relayoutOffToOn, "local"), true,
  "changing translated relayout must advance the semantic cache revision");
assert.equal(translationSettingsChanged({
  relayoutTranslated: { oldValue: true, newValue: true },
}, "local"), false, "an unchanged relayout setting must preserve cache hits");
assert.equal(translationSettingsChanged({
  fontScale: { oldValue: 1, newValue: 1.2 },
}, "local"), false,
"font scale is reapplied live and must not churn the rendered-result cache");

console.log("Rendered-result cache identity passed: exact revision hits, changed profile misses, no secret text in key.");
