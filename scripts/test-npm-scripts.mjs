// Every scripts/*.mjs named by package.json must exist, and every scripts/*.mjs
// must be named. A build that lists a file nobody wrote fails on the first run;
// a test nobody runs is worse, because it looks like coverage.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = path.join(projectRoot, "scripts");
const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

assert.equal(
  pkg.scripts?.build,
  "node scripts/build.mjs && node scripts/validate.mjs",
  "npm run build must package and validate directly; run regressions explicitly with npm test",
);
assert.equal(
  Object.hasOwn(pkg.scripts || {}, "prebuild"),
  false,
  "npm run build must not hide a regression suite in a prebuild lifecycle hook",
);

// Packaging is part of the root unit gate: excluded project trees must not
// silently return to release archives.
await import("./test-source-package-policy.mjs");

const referenced = new Set();
for (const command of Object.values(pkg.scripts || {})) {
  for (const match of String(command).matchAll(/scripts\/([\w.-]+\.mjs)/g)) {
    referenced.add(match[1]);
  }
}

// Shared script helper has an executable owner, not a fake npm test.
const helpers = new Map([["script-reachability.mjs", "scripts/test-script-reachability.mjs"]]);
for (const [name, owner] of helpers) {
  assert.ok((await readFile(path.join(projectRoot, owner), "utf8")).includes(name));
  referenced.add(name);
}

// Runtime helpers do not need a fake npm command merely to satisfy this audit.
// Keep each cross-language entry point tied to its real owner, and verify the
// owner still contains the executable reference so this cannot become a stale
// allowlist.
const runtimeEntrypoints = new Map([
  ["cli-extension-driver.mjs", "api/backend/cli.py"],
]);
for (const [name, owner] of runtimeEntrypoints) {
  const ownerSource = await readFile(path.join(projectRoot, owner), "utf8");
  assert.ok(
    ownerSource.includes(name) && ownerSource.includes('"scripts"'),
    `scripts/${name} is registered as runtime infrastructure but ${owner} no longer references it`,
  );
  referenced.add(name);
}

const present = new Set(
  (await readdir(scriptsRoot)).filter((name) => name.endsWith(".mjs")),
);

const missing = [...referenced].filter((name) => !present.has(name)).sort();
const unused = [...present].filter((name) => !referenced.has(name)).sort();

assert.deepEqual(
  missing,
  [],
  `package.json runs scripts that do not exist:\n- ${missing.join("\n- ")}`,
);
assert.deepEqual(
  unused,
  [],
  `scripts/ holds files no npm script runs (dead tests look like coverage):\n- ${unused.join("\n- ")}`,
);

for (const name of referenced) {
  const info = await stat(path.join(scriptsRoot, name));
  assert.ok(info.size > 0, `scripts/${name} is empty`);
}

console.log(
  `script entry-point test passed: ${referenced.size} npm/runtime scripts, all present and non-empty.`,
);
