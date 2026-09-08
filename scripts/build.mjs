import { isEditorArtifact } from "./source-package-policy.mjs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const platformRoot = path.join(projectRoot, "platform");
const testRunId = String(process.env.TEXTPHANTOM_BUILD_TEST_RUN_ID || "");
if (testRunId && !/^[a-f0-9-]{36}$/.test(testRunId)) {
  throw new Error("TEXTPHANTOM_BUILD_TEST_RUN_ID must be a UUID");
}
const buildWorkRoot = testRunId
  ? path.join(tmpdir(), `textphantom-build-test-${testRunId}`)
  : projectRoot;
if (testRunId) mkdirSync(buildWorkRoot, { recursive: true });
const distRoot = path.join(buildWorkRoot, "dist");
const packageRoot = path.join(buildWorkRoot, "packages");
const releaseName = "TextPhantom-V3";
const buildLockRoot = path.join(buildWorkRoot, ".textphantom-build.lock");

let ownsBuildLock = false;
let lockInspection = "not inspected";
const buildOwner = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  token: randomUUID(),
};

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

function reclaimStaleBuildLock() {
  let owner;
  try {
    owner = JSON.parse(readFileSync(path.join(buildLockRoot, "owner.json"), "utf8"));
  } catch {
    owner = null;
  }
  const startedAt = Date.parse(owner?.startedAt);
  const heartbeatAt = Date.parse(owner?.heartbeatAt || owner?.startedAt);
  const validOwner = Number.isSafeInteger(owner?.pid) && owner.pid > 0 &&
    Number.isFinite(startedAt) && Number.isFinite(heartbeatAt) &&
    typeof owner?.token === "string" && owner.token.length > 0;
  if (validOwner) {
    const ownerAgeMs = Date.now() - startedAt;
    const leaseAgeMs = Date.now() - heartbeatAt;
    const deadOwner = processIsAlive(owner.pid) === false;
    // PID reuse must not preserve a dead lock forever. A live build renews its
    // lease below; reclaim requires either a verified dead PID or a lease that
    // has been abandoned for a conservative interval.
    lockInspection = `owner pid=${owner.pid}, age=${Math.round(ownerAgeMs)}ms, lease=${Math.round(leaseAgeMs)}ms`;
    if (ownerAgeMs < 5_000 || (!deadOwner && leaseAgeMs < 30_000)) return false;
  } else {
    // mkdir can succeed immediately before a crash prevents owner.json from
    // being written. A recent unknown lock remains fail-closed; only an old
    // filesystem object is eligible for atomic quarantine.
    let lockAgeMs;
    try {
      lockAgeMs = Date.now() - lstatSync(buildLockRoot).mtimeMs;
    } catch {
      return false;
    }
    lockInspection = `owner metadata unavailable, lock age=${Math.round(lockAgeMs)}ms`;
    if (!Number.isFinite(lockAgeMs) || lockAgeMs < 30_000) return false;
  }

  const staleRoot = `${buildLockRoot}.stale-${process.pid}-${randomUUID()}`;
  try {
    // Rename is atomic: only one contender can quarantine this exact stale lock.
    renameSync(buildLockRoot, staleRoot);
    rmSync(staleRoot, { recursive: true, force: true });
    return true;
  } catch (error) {
    lockInspection = `stale lock quarantine failed: ${error?.code || error?.message || "unknown"}`;
    return false;
  }
}

for (let attempt = 0; attempt < 2 && !ownsBuildLock; attempt += 1) {
  try {
    mkdirSync(buildLockRoot);
    writeFileSync(
      path.join(buildLockRoot, "owner.json"),
      `${JSON.stringify(buildOwner, null, 2)}\n`,
    );
    ownsBuildLock = true;
  } catch (error) {
    if (error?.code === "EEXIST" && attempt === 0 && reclaimStaleBuildLock()) continue;
    if (error?.code === "EEXIST") {
      throw new Error(
        `Another TextPhantom build is already running (lock: ${buildLockRoot}). ` +
        `Wait for it to finish before running the build again. (${lockInspection})`,
        { cause: error },
      );
    }
    throw error;
  }
}

