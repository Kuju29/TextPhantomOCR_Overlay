// 2026.10.17.2: M2 built-in styles; saved style boxes (Manual, Paid, Login) are never rewritten.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from "../src/generated/canonical-prompt-plans.js";
import { migrateKnownBuiltInPromptRecords } from "../src/shared/ai-profile-storage.js";
import { paidEntry, PAID_PROFILE_KEY, paidScope } from "../src/shared/paid-profile.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/builtin-styles-2026.9.13.json", import.meta.url), "utf8"));
let checks = 0;
const key = (lang) => ["openrouter::https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1", "deepseek/model", lang].map(encodeURIComponent).join("::");
const saved = Object.fromEntries(["th", "en", "ja"].map((lang) => [key(lang), { text: fixture.seeded[lang], mode: "replace" }]));
const manual = await migrateKnownBuiltInPromptRecords(saved);
assert.equal(manual.changed, false, "a box holding the 2026.9.13–2026.10.16 built-in is kept");
for (const lang of ["th", "en", "ja"]) assert.equal(manual.prompts[key(lang)].text, fixture.seeded[lang]);
checks += 4;

for (const lang of ["th", "en", "ja"]) {
  assert.match(plans[lang].pieces.editableStyle, /^(?:ภาษาปลายทาง|Target language|訳先言語)[^\n]*\n/);
  assert.equal((plans[lang].pieces.editableStyle.match(/^\d\. /gm) || []).length, 5, `${lang} M2 five steps`);
  // A model never seen before is seeded with the current built-in; a saved entry keeps its text.
  assert.equal(paidEntry({}, "https://api.example.test", "m", lang).prompts[lang].text, plans[lang].pieces.editableStyle);
  checks += 3;
}
assert.ok(typeof paidScope === "function" && PAID_PROFILE_KEY);
assert.equal(existsSync(new URL("../src/shared/ai/builtin-style-history.js", import.meta.url)), false);
for (const file of ["../src/background/ai-profile-resolver.js", "../src/popup/controllers/settings-hydration-controller.js"]) {
  assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /advanceHistorical|builtin-style-history/,
    `${file} sends and shows the saved text unchanged`);
  checks += 1;
}
console.log(`builtin style M2 2026.10.17.2: ${checks + 1} checks passed`);
