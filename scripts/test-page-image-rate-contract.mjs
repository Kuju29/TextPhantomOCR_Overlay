import assert from "node:assert/strict";
import {
  assertPageImageSupported,
  modelVisionSupport,
  pageImageEnabled,
} from "../src/shared/page-image-policy.js";
import { normalizeModelCapabilities } from "../src/shared/model-capabilities.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
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
  (error) => error.code === "AI_PAGE_IMAGE_UNVERIFIED" && /AI settings > Send page image/.test(error.message));
assert.throws(() => assertPageImageSupported(true, { vision: { supported: false } }),
  (error) => error.code === "AI_PAGE_IMAGE_UNSUPPORTED");
assert.doesNotThrow(() => assertPageImageSupported(true, { vision: { supported: true } }));

const dataUri = "data:image/png;base64,AAAA";
const openAi = createOpenAiCompatibleAdapter({ baseUrl: "http://127.0.0.1:1234" });
assert.equal(openAi.buildUserContent("text", dataUri)[1].image_url.url, dataUri);
const ollama = createOllamaAdapter({ baseUrl: "http://127.0.0.1:11434" });
assert.deepEqual(ollama.userImageFields(dataUri), { images: ["AAAA"] });

// The manual-rate UI part retired with the rate cap (.68); its controller was removed.
console.log("Page-image capability/normalization invariant passed.");
