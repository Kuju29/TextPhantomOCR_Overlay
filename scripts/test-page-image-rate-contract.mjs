import assert from "node:assert/strict";
import {
  assertPageImageSupported,
  modelVisionSupport,
  pageImageEnabled,
} from "../src/shared/page-image-policy.js";
import { normalizeModelCapabilities } from "../src/shared/model-capabilities.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
import { createRateSettingsController } from "../src/popup/controllers/rate-settings-controller.js";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile(new URL(
  "./fixtures/model-capabilities-vision.json", import.meta.url,
), "utf8"));
assert.deepEqual(normalizeModelCapabilities(fixture.input), fixture.normalized);

assert.equal(pageImageEnabled(true), true);
assert.equal(pageImageEnabled("always"), true);
assert.equal(pageImageEnabled(false), false);
assert.equal(pageImageEnabled("off"), false);
assert.equal(modelVisionSupport(normalizeModelCapabilities({
  vision: { supported: true, source: "live catalogue" },
})), true);
assert.throws(() => assertPageImageSupported(true, {}),
  (error) => error.code === "AI_PAGE_IMAGE_UNVERIFIED" && /AI option > Page image/.test(error.message));
assert.throws(() => assertPageImageSupported(true, { vision: { supported: false } }),
  (error) => error.code === "AI_PAGE_IMAGE_UNSUPPORTED");
assert.doesNotThrow(() => assertPageImageSupported(true, { vision: { supported: true } }));

const dataUri = "data:image/png;base64,AAAA";
const openAi = createOpenAiCompatibleAdapter({ baseUrl: "http://127.0.0.1:1234" });
assert.equal(openAi.buildUserContent("text", dataUri)[1].image_url.url, dataUri);
const ollama = createOllamaAdapter({ baseUrl: "http://127.0.0.1:11434" });
assert.deepEqual(ollama.userImageFields(dataUri), { images: ["AAAA"] });

const listeners = {};
const element = (value = "") => ({ value, checked: false,
  addEventListener(name, fn) { listeners[`${this.id}:${name}`] = fn; } });
const enabled = element(); enabled.id = "enabled"; enabled.checked = true;
const profile = element("custom"); profile.id = "profile";
const rpm = element("42"); rpm.id = "rpm";
const burst = element("3"); burst.id = "burst";
const writes = [];
const controller = createRateSettingsController({
  els: { rateLimitEnabled: enabled, rateProfile: profile, rateRpm: rpm,
    rateBurst: burst, aiProvider: element("openrouter"), ratePresetHint: { textContent: "", dataset: {} } },
  constants: { presets: {}, fallback: { rpm: 30, burst: 4 },
    rpmMin: 1, rpmMax: 600, burstMin: 1, burstMax: 60 },
  persist: async (patch) => writes.push(patch), toggleUi: () => {},
});
controller.bind();
profile.value = "auto";
await listeners["profile:change"]();
assert.equal(enabled.checked, false, "provider-managed profile must turn the manual cap switch off");
assert.deepEqual(writes.at(-1), {
  rateProfile: "auto", rateRpm: 0, rateBurst: 0, rateLimitEnabled: false,
});

profile.value = "auto";
enabled.checked = true;
await listeners["enabled:change"]();
assert.equal(enabled.checked, true);
assert.equal(profile.value, "balanced",
  "explicitly enabling the cap must leave provider-managed mode");
assert.deepEqual(writes.at(-1), {
  rateLimitEnabled: true, rateProfile: "balanced", rateRpm: 30, rateBurst: 4,
});

console.log("Page-image capability/normalization and manual-rate UI invariant passed.");
