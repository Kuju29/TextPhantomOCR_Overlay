import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTranslationService } from "../src/background/ai/translation-service.js";

const calls = [];
const directLocal = async (units, options) => {
  calls.push({ owner: "local", units, options });
  return { translations: [], missing: [] };
};
const server = async (units, options) => {
  calls.push({ owner: "cloud", units, options });
  return { translations: [], missing: [] };
};
const service = createTranslationService({ directLocal, server });
const units = [{ id: "g0", text: "source" }];

await service(units, { route: "direct-local", sentinel: "local-only" });
assert.deepEqual(calls.map((call) => call.owner), ["local"]);
assert.equal(calls[0].options.sentinel, "local-only");

calls.length = 0;
await service(units, { route: "server", sentinel: "cloud-only" });
assert.deepEqual(calls.map((call) => call.owner), ["cloud"]);
assert.equal(calls[0].options.sentinel, "cloud-only");

const localRoute = await readFile(
  new URL("../src/background/ai/routes/direct-local.js", import.meta.url),
  "utf8",
);
const cloudRoute = await readFile(
  new URL("../src/background/ai/routes/server.js", import.meta.url),
  "utf8",
);
const page = await readFile(
  new URL("../src/background/pipeline/page-translation.js", import.meta.url),
  "utf8",
);
assert.match(localRoute, /prompt-cache\.js/);
assert.match(localRoute, /transports\/direct-local\.js/);
assert.doesNotMatch(localRoute, /transports\/server\.js|translateViaServer/);
assert.match(cloudRoute, /transports\/server\.js/);
assert.doesNotMatch(cloudRoute, /prompt-cache\.js|direct-local|translateDirectLocal/);
assert.doesNotMatch(page, /getCanonicalPrompt|getPromptAudit|canonicalPrompt/,
  "provider-specific prompt preparation must not leak into page orchestration");

console.log("AI route isolation passed: Local and Cloud enter disjoint route-owned files.");
