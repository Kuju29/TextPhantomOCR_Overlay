import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [popup, font, picker, series, rate, local, health, providerMeta, hydration, persistence, events, usageView, capacity, popupUi] = await Promise.all([
  read("../src/popup/popup.js"), read("../src/popup/controllers/font-scale-controller.js"),
  read("../src/popup/controllers/local-picker-controller.js"), read("../src/popup/controllers/series-memory-controller.js"),
  read("../src/popup/controllers/rate-settings-controller.js"), read("../src/popup/controllers/local-connection-controller.js"),
  read("../src/popup/controllers/api-health-controller.js"),
  read("../src/popup/controllers/provider-meta-controller.js"),
  read("../src/popup/controllers/settings-hydration-controller.js"),
  read("../src/popup/controllers/settings-persistence-controller.js"),
  read("../src/popup/controllers/popup-event-controller.js"),
  read("../src/popup/controllers/usage-view-controller.js"),
  read("../src/popup/controllers/local-capacity-controller.js"),
  read("../src/popup/controllers/popup-ui-controller.js"),
]);
for (const symbol of ["saveFontScale", "openLocalViewerFromFiles", "refreshSeriesMemory", "saveRateNumber", "setLocalConnectBusy", "scheduleHealthRetry"]) {
  assert.doesNotMatch(popup, new RegExp(`function\\s+${symbol}\\b`), `${symbol} must not return to popup.js`);
}
assert.match(font, /FONT_SCALE_CHANGED/);
assert.match(picker, /saveLocalSession/);
assert.match(series, /resolveSeriesKey/);
assert.match(rate, /rateBurst/);
assert.match(local, /TP_LOCAL_AI_DISCOVER/);
assert.match(local, /sequence !== state\.localConnectSeq/);
assert.doesNotMatch(local, /fetch\s*\(/);
assert.match(health, /checkHealthOnce/);
assert.match(health, /sequence !== state\.healthSeq/);
assert.match(providerMeta, /AI_RESOLVE/);
assert.match(providerMeta, /AI_PROBE/);
assert.match(providerMeta, /sequence !== state\.aiMetaSeq/);
assert.doesNotMatch(popup, /function refreshAiMeta|function probeSelectedModel|function renderAiVerificationMessages/);
assert.ok(popup.split(/\r?\n/).length < 400, "popup.js must remain composition-only");
assert.match(hydration, /loadPopupSettings/);
assert.match(persistence, /scheduleSaveApi/);
assert.match(events, /export function bindPopupEvents/);
assert.match(events, /\bcanUseAiUi,/, "popup events must receive canUseAiUi as an explicit dependency");
assert.match(events, /\brefreshSeriesMemory,/, "popup events must receive refreshSeriesMemory as an explicit dependency");
assert.doesNotMatch(events, /seriesMemoryController\./, "popup events must not reach into the composition root's controller instance");
assert.match(popup, /\bcanUseAiUi,\s*\n\s*validateAiKey:/, "popup composition must inject canUseAiUi into popup events");
assert.match(popup, /refreshSeriesMemory:\s*seriesMemoryController\.refresh/, "popup composition must inject the series-memory refresh callback");
assert.match(usageView, /const renderHistory/);
assert.match(capacity, /aiLocalCapabilityHint/);
assert.match(popupUi, /ai\.provider_transition/);
assert.doesNotMatch(popup, /function renderLocalCapacityHint|function traceProviderTransition/);
assert.doesNotMatch(events, /fetch\s*\(/);
console.log("Popup controller boundaries passed: UI capabilities have unique owners and explicit dependencies.");