const buildHeartbeat = setInterval(() => {
  if (!ownsBuildLock) return;
  try {
    buildOwner.heartbeatAt = new Date().toISOString();
    writeFileSync(
      path.join(buildLockRoot, "owner.json"),
      `${JSON.stringify(buildOwner, null, 2)}\n`,
    );
  } catch {
    // Losing the lock is detected by token verification during release.
  }
}, 2_000);
buildHeartbeat.unref();

function releaseBuildLock() {
  clearInterval(buildHeartbeat);
  if (!ownsBuildLock) return;
  try {
    const current = JSON.parse(readFileSync(path.join(buildLockRoot, "owner.json"), "utf8"));
    if (current?.token === buildOwner.token) {
      rmSync(buildLockRoot, { recursive: true, force: true });
      ownsBuildLock = false;
    }
  } catch {
    // A missing/replaced lock is not ours to remove.
  }
}

process.on("exit", releaseBuildLock);

// Test-only delay makes the concurrency regression deterministic without
// changing normal builds.
const testHoldMs = Number(process.env.TEXTPHANTOM_BUILD_TEST_HOLD_MS || 0);
if (Number.isFinite(testHoldMs) && testHoldMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, Math.min(testHoldMs, 5_000)));
}

const baseManifest = JSON.parse(
  await readFile(path.join(platformRoot, "base.json"), "utf8"),
);
const version = baseManifest.version;

// Direct-local must remain independent of a running API. Generate its signed
// canonical plans from the same Python source before copying src into dist.
execFileSync(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), [
  path.join(projectRoot, "scripts", "generate-canonical-prompt-plan.py"),
], { cwd: projectRoot, stdio: "inherit" });

// --- Single source of truth for the version --------------------------------
// platform/base.json is the ONLY place to edit the version: every browser
// manifest is merged from it. package.json needs a valid npm semver, so a
// A four-segment manifest version maps to an npm prerelease. Sync it here so
// bumping base.json alone keeps everything in step — no second edit, no drift.
function manifestToNpmVersion(v) {
  const parts = String(v).split(".").filter(Boolean);
  const core = parts.slice(0, 3).join(".");
  const rest = parts.slice(3).join(".");
  return rest ? `${core}-${rest}` : core;
}

