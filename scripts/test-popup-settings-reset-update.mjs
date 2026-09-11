import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { SETTINGS_RESET_KEYS, createResetDefaultsController } from "../src/popup/controllers/reset-defaults-controller.js";
import { compareVersions, createUpdateBannerController } from "../src/popup/controllers/update-banner-controller.js";

const eventButton = () => ({ disabled: false, addEventListener(_type, callback) { this.click = callback; } });

{
  const removed = [];
  const order = [];
  let reloads = 0;
  const els = { resetDefaults: eventButton(), resetDefaultsStatus: { textContent: "" } };
  const controller = createResetDefaultsController({
    els, remove: async (keys) => { order.push("remove"); removed.push(...keys); },
    resetLive: async () => { order.push("live"); }, confirmReset: () => true,
    reload: () => { reloads += 1; },
  });
  controller.bind();
  await els.resetDefaults.click();
  assert.equal(reloads, 1);
  assert.deepEqual(order, ["live", "remove"]);
  assert.deepEqual(removed, SETTINGS_RESET_KEYS);
  for (const preserved of ["aiUsageLedgerV1", "aiProfilePromptHistoryV1", "aiPromptHistory",
    "tpTranslationRunsV1", "aiSeriesMemory", "tpTraceRecordsV1"])
    assert.equal(removed.includes(preserved), false, `${preserved} must be preserved`);
  assert.equal(removed.includes("aiProfilesV1"), true);
  assert.equal(removed.includes("rateLimitEnabled"), true);
  assert.equal(removed.includes("aiConcurrencyLearningV1"), true);
}

assert.equal(compareVersions("2026.9.9.2", "2026.9.10.0"), -1);
assert.equal(compareVersions("2026.9.10", "2026.9.9.99"), 1);
assert.equal(compareVersions("2026.9.9.2", "2026.9.9.2"), 0);
assert.equal(compareVersions("bad", "2026.9.9.2"), null);

const schedulerStorage = {};
globalThis.chrome = {
  runtime: { lastError: null },
  storage: { local: {
    get(defaults, callback) { callback({ ...defaults, ...schedulerStorage }); },
    set(patch, callback) { Object.assign(schedulerStorage, patch); callback?.(); },
  } },
};
const { acquire, describe, releaseSuccess, resetAdaptiveLearning, setLaneCapacityHint } =
  await import("../src/background/scheduler.js");

setLaneCapacityHint("ai:test:model:key", 8);
assert.equal(describe("ai:test:model:key")?.capacityHint, 8);
resetAdaptiveLearning();
assert.equal(describe("ai:test:model:key"), null, "live scheduler lanes must be forgotten");

const staleKey = "ai:stale:model:key";
await acquire(staleKey);
resetAdaptiveLearning();
assert.equal(describe(staleKey)?.running, 1, "active translation must be allowed to finish");
releaseSuccess(staleKey, 250);
await Promise.resolve();
assert.equal(describe(staleKey), null, "late pre-reset release resurrected its lane");
assert.equal(schedulerStorage.aiConcurrencyLearningV1, undefined,
  "late pre-reset release repopulated adaptive learning storage");

{
  const banner = { hidden: true, href: "", textContent: "" };
  const controller = createUpdateBannerController({
    els: { updateBanner: banner },
    getDefaults: async () => ({ latestVersion: "2026.9.10.0", updateUrl: "https://example.com/update" }),
    getCurrentVersion: () => "2026.9.9.2",
  });
  assert.equal(await controller.refresh(), true);
  assert.equal(banner.hidden, false);
  assert.equal(banner.href, "https://example.com/update");
  assert.match(banner.textContent, /2026\.9\.10\.0/);
}

for (const defaults of [{},
  { latestVersion: "2026.9.9.2", updateUrl: "https://example.com/update" },
  { latestVersion: "2026.9.10.0", updateUrl: "http://example.com/update" }]) {
  const banner = { hidden: false, href: "", textContent: "" };
  const controller = createUpdateBannerController({
    els: { updateBanner: banner }, getDefaults: async () => defaults,
    getCurrentVersion: () => "2026.9.9.2",
  });
  assert.equal(await controller.refresh(), false);
  assert.equal(banner.hidden, true);
}

const popupHtml = await readFile(new URL("../src/popup/popup.html", import.meta.url), "utf8");
const popupJs = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
const backgroundJs = await readFile(new URL("../src/background/index.js", import.meta.url), "utf8");
const schedulerJs = await readFile(new URL("../src/background/scheduler.js", import.meta.url), "utf8");
assert.doesNotMatch(popupHtml, /Translation session \/ Repair|translation-session-panel/);
assert.doesNotMatch(popupJs, /mountTranslationSessionStatus/);
assert.match(popupHtml, />Set prompt</);
assert.match(popupHtml, /id="reset-defaults"/);
assert.match(popupHtml, /id="update-banner"/);
assert.match(popupJs, /TP_RESET_ADAPTIVE_SCHEDULER/);
assert.match(backgroundJs, /case "TP_RESET_ADAPTIVE_SCHEDULER"/);
assert.match(backgroundJs, /resetAdaptiveLearning\(\)/);
assert.match(schedulerJs, /export function resetAdaptiveLearning/);

console.log("Popup reset, update banner, concise UI and Set prompt contract passed.");
