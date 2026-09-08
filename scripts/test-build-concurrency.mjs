import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(projectRoot, "scripts", "build.mjs");
const runId = randomUUID();
const runRoot = path.join(tmpdir(), `textphantom-build-test-${runId}`);
const lockRoot = path.join(runRoot, ".textphantom-build.lock");
const baseEnv = { TEXTPHANTOM_BUILD_TEST_RUN_ID: runId };

function runBuild(env = {}) {
  const child = spawn(process.execPath, [buildScript], {
    cwd: projectRoot,
    env: { ...process.env, ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitForOwnedLock(expectedPid) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const owner = JSON.parse(await readFile(path.join(lockRoot, "owner.json"), "utf8"));
      if (owner?.pid === expectedPid) return;
    } catch {
      // The owner file follows the atomic lock-directory creation.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("first isolated build did not acquire its build lock");
}

async function expectSuccessfulRecovery(label) {
  const build = runBuild();
  const result = await build.done;
  assert.equal(result.code, 0, `${label} must be recovered safely:\n${result.stderr}`);
  assert.match(result.stdout, /Built TextPhantom/);
}

let first;
try {
  first = runBuild({ TEXTPHANTOM_BUILD_TEST_HOLD_MS: "750" });
  await waitForOwnedLock(first.child.pid);
  const second = runBuild();
  const rejected = await second.done;
  assert.notEqual(rejected.code, 0, "a concurrent build must not mutate shared outputs");
  assert.match(rejected.stderr, /Another TextPhantom build is already running/);
  const completed = await first.done;
  first = null;
  assert.equal(completed.code, 0, `the lock owner must finish normally:\n${completed.stderr}`);

  await mkdir(lockRoot);
  await writeFile(path.join(lockRoot, "owner.json"), `${JSON.stringify({
    pid: 2_147_483_647,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    token: "stale-dead-owner",
  })}\n`);
  await expectSuccessfulRecovery("a verified dead owner lock");

  await mkdir(lockRoot);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockRoot, old, old);
  await expectSuccessfulRecovery("an old lock missing owner.json");

  await mkdir(lockRoot);
  await writeFile(path.join(lockRoot, "owner.json"), "{malformed");
  await utimes(lockRoot, old, old);
  await expectSuccessfulRecovery("an old malformed owner lock");

  await mkdir(lockRoot);
  const recentUnknown = runBuild();
  const recentResult = await recentUnknown.done;
  assert.notEqual(recentResult.code, 0, "a recent unknown lock must fail closed");
  assert.match(recentResult.stderr, /Another TextPhantom build is already running/);
} finally {
  if (first?.child.exitCode === null) {
    first.child.kill();
    await first.done;
  }
  await rm(runRoot, { recursive: true, force: true });
}

console.log("Build locking passed: concurrent/recent unknown locks fail closed; verified stale locks recover.");
