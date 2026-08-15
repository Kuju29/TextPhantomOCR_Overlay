import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const packageRoot = path.join(projectRoot, "packages");
const targets = ["chrome", "edge", "opera", "firefox", "thunderbird"];
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function walk(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute)));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function collectManifestFiles(manifest) {
  const files = new Set();
  const add = (value) => {
    if (typeof value === "string" && value) files.add(value);
  };
  add(manifest.background?.service_worker);
  for (const file of manifest.background?.scripts || []) add(file);
  add(manifest.action?.default_popup);
  add(manifest.message_display_action?.default_popup);
  for (const value of Object.values(manifest.icons || {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) add(value);
  for (const value of Object.values(
    manifest.message_display_action?.default_icon || {},
  )) {
    add(value);
  }
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) add(file);
    for (const file of script.css || []) add(file);
  }
  return [...files];
}

for (const target of targets) {
  const root = path.join(distRoot, target);
  const manifestPath = path.join(root, "manifest.json");
  assert(await exists(manifestPath), `${target}: manifest.json is missing`);
  if (!(await exists(manifestPath))) continue;

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`${target}: invalid manifest JSON: ${error.message}`);
    continue;
  }

  assert(manifest.manifest_version === 3, `${target}: manifest_version must be 3`);
  for (const file of collectManifestFiles(manifest)) {
    assert(await exists(path.join(root, file)), `${target}: missing ${file}`);
  }

  const permissions = new Set(manifest.permissions || []);
  if (["chrome", "edge", "opera"].includes(target)) {
    assert(Boolean(manifest.background?.service_worker), `${target}: service_worker missing`);
    assert(!manifest.background?.scripts, `${target}: background.scripts is forbidden`);
    assert(!manifest.browser_specific_settings, `${target}: Gecko settings are forbidden`);
    assert(!manifest.message_display_action, `${target}: Thunderbird action is forbidden`);
    for (const permission of ["menus", "messagesRead", "scripting"]) {
      assert(!permissions.has(permission), `${target}: ${permission} is forbidden`);
    }
  }

  if (target === "firefox") {
    assert(Boolean(manifest.background?.scripts), "firefox: background.scripts missing");
    assert(!manifest.background?.service_worker, "firefox: service_worker is forbidden");
    assert(!manifest.message_display_action, "firefox: Thunderbird action is forbidden");
    for (const permission of ["messagesRead", "scripting"]) {
      assert(!permissions.has(permission), `firefox: ${permission} is forbidden`);
    }
  }

  if (target === "thunderbird") {
    assert(Boolean(manifest.background?.scripts), "thunderbird: background.scripts missing");
    assert(!manifest.background?.service_worker, "thunderbird: service_worker is forbidden");
    assert(Boolean(manifest.message_display_action), "thunderbird: message action missing");
    for (const permission of ["menus", "messagesRead", "scripting"]) {
      assert(permissions.has(permission), `thunderbird: ${permission} is required`);
    }
    assert(
      await exists(path.join(root, "background/thunderbird.js")),
      "thunderbird: message display integration is missing",
    );
  }

  // Every web-accessible resource must resolve. A missing one is invisible at
  // load time and only fails when the page tries to import the renderer.
  for (const rule of manifest.web_accessible_resources || []) {
    for (const pattern of rule.resources || []) {
      if (pattern.includes("*")) {
        const dir = path.join(root, path.dirname(pattern));
        const suffix = path.basename(pattern).replace("*", "");
        let matched = [];
        try {
          matched = (await readdir(dir)).filter((name) => name.endsWith(suffix));
        } catch {
          matched = [];
        }
        assert(matched.length > 0, `${target}: web_accessible_resources ${pattern} matches nothing`);
      } else {
        assert(
          await exists(path.join(root, pattern)),
          `${target}: web_accessible_resources ${pattern} is missing`,
        );
      }
    }
  }

  const files = await walk(root);
  for (const file of files) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    assert(!relative.includes("__pycache__"), `${target}: Python cache included`);
    assert(!relative.endsWith(".pyc"), `${target}: .pyc file included`);
    assert(!relative.endsWith(".rebuild"), `${target}: rebuild file included`);
    assert(!relative.startsWith("api/"), `${target}: backend files included`);

    if (file.endsWith(".js")) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(
        /(?:import\s+(?:[^"']+\s+from\s+)?|export\s+[^"']+\s+from\s+)["'](\.[^"']+)["']/g,
      )) {
        const imported = path.resolve(path.dirname(file), match[1]);
        assert(await exists(imported), `${target}: ${relative} imports missing ${match[1]}`);
      }
    }
  }
}

const packageFiles = await readdir(packageRoot);
for (const target of [
  "Chrome-Web-Store",
  "Microsoft-Edge-Add-ons",
  "Opera-Add-ons",
  "Firefox-AMO",
  "Thunderbird-ATN",
  "Cross-Browser-Project",
]) {
  assert(
    packageFiles.some((name) => name.includes(target) && name.endsWith(".zip")),
    `package missing: ${target}`,
  );
}
assert(packageFiles.includes("SHA256SUMS.txt"), "SHA256SUMS.txt is missing");

if (failures.length) {
  console.error("Validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Validation passed for Chrome, Edge, Opera, Firefox and Thunderbird.");
}