{
  const pkgPath = path.join(projectRoot, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  const desired = manifestToNpmVersion(version);
  if (pkg.version !== desired) {
    pkg.version = desired;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Synced package.json version -> ${desired}`);
  }
}

const targets = [
  {
    id: "chrome",
    platform: "chromium",
    file: `${releaseName}-Chrome-Web-Store-${version}.zip`,
  },
  {
    id: "edge",
    platform: "chromium",
    file: `${releaseName}-Microsoft-Edge-Add-ons-${version}.zip`,
  },
  {
    id: "opera",
    platform: "chromium",
    file: `${releaseName}-Opera-Add-ons-${version}.zip`,
  },
  {
    id: "firefox",
    platform: "firefox",
    file: `${releaseName}-Firefox-AMO-${version}.zip`,
  },
  {
    id: "thunderbird",
    platform: "thunderbird",
    file: `${releaseName}-Thunderbird-ATN-${version}.zip`,
  },
];

function merge(base, overlay) {
  if (Array.isArray(overlay)) return [...overlay];
  if (!overlay || typeof overlay !== "object") return overlay;
  const result = {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
  };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? merge(result[key], value)
        : Array.isArray(value)
          ? [...value]
          : value;
  }
  return result;
}

async function walkFiles(root, prefix = "") {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // rsync may briefly create this internal directory while updating a tree.
    // It is never extension content and must never enter a release archive.
    if (entry.isDirectory() && entry.name === ".rsync-tmp") continue;
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute, relative)));
    } else if (entry.isFile()) {
      if (isEditorArtifact(relative)) throw new Error(`Editor artifact must not ship: ${relative}`);
      files.push({ absolute, relative });
    }
  }
  return files;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTimestamp() {
  const [year, month, day] = version.split(".").slice(0, 3).map(Number);
  const dosTime = 0;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

async function makeZip(outputPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = zipTimestamp();

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const data = entry.data ?? (await readFile(entry.absolute));
    const name = Buffer.from(entry.name.replaceAll("\\", "/"), "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(
    outputPath,
    Buffer.concat([...localParts, centralDirectory, end]),
  );
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

await rm(distRoot, { recursive: true, force: true });
await rm(packageRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
await mkdir(packageRoot, { recursive: true });

const builtPackages = [];
for (const target of targets) {
  const targetRoot = path.join(distRoot, target.id);
  await cp(sourceRoot, targetRoot, { recursive: true });

  const overlay = JSON.parse(
    await readFile(path.join(platformRoot, `${target.platform}.json`), "utf8"),
  );
  const manifest = merge(baseManifest, overlay);
  await writeFile(
    path.join(targetRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const files = await walkFiles(targetRoot);
  const output = path.join(packageRoot, target.file);
  await makeZip(
    output,
    files.map((file) => ({
      absolute: file.absolute,
      name: file.relative,
    })),
  );
  builtPackages.push(output);
}

const sourceEntries = [];
const SOURCE_SKIP_DIRS = new Set([
  ".git", ".pytest_cache", ".ruff_cache", ".venv", "venv",
  "__pycache__", "build", "dist", "models", "logs", "state",
]);
async function walkSourceFiles(root, prefix = "", include = () => true) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && SOURCE_SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (/^api\/(?:tests|logs|state)(?:\/|$)/i.test(relative)) continue;
    if (!include(relative, { directory: entry.isDirectory() })) continue;
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(absolute, relative, include)));
    } else if (entry.isFile() && !entry.name.endsWith(".pyc")) {
      if (isEditorArtifact(relative)) throw new Error(`Editor artifact must not ship: ${relative}`);
      files.push({ absolute, relative });
    }
  }
  return files;
}
for (const directory of ["src", "platform", "scripts", "api"]) {
  for (const file of await walkSourceFiles(path.join(projectRoot, directory), directory)) {
    sourceEntries.push({ absolute: file.absolute, name: file.relative });
  }
}
for (const filename of [
  "README.md",
  "README-TH.md",
  "STORE-CHECKLIST-TH.md",
  "PROJECT_CONTEXT.md",
  "RELEASE_NOTES.md",
  "ENGINE_MODES.md",
  "CONCURRENCY.md",
  "DIAGNOSIS.md",
  "CODE_STYLE.md",
  "roadmap.md",
  "package.json",
  "build.bat",
  "build.sh",
]) {
  const absolute = path.join(projectRoot, filename);
  // Optional docs (README-TH / STORE-CHECKLIST-TH) may be absent — skip any
  // file that does not exist so the source bundle never fails the whole build.
  try {
    if (!(await stat(absolute)).isFile()) continue;
  } catch {
    continue;
  }
  sourceEntries.push({ absolute, name: filename });
}
for (const file of builtPackages) {
  sourceEntries.push({
    absolute: file,
    name: path.posix.join("packages", path.basename(file)),
  });
}

const projectPackage = path.join(
  packageRoot,
  `${releaseName}-${version}.zip`,
);
await makeZip(projectPackage, sourceEntries);

const allPackages = [...builtPackages, projectPackage];
const checksums = [];
for (const file of allPackages) {
  checksums.push(`${await sha256(file)}  ${path.basename(file)}`);
}
await writeFile(
  path.join(packageRoot, "SHA256SUMS.txt"),
  `${checksums.join("\n")}\n`,
);

console.log(`Built TextPhantom ${version}`);
for (const file of allPackages) {
  const info = await stat(file);
  console.log(`- ${path.basename(file)} (${info.size} bytes)`);
}
releaseBuildLock();
