import assert from "node:assert/strict";
import { createApiAvailabilityGate } from "../src/popup/controllers/api-availability-gate.js";

const control = (disabled = false) => ({
  disabled, attrs: {},
  setAttribute(key, value) { this.attrs[key] = value; },
  removeAttribute(key) { delete this.attrs[key]; },
});
const panel = (...controls) => ({ querySelectorAll: () => controls });
const banner = () => ({ hidden: true, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });
const button = () => ({
  handlers: {},
  addEventListener(type, fn) { this.handlers[type] = fn; },
  click() { this.handlers.click?.(); },
});

let intervalCallback = null;
let intervalStarts = 0;
let intervalStops = 0;
let checks = 0;
let toolsClicks = 0;
const translate = control();
const alreadyDisabled = control(true);
const ai = control();
const translateOpen = button();
const aiOpen = button();
const gate = createApiAvailabilityGate({
  els: {
    translatePanel: panel(translate, alreadyDisabled, translateOpen),
    aiPanel: panel(ai, aiOpen),
    apiGateTranslate: banner(), apiGateAi: banner(),
    apiGateTranslateOpen: translateOpen, apiGateAiOpen: aiOpen,
    tabTools: { click: () => toolsClicks++ },
  },
  checkApi: () => checks++,
  setIntervalFn: (fn) => { intervalStarts++; intervalCallback = fn; return 7; },
  clearIntervalFn: () => { intervalStops++; intervalCallback = null; },
  now: () => 100000,
});

assert.equal(gate.snapshot().state, "unknown");
assert.equal(translate.disabled, false);
gate.failure();
assert.equal(gate.snapshot().state, "suspect");
assert.equal(translate.disabled, false);
gate.failure();
assert.equal(gate.snapshot().state, "offline");
assert.equal(translate.disabled, true);
assert.equal(ai.disabled, true);
assert.equal(intervalStarts, 1);
intervalCallback();
assert.equal(checks, 1);
gate.success();
assert.equal(gate.snapshot().state, "online");
assert.equal(translate.disabled, false);
assert.equal(ai.disabled, false);
assert.equal(alreadyDisabled.disabled, true);
assert.equal(intervalStops, 1);

gate.failure();
assert.equal(gate.snapshot().state, "online");
assert.equal(translate.disabled, false);
gate.success();
assert.equal(gate.acceptSnapshot({ ok: false, ts: 1, base: "api" }, "api"), false);
assert.equal(gate.snapshot().consecutiveFailures, 0);
assert.equal(gate.acceptSnapshot({ ok: false, ts: 99990, base: "api" }, "api"), false);
assert.equal(gate.snapshot().consecutiveFailures, 1);
gate.success();
translateOpen.click();
aiOpen.click();
assert.equal(toolsClicks, 2);
gate.failure({ definitive: true });
assert.equal(gate.snapshot().state, "offline");

console.log("Popup API availability gate passed: cache-first, hysteresis, offline recovery, navigation, state restoration.");
