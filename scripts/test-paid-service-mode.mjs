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
  "aiPaidLogin", "aiPaidAccount", "aiPageImageWrap", "aiPaidStatus", "aiPaidUnavailable",
  "aiPaidEmail", "aiPaidCode", "aiPaidSend", "aiPaidCheck", "aiPaidVerify", "aiPaidEmailLabel",
  "aiPaidCredits", "aiPaidModel", "aiPaidRefresh", "aiPaidLogout",
].map(name => [name, element()]));
els.mode.value = "lens_text";
els.sources.value = "ai";
els.apiUrl.value = "http://127.0.0.1:7860";
els.aiPaidEmail.value = "person@gmail.com";
let storage = { tpDataConsentV1: { version: 1, granted: true, at: 1 } }, updates = 0; // 10495: this user allowed data use
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
  ensureConsent: async () => ({ consent: true, shown: false }), // 10494: this user allowed account data
});
await controller.initialize();
assert.equal(els.aiServiceWrap.style.display, "none", "No Center means old controls only");
assert.equal(els.aiProviderWrap.style.display, "");
controller.setAvailability(true, "http://127.0.0.1:7860");
assert.equal(els.aiServiceWrap.style.display, "none", "An unsaved field without a stored default cannot select a Paid API");
state.apiDefaults = { defaultApiUrl: els.apiUrl.value };
state.lastSavedApiUrl = "";
controller.setAvailability(true, "http://127.0.0.1:7860");
assert.equal(els.aiServiceWrap.style.display, "", "The saved managed default supports Paid with no custom override");
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
assert.match(els.aiPaidCredits.textContent, /8,000 TP/);
controller.setAvailability(false, "http://127.0.0.1:7860");
assert.equal(storage.aiServiceMode, "paid", "Paid choice remains explicit while Center is unavailable");
assert.equal(els.aiService.value, "paid");
assert.equal(els.aiServiceWrap.style.display, "", "Recovery keeps the Manual switch visible");
assert.equal(els.aiPaidPanel.style.display, "", "A saved Paid selection keeps its sign-in panel");
assert.equal(els.aiPaidUnavailable.style.display, "");
assert.equal(state.paidReady, false);
assert.match(els.aiPaidUnavailable.textContent, /choose Manual/i);
assert.ok(!els.aiPaidUnavailable.textContent.includes('TP_CENTER_URL'));
controller.setAvailability(true, "http://127.0.0.1:7860");
await settle();
assert.equal(requests.at(-1).options.headers.Authorization, "Bearer customer-session");
const beforeSwitch = requests.length;
els.apiUrl.value = "http://127.0.0.1:7999";
state.lastSavedApiUrl = els.apiUrl.value;
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
storage.aiServiceMode = "paid";
els.apiUrl.value = "";
state.lastSavedApiUrl = "";
controller.setAvailability(false, "");
// 10495: each account request first asks the account gate (one storage read), so the
// sign-out's own status check lands a few ticks later; let it settle before counting.
for (let i = 0; i < 5; i++) await settle();
const beforeRestore = requests.length;
await controller.initialize();
assert.equal(storage.aiServiceMode, "paid", "a saved Paid profile stays owned by the user");
assert.equal(els.aiServiceWrap.style.display, "", "Saved Paid users can switch to Manual even without a URL");
assert.equal(els.aiPaidPanel.style.display, "", "Show recovery, but do not send to an unverified URL");
assert.equal(els.aiPaidUnavailable.style.display, "", "the user sees a separate recovery notice");
assert.equal(requests.length, beforeRestore, "restoring Paid without an API URL must not contact the Center");
controller.dispose();
const { resolveJobAiProfile } = await import("../src/background/ai-profile-resolver.js");
const { PAID_PROFILE_KEY, putPaidEntry } = await import("../src/shared/paid-profile.js");
// 10495: the resolver reads the signed-in session from storage through the account gate.
const signedIn = {};
globalThis.chrome = { storage: { local: { get(_keys, callback) {
  callback({ customApiUrl: "http://127.0.0.1:7999", apiDefaultsFetchedAt: Date.now(), tpDataConsentV1: { version: 1, granted: true, at: 1 }, ...signedIn });
} } } };
const resolvePaid = (settings, ...rest) => { Object.assign(signedIn, { paidSessionToken: settings.paidSessionToken, paidApiBase: settings.paidApiBase }); return resolveJobAiProfile(settings, ...rest); };
globalThis.fetch = async (url) => ({ ok: true, json: async () => String(url).endsWith("/paid/me") ? ({paid_paused:false, models:[{id:"qa/test"}]}) : ({ paid: { available: true } }) });
await assert.rejects(() => resolvePaid({ aiServiceMode: "paid",
  paidSessionToken: "old-session", paidModel: "qa/test",
  paidApiBase: "http://localhost:7860" }), error => error.code === "PAID_LOGIN_REQUIRED");
const paidProfile = await resolvePaid({ aiServiceMode: "paid",
  paidSessionToken: "valid-customer-session", paidModel: "qa/test",
  paidApiBase: "http://localhost:7999", aiTranslationMode: "independent", aiThinking: "high",
  [PAID_PROFILE_KEY]: putPaidEntry({}, "http://localhost:7999", "qa/test", {profile:{thinking:"off"},prompts:{}}) });
assert.equal(paidProfile.settings.aiThinking, "off", "Paid preserves intent; Center verifies whether Off is executable before billing");
assert.equal(paidProfile.settings.aiTranslationMode, "conversation", "Paid keeps the cloud Conversation policy");
assert.equal(paidProfile.settings.aiKey, "valid-customer-session", "Only the customer session goes to the API");
assert.deepEqual(paidProfile.settings.aiModelCapabilities, {}, "Manual model metadata cannot prove Paid controls");
const freshProfile = await resolvePaid({ aiServiceMode: "paid",
  paidSessionToken: "valid-customer-session", paidModel: "qa/test",
  paidApiBase: "http://localhost:7999", aiThinking: "off" });
assert.equal(freshProfile.settings.aiThinking, "minimum", "An unseen Paid model uses Lowest, independently of flat Manual settings");
globalThis.fetch = async () => ({ ok: true, json: async () => ({ paid: { available: false } }) });
await assert.rejects(() => resolvePaid({ aiServiceMode: "paid",
  paidSessionToken: "old-session", paidModel: "qa/test",
  paidApiBase: "http://localhost:7999" }), error => error.code === "PAID_CENTER_UNAVAILABLE" && /Select Manual/.test(error.message));
console.log("Conditional Paid/Manual UI and OTP account flow passed.");
