import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { cloudProviderCatalog, cloudProviderFromKey, cloudProviderSpec } from "../src/shared/ai/providers/cloud-registry.js";

const expected = ["gemini", "openai", "openrouter", "anthropic", "groq", "deepseek", "together", "huggingface", "featherless"];
const catalog = cloudProviderCatalog();
assert.deepEqual(catalog.map((spec) => spec.id), expected);
assert.equal(new Set(catalog.map((spec) => spec.id)).size, catalog.length);
for (const spec of catalog) {
  assert.ok(spec.displayName && spec.defaultModel && spec.keyUrl && spec.protocol && spec.modelsPath);
  assert.equal(cloudProviderSpec(spec.id), spec);
  assert.match(spec.keyUrl, /^https:\/\//);
  assert.ok(spec.baseUrl === "" || /^https:\/\//.test(spec.baseUrl));
}
assert.equal(cloudProviderFromKey("sk-or-example"), "openrouter");
assert.equal(cloudProviderFromKey("sk-ant-example"), "anthropic");
assert.equal(cloudProviderFromKey("sk-example"), "openai");
assert.equal(cloudProviderSpec("gemini").thinkingControl, true);
for (const id of expected.filter((id) => id !== "gemini")) assert.equal(cloudProviderSpec(id).thinkingControl, false);

const dir = new URL("../src/shared/ai/providers/", import.meta.url);
const leaves = (await readdir(dir)).filter((name) => /^cloud-(?!registry|spec).*\.js$/.test(name));
assert.equal(leaves.length, expected.length);
for (const leaf of leaves) {
  const source = await readFile(new URL(leaf, dir), "utf8");
  assert.doesNotMatch(source, /defineCloudProvider\(\{[^\n]+\}\)/, `${leaf} must remain maintainable provider-owned metadata`);
}
await assert.rejects(access(new URL("../src/shared/local-ai-config.js", import.meta.url)));

for (const path of [
  "../src/popup/controllers/ai-profile-controller.js",
  "../src/popup/controllers/provider-model-display.js",
  "../src/popup/provider-key-links.js",
  "../src/popup/dom.js",
  "../src/shared/constants.js",
]) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(source, /CLOUD_DEFAULT_ENDPOINTS|CLOUD_PROVIDER_KEY_URLS|PROVIDER_LABELS|KEY_PREFIX_PROVIDER/);
  if (path.endsWith("dom.js")) assert.doesNotMatch(source, /provider\s*===\s*["'](?:gemini|openai|openrouter|anthropic|groq|deepseek|together|huggingface|featherless)["']/);
  assert.doesNotMatch(source, /https:\/\/(?:api\.openai|openrouter\.ai\/api|api\.anthropic|api\.groq|api\.deepseek|api\.together|router\.huggingface|api\.featherless)/);
}

const html = await readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8");
for (const id of expected) assert.doesNotMatch(html, new RegExp(`<option\\s+value=["']${id}["']`));
console.log("Cloud provider catalog passed: leaf-owned metadata and no popup endpoint maps.");
