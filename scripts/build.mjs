import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");
const platformRoot = path.join(projectRoot, "platform");
const distRoot = path.join(projectRoot, "dist");
const packageRoot = path.join(projectRoot, "packages");

const baseManifest = JSON.parse(
  await readFile(path.join(platformRoot, "base.json"), "utf8"),
);
const version = baseManifest.version;

// --- Single source of truth for the version --------------------------------
// platform/base.json is the ONLY place to edit the version: every browser
// manifest is merged from it. package.json needs a valid npm semver, so a
// four-segment manifest version like "2026.7.24.1" maps to the prerelease
// "2026.7.24-1". Sync it here so bumping base.json alone keeps everything in
// step — no second edit, no drift.
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

// --- The API's copy of the version -----------------------------------------
// The Docker image copies only `api/`, so `platform/base.json` and
// `package.json` are not there to read at runtime and `api/Dockerfile` copies
// this file instead. It is generated here rather than hand-maintained: a second
// place to type the version is a second place for it to be wrong, and a missing
// file fails the image build (observed 2026-08-15: "COPY build-manifest.json
// ... not found").
{
  const manifestPath = path.join(projectRoot, "api", "build-manifest.json");
  const desired = `${JSON.stringify({ schema: "tp.build-manifest/1", version }, null, 2)}\n`;
  let current = "";
  try {
    current = await readFile(manifestPath, "utf8");
  } catch {
  }
  if (current !== desired) {
    await writeFile(manifestPath, desired);
    console.log(`Wrote api/build-manifest.json -> ${version}`);
  }
}

const targets = [
  {
    id: "chrome",
    platform: "chromium",
    file: `TextPhantom-Chrome-Web-Store-${version}.zip`,
  },
  {
    id: "edge",
    platform: "chromium",
    file: `TextPhantom-Microsoft-Edge-Add-ons-${version}.zip`,
  },
  {
    id: "opera",
    platform: "chromium",
    file: `TextPhantom-Opera-Add-ons-${version}.zip`,
  },
  {
    id: "firefox",
    platform: "firefox",
    file: `TextPhantom-Firefox-AMO-${version}.zip`,
  },
  {
    id: "thunderbird",
    platform: "thunderbird",
    file: `TextPhantom-Thunderbird-ATN-${version}.zip`,
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
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute, relative)));
    } else if (entry.isFile()) {
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
for (const directory of ["src", "platform", "scripts"]) {
  for (const file of await walkFiles(path.join(projectRoot, directory), directory)) {
    sourceEntries.push({ absolute: file.absolute, name: file.relative });
  }
}
for (const filename of [
  "README.md",
  "README-TH.md",
  "STORE-CHECKLIST-TH.md",
  "PROJECT_CONTEXT.md",
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
  `TextPhantom-Cross-Browser-Project-${version}.zip`,
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
