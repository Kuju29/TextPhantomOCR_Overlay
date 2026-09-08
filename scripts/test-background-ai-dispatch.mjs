import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTranslationService } from "../src/background/ai/translation-service.js";

const calls = [];
const service = createTranslationService({
  directLocal: async (units, options) => (calls.push(["direct-local", units, options]), { route: "direct" }),
  server: async (units, options) => (calls.push(["server", units, options]), { route: "server" }),
});
const units = [{ id: "P0", text: "source" }];
assert.deepEqual(await service(units, { route: "direct-local", marker: 1 }), { route: "direct" });
assert.deepEqual(await service(units, { route: "server", marker: 2 }), { route: "server" });
assert.deepEqual(calls.map(([route]) => route), ["direct-local", "server"]);
assert.equal(calls[0][1], units);
assert.equal(calls[1][2].marker, 2);
assert.deepEqual(await service([], { route: "server" }), {
  translations: [], missing: [], meta: { route: "server", skipped: "no units" },
});
assert.equal(calls.length, 2);
await assert.rejects(service(units, { route: "unknown" }), /unknown AI route/);

for (const path of ["../src/background/ai-local.js", "../src/shared/local-ai-adapter.js"]) {
  await assert.rejects(readFile(new URL(path, import.meta.url), "utf8"), { code: "ENOENT" });
}
console.log("Background AI dispatch passed: both routes, empty guard, unknown route and no legacy facades.");
