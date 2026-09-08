import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("./test-prompt-language-parity.mjs", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "textphantom-parity-"));
const arbitraryCwd = join(temporaryRoot, "unrelated path ภาษาไทย");
const poisonedPythonPath = join(temporaryRoot, "missing api path");

mkdirSync(arbitraryCwd, { recursive: true });

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === "pythonpath") delete env[key];
}
env.PYTHONPATH = poisonedPythonPath;

try {
  const output = execFileSync(process.execPath, [target], {
    cwd: arbitraryCwd,
    encoding: "utf8",
    env,
  });
  assert.match(output, /Target-language prompt parity passed/);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("Target-language parity is independent of cwd and inherited PYTHONPATH.");
