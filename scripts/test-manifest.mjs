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
for (const file of (base.content_scripts || []).flatMap(group => group.js || [])) {
  check(await isFile(path.join(sourceRoot, file)), `content script missing: ${file}`);
}

const order = new Map(contentScripts.map((file, index) => [file, index]));
const mustPrecede = [
  ["shared/compat.js", "content/namespace.js"],
  ["content/namespace.js", "content/dom-utils.js"],
  ["content/dom-utils.js", "content/progress-panel.js"],
  ["content/progress-panel.js", "content/messaging.js"],
  ["content/dom-utils.js", "content/overlay.js"],
  ["content/target-key.js", "content/overlay.js"],
  ["content/image-finder.js", "content/overlay.js"],
  ["content/erase-canvas.js", "content/overlay.js"],
  ["content/sites/mangadex/adapter.js", "content/mangadex.js"],
  ["content/sites/mangadex/adapter.js", "content/sites/mangadex/collector.js"],
  ["content/sites/mangadex/collector.js", "content/mangadex.js"],
  ["content/overlay.js", "content/mangadex.js"],
  ["content/overlay.js", "content/messaging.js"],
  ["content/messaging.js", "content/index.js"],
  ["content/reader/sources.js", "content/reader/classification.js"],
  ["content/reader/classification.js", "content/reader/runtime.js"],
  ["content/reader/runtime.js", "content/messaging.js"],
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
  const overlay = await readFile(path.join(sourceRoot, "content/overlay/mount.js"), "utf8");
  check(
    !/requestAnimationFrame/.test(overlay),
    "overlay mount must schedule through TP.onNextFrame, not requestAnimationFrame directly",
  );
  check(
    overlay.includes("resetForNavigation"),
    "overlay mount must expose resetForNavigation for client-side route changes",
  );
}

// --- web-accessible resources ----------------------------------------------
for (const rule of base.web_accessible_resources || []) {
  for (const pattern of rule.resources || []) {
    if (pattern.includes("*")) continue;
    check(await isFile(path.join(sourceRoot, pattern)), `web_accessible_resources missing: ${pattern}`);
  }
}
// The in-page support dock frames support/chat.html on every site. Chromium
// (Chrome/Edge/Opera) serves it only through the per-session dynamic URL so a
// page cannot probe chrome-extension://<id>/support/chat.html to detect the
// extension. Firefox/Thunderbird do not support use_dynamic_url (MDN BCD:
// version_added false) and already use a random per-install moz-extension UUID,
// so they keep the base rules. The Chromium overlay must otherwise equal base.
{
  const chromium = await json(path.join(projectRoot, "platform/chromium.json"));
  const plain = rules => JSON.stringify((rules || []).map(({ use_dynamic_url, ...rule }) => rule));
  check(plain(chromium.web_accessible_resources) === plain(base.web_accessible_resources),
    "chromium web_accessible_resources must equal base apart from use_dynamic_url");
  const chat = (chromium.web_accessible_resources || []).find(rule => rule.resources?.includes("support/chat.html"));
  check(chat?.use_dynamic_url === true && chat.resources.length === 1, "chromium: support/chat.html needs its own use_dynamic_url rule");
  check(!(chromium.web_accessible_resources || []).some(rule => rule !== chat && rule.use_dynamic_url),
    "chromium: only the support frame uses a dynamic URL (content-script imports keep static URLs)");
  for (const name of ["firefox", "thunderbird"]) {
    const overlay = await json(path.join(projectRoot, `platform/${name}.json`));
    check(!JSON.stringify(overlay.web_accessible_resources || []).includes("use_dynamic_url"),
      `${name}: use_dynamic_url is not supported by Gecko`);
  }
}

// --- per-platform overlays --------------------------------------------------
for (const [platform, expectations] of Object.entries({
  chromium: { serviceWorker: true, require: ["scripting"], forbid: ["menus", "messagesRead", "sensitiveDataUpload"] },
  firefox: { serviceWorker: false, require: ["scripting"], forbid: ["messagesRead", "sensitiveDataUpload"] },
  thunderbird: { serviceWorker: false, require: ["menus", "messagesRead", "sensitiveDataUpload", "scripting"] },
})) {
  const overlay = await json(path.join(projectRoot, `platform/${platform}.json`));
  const permissions = new Set(overlay.permissions || []);
  // AMO 19.23-new-id used this stable identity. Do not generate a new ID at build time.
  if (platform === "firefox") {
    check(overlay.browser_specific_settings?.gecko?.id === "textphantom-v3@kuju29", "firefox: restore the AMO identity from 19.23-new-id (textphantom-v3@kuju29)");
  }
  if (platform === "thunderbird")
    check(overlay.browser_specific_settings?.gecko?.id === "textphantom@kuju29", "thunderbird: do not replace the ATN identity with the Firefox AMO identity");
  // 10494 (AMO policy 6): only what translation itself needs is required.
  // Account data, the Login session cookie, support messages and diagnostics
  // are optional and asked for at runtime (diagnostics: install checkbox).
  if (platform === "firefox" || platform === "thunderbird") {
    const declared = overlay.browser_specific_settings?.gecko?.data_collection_permissions || {};
    check(JSON.stringify(declared.required) === JSON.stringify(["websiteContent", "browsingActivity"]),
      `${platform}: required data collection must be exactly websiteContent, browsingActivity`);
    check(JSON.stringify([...(declared.optional || [])].sort()) === JSON.stringify(["authenticationInfo", "financialAndPaymentInfo",
      "personalCommunications", "personallyIdentifyingInfo", "technicalAndInteraction"]),
      `${platform}: optional data collection must list the account, cookie, support and diagnostics types`);
    check(Number.parseFloat(overlay.browser_specific_settings?.gecko?.strict_min_version) >= 140,
      `${platform}: built-in data consent needs strict_min_version 140`);
  } else {
    check(!overlay.browser_specific_settings, `${platform}: Gecko-only settings do not belong in this manifest`);
  }
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
