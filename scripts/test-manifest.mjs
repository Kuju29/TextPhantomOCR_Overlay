// Checks the platform manifests before a build: every referenced file exists,
// the content scripts load in dependency order, and the version is single-sourced.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(projectRoot, "src");

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

const base = await json(path.join(projectRoot, "platform/base.json"));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// --- version is single-sourced in platform/base.json -----------------------
{
  const pkg = await json(path.join(projectRoot, "package.json"));
  const parts = String(base.version).split(".").filter(Boolean);
  const expected = parts.length > 3
    ? `${parts.slice(0, 3).join(".")}-${parts.slice(3).join(".")}`
    : parts.join(".");
  check(
    pkg.version === expected,
    `package.json version ${pkg.version} does not match platform/base.json ${base.version} (expected ${expected}); run npm run build to sync`,
  );
}

// --- every content script exists, in the order the page needs --------------
const contentScripts = base.content_scripts?.[0]?.js || [];
check(contentScripts.length > 0, "base.json declares no content scripts");
for (const file of contentScripts) {
  check(await isFile(path.join(sourceRoot, file)), `content script missing: ${file}`);
}

const order = new Map(contentScripts.map((file, index) => [file, index]));
const mustPrecede = [
  ["shared/compat.js", "content/namespace.js"],
  ["content/namespace.js", "content/dom-utils.js"],
  ["content/dom-utils.js", "content/overlay.js"],
  ["content/target-key.js", "content/overlay.js"],
  ["content/image-finder.js", "content/overlay.js"],
  ["content/erase-canvas.js", "content/overlay.js"],
  ["content/overlay.js", "content/mangadex.js"],
  ["content/overlay.js", "content/messaging.js"],
  ["content/messaging.js", "content/index.js"],
];
for (const [first, second] of mustPrecede) {
  const a = order.get(first);
  const b = order.get(second);
  check(
    Number.isInteger(a) && Number.isInteger(b) && a < b,
    `${first} must load before ${second}`,
  );
}

// --- the page-side scheduler helpers must exist before overlay uses them ---
{
  const domUtils = await readFile(path.join(sourceRoot, "content/dom-utils.js"), "utf8");
  for (const name of ["onNextFrame", "nextFrame"]) {
    check(domUtils.includes(name), `dom-utils.js must export ${name} for hidden-tab scheduling`);
  }
  const overlay = await readFile(path.join(sourceRoot, "content/overlay.js"), "utf8");
  check(
    !/requestAnimationFrame/.test(overlay),
    "overlay.js must schedule through TP.onNextFrame, not requestAnimationFrame directly",
  );
  check(
    overlay.includes("resetForNavigation"),
    "overlay.js must expose resetForNavigation for client-side route changes",
  );
}

// --- web-accessible resources ----------------------------------------------
for (const rule of base.web_accessible_resources || []) {
  for (const pattern of rule.resources || []) {
    if (pattern.includes("*")) continue;
    check(await isFile(path.join(sourceRoot, pattern)), `web_accessible_resources missing: ${pattern}`);
  }
}

// --- per-platform overlays --------------------------------------------------
for (const [platform, expectations] of Object.entries({
  chromium: { serviceWorker: true, forbid: ["menus", "messagesRead", "scripting"] },
  firefox: { serviceWorker: false, forbid: ["messagesRead", "scripting"] },
  thunderbird: { serviceWorker: false, require: ["menus", "messagesRead", "scripting"] },
})) {
  const overlay = await json(path.join(projectRoot, `platform/${platform}.json`));
  const permissions = new Set(overlay.permissions || []);
  if (expectations.serviceWorker) {
    check(Boolean(overlay.background?.service_worker), `${platform}: service_worker missing`);
    check(!overlay.background?.scripts, `${platform}: background.scripts is forbidden`);
    check(
      await isFile(path.join(sourceRoot, overlay.background.service_worker)),
      `${platform}: service worker file missing`,
    );
  } else {
    check(Boolean(overlay.background?.scripts?.length), `${platform}: background.scripts missing`);
    check(!overlay.background?.service_worker, `${platform}: service_worker is forbidden`);
    for (const file of overlay.background?.scripts || []) {
      check(await isFile(path.join(sourceRoot, file)), `${platform}: background script ${file} missing`);
    }
  }
  for (const permission of expectations.forbid || []) {
    check(!permissions.has(permission), `${platform}: ${permission} is forbidden`);
  }
  for (const permission of expectations.require || []) {
    check(permissions.has(permission), `${platform}: ${permission} is required`);
  }
  const popup = overlay.action?.default_popup || overlay.message_display_action?.default_popup;
  if (popup) check(await isFile(path.join(sourceRoot, popup)), `${platform}: popup ${popup} missing`);
}

assert.deepEqual(failures, [], `manifest problems:\n- ${failures.join("\n- ")}`);
console.log(`Manifest test passed: version ${base.version}, ${contentScripts.length} content scripts in order.`);
