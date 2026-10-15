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
const delays = [];
let checks = 0;
let toolsClicks = 0;
const translate = control();
const alreadyDisabled = control(true);
const ai = control();
const paidSelect = control(), paidRetry = control(), paidLogout = control();
const translateOpen = button();
const aiOpen = button();
const gate = createApiAvailabilityGate({
  els: {
    translatePanel: panel(translate, alreadyDisabled, translateOpen),
    aiPanel: panel(ai, aiOpen, paidSelect, paidRetry, paidLogout),
    aiService: paidSelect, aiPaidCheck: paidRetry, aiPaidLogout: paidLogout,
    apiGateTranslate: banner(), apiGateAi: banner(),
    apiGateTranslateOpen: translateOpen, apiGateAiOpen: aiOpen,
    tabTools: { click: () => toolsClicks++ },
  },
  checkApi: () => checks++,
  // 10490: bounded one-shot retries (5, 15, 30, then 60 s) instead of a 5 s interval.
  setTimeoutFn: (fn, ms) => { intervalStarts++; delays.push(ms); intervalCallback = fn; return 7; },
  clearTimeoutFn: () => { intervalStops++; intervalCallback = null; },
  events: null,
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
assert.equal(paidSelect.disabled, false, "Offline API cannot trap a saved Paid choice");
assert.equal(paidRetry.disabled, false, "Retry must stay usable while API is offline");
assert.equal(paidLogout.disabled, false, "Local sign-out must stay usable while API is offline");
assert.equal(intervalStarts, 1);
intervalCallback();
await Promise.resolve(); await Promise.resolve();
assert.equal(checks, 1);
gate.failure();
assert.equal(gate.snapshot().state, "offline");
assert.deepEqual(delays, [5000, 15000], "second retry waits longer");
gate.success();
assert.equal(gate.snapshot().state, "online");
assert.equal(translate.disabled, false);
assert.equal(ai.disabled, false);
assert.equal(alreadyDisabled.disabled, true);
assert.equal(intervalStops, 1, "success cancels the scheduled retry");

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
