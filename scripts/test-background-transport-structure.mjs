import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

await assert.rejects(access(new URL("../src/background/transport.js", import.meta.url)));
const names = [
  "http-error",
  "translate",
  "lens",
  "groups",
  "cancel",
  "polling",
  "polling-result",
];
const sources = new Map(await Promise.all(names.map(async (name) => [
  name, await readFile(new URL(`../src/background/transports/${name}.js`, import.meta.url), "utf8"),
])));

for (const [name, source] of sources) {
  assert.ok(source.split("\n").length <= 400, `${name}.js exceeds the cohesion limit`);
  assert.doesNotMatch(source, /export\s*\{[^}]+\}\s*from\s*["']/s, `${name}.js forwards exports`);
}

const polling = sources.get("polling");
for (const token of ["let pollSlotsInUse", "const pollSlotWaiters", "const batchWaiters", "let batchLoopRunning", "let backoffUntil"]) {
  assert.equal([...sources.values()].filter((source) => source.includes(token)).length, 1, `${token} needs one owner`);
  assert.ok(polling.includes(token), `${token} belongs in polling.js`);
}

assert.match(polling, /import \{ pollFailure \} from "\.\/polling-result\.js"/);
assert.match(polling, /export \{ pollFailure \}/);
assert.doesNotMatch(polling, /function pollFailure\s*\(/);
assert.equal(
  [...sources.values()].filter((source) =>
    /function pollFailure\s*\(/.test(source),
  ).length,
  1,
  "poll failure normalization needs one implementation owner",
);

assert.equal((sources.get("lens").match(/API_PATHS\.LENS_RAW/g) || []).length, 1);
assert.equal((sources.get("groups").match(/API_PATHS\.ENGINE_EXTENSION_GROUPS/g) || []).length, 1);
assert.doesNotMatch(sources.get("groups"), /API_PATHS\.GROUPS|engineApiPath|\/v1\/groups/);
assert.equal((sources.get("cancel").match(/API_PATHS\.TRANSLATE_CANCEL/g) || []).length, 1);
assert.match(sources.get("translate"), /API_PATHS\.TRANSLATE_V1/);
console.log("Background transport structure passed: endpoint owners split; polling state unique.");
