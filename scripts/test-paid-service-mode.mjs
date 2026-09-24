import assert from "node:assert/strict";
import { createPaidServiceController } from "../src/popup/controllers/paid-service-controller.js";

const element = (value = "") => ({ value, textContent: "", style: { display: "" },
  disabled: false, listeners: {},
  addEventListener(name, fn) { this.listeners[name] = fn; },
  replaceChildren(...children) { this.children = children; },
});
globalThis.document = { createElement: () => element() };
const els = Object.fromEntries([
  "mode", "sources", "apiUrl", "aiService", "aiServiceWrap", "aiPaidPanel",
  "aiProviderWrap", "aiKeyWrap", "aiModelWrap", "aiEndpointWrap",
  "aiPaidLogin", "aiPaidAccount", "aiPageImageWrap", "aiPaidStatus",
  "aiPaidEmail", "aiPaidCode", "aiPaidSend", "aiPaidCheck", "aiPaidVerify", "aiPaidEmailLabel",
  "aiPaidCredits", "aiPaidModel", "aiPaidRefresh", "aiPaidLogout",
].map(name => [name, element()]));
els.mode.value = "lens_text";
els.sources.value = "ai";
els.apiUrl.value = "http://127.0.0.1:7860";
els.aiPaidEmail.value = "person@gmail.com";
let storage = {}, updates = 0;
const state = {};
const requests = [];
let otpStatus = "disabled";
const settle = () => new Promise(resolve => setImmediate(resolve));
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const data = url.endsWith("/paid/auth/status") ? {
    available: otpStatus === "ready", code: otpStatus === "ready" ? "READY" :
      otpStatus === "email" ? "EMAIL_NOT_CONFIGURED" : "OTP_DISABLED",
    message: otpStatus === "ready" ? "ระบบพร้อมส่งรหัส" :
      otpStatus === "email" ? "ระบบอีเมลยังไม่พร้อม" : "ยังไม่เปิด OTP",
  } : url.endsWith("/paid/auth/request") ? { ok: true } :
    url.endsWith("/paid/auth/verify") ? { token: "customer-session" } :
    url.endsWith("/paid/me") ? { email: "person@gmail.com",
      credits: { available: "8000", held: "0" }, paid_paused: false,
      models: [{ id: "qa/test", name: "QA Text", eligible_tp: "8000" }],
      checkout_available: false } : { ok: true };
  return { ok: true, json: async () => data };
};
const controller = createPaidServiceController({ els, state,
  getStorage: async keys => Object.fromEntries(keys.map(key => [key, storage[key]])),
  setStorage: async patch => { storage = { ...storage, ...patch }; },
  toggleUi: () => { updates++; controller.applyVisibility(); },
});
await controller.initialize();
assert.equal(els.aiServiceWrap.style.display, "none", "No Center means old controls only");
assert.equal(els.aiProviderWrap.style.display, "");
controller.setAvailability(true, "http://127.0.0.1:7860");
assert.equal(els.aiServiceWrap.style.display, "");
els.aiService.value = "paid";
await els.aiService.listeners.change();
await settle();
assert.equal(storage.aiServiceMode, "paid");
assert.equal(els.aiProviderWrap.style.display, "none");
assert.equal(els.aiKeyWrap.style.display, "none");
assert.equal(els.aiModelWrap.style.display, "none");
assert.equal(state.paidReady, false);
assert.equal(els.aiPaidSend.disabled, true);
assert.match(els.aiPaidStatus.textContent, /ยังไม่เปิด OTP/);
const blocked = requests.length;
await els.aiPaidSend.listeners.click();
assert.equal(requests.length, blocked, "Disabled OTP must not request a code");
otpStatus = "email";
els.aiPaidCheck.listeners.click();
await settle();
assert.equal(els.aiPaidSend.disabled, true);
assert.match(els.aiPaidStatus.textContent, /อีเมลยังไม่พร้อม/);
otpStatus = "ready";
els.aiPaidCheck.listeners.click();
await settle();
assert.equal(els.aiPaidSend.disabled, false);
await els.aiPaidSend.listeners.click();
els.aiPaidCode.value = "123456";
await els.aiPaidVerify.listeners.click();
assert.equal(storage.paidSessionToken, "customer-session");
assert.equal(storage.paidApiBase, "http://localhost:7860");
assert.equal(storage.paidModel, "qa/test");
assert.equal(state.paidReady, true);
assert.match(els.aiPaidCredits.textContent, /8000 TP/);
assert.equal(requests.at(-1).options.headers.Authorization, "Bearer customer-session");
const beforeSwitch = requests.length;
controller.setAvailability(true, "http://127.0.0.1:7999");
assert.equal(storage.paidSessionToken, "", "A new API must not receive the old Center token");
assert.equal(state.paidReady, false);
assert.ok(requests.slice(beforeSwitch).every(item => !item.options.headers.Authorization),
  "Switching APIs must not forward the previous session");
await els.aiPaidLogout.listeners.click();
assert.equal(storage.paidSessionToken, "");
assert.equal(state.paidReady, false);
els.aiService.value = "manual";
await els.aiService.listeners.change();
assert.equal(storage.aiServiceMode, "manual");
assert.equal(state.paidActive, false);
assert.ok(updates > 0);
const { resolveJobAiProfile } = await import("../src/background/ai-profile-resolver.js");
globalThis.chrome = { storage: { local: { get(_keys, callback) {
  callback({ customApiUrl: "http://127.0.0.1:7999", apiDefaultsFetchedAt: Date.now() });
} } } };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ paid: { available: true } }) });
await assert.rejects(() => resolveJobAiProfile({ aiServiceMode: "paid",
  paidSessionToken: "old-session", paidModel: "qa/test",
  paidApiBase: "http://localhost:7860" }), error => error.code === "PAID_LOGIN_REQUIRED");
console.log("Conditional Paid/Manual UI and OTP account flow passed.");
