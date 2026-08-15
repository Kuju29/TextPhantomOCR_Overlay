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

const referenced = new Set();
for (const command of Object.values(pkg.scripts || {})) {
  for (const match of String(command).matchAll(/scripts\/([\w.-]+\.mjs)/g)) {
    referenced.add(match[1]);
  }
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

console.log(`npm script test passed: ${referenced.size} referenced scripts, all present and non-empty.`);
