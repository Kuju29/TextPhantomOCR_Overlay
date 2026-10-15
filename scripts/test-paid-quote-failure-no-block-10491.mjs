// 10491: a saved Paid quote failure is display only. Translate still goes to
// Center (its admission refuses before AI/charge); the real result replaces
// the saved state; the popup asks again once on open/visible, the change
// token, a changed catalogue, a model change or a translation result — no
// timer. PAID_PROVIDER_CAPACITY is transient and no longer fences a run.
// Synthetic local API/Center only; no AI, payment or customer state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
globalThis.crypto ||= webcrypto;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };

// ---------------------------------------------------------------- background
const store = {};
globalThis.chrome = { runtime: { getManifest: () => ({ version: "test" }) }, storage: { local: {
  get(keys, cb) { const list = Array.isArray(keys) ? keys : [keys];
    cb(Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]))); },
  set(values, cb) { Object.assign(store, structuredClone(values)); cb?.(); },
} } };
const { translateViaServer } = await import("../src/background/ai/transports/server.js");
const { PAID_ROUTE_OUTCOME_KEY } = await import("../src/shared/paid-route-outcome.js");
const { isProviderBillingFailure, providerBillingFenceCode, userMessageForCode } = await import("../src/shared/error-contract.js");
const A = "http://localhost:7860", MODEL = "fixture/paid-model";
let sent = 0;
const translate = (reply) => {
  globalThis.fetch = async () => { sent++; return reply(); };
  return translateViaServer([{ id: "P0", text: "Hello" }], { base: A, targetLang: "th", sourceLang: "en",
    operationId: crypto.randomUUID(), ai: { provider: "paid", model: MODEL, api_key: "synthetic-session", prompt: "S", thinking: "minimum" } });
};
const ok = () => new Response(JSON.stringify({ schema: "tp.ai.result/1", translations: [{ id: "P0", text: "สวัสดี" }],
  missing: [], meta: { resolvedProvider: "paid", resolvedModel: MODEL, generationAttempts: 1, providerAttempts: 1 } }), { status: 200 });
const refused = (status, code, extra = {}) => () => new Response(JSON.stringify({ detail: { code, message: "fixture",
  userMessage: `Center: ${code}`, origin: "control_center", httpStatus: status, providerAttempts: 0, generationAttempts: 0,
  requestDispatched: false, ...extra } }), { status });

await test("a saved popup quote failure never stops the background: Translate is sent and Center decides", async () => {
  store.paidAccountViewCacheV1 = { me: { models: [{ id: MODEL, route_quote_failure: { code: "PAID_ROUTE_UNAVAILABLE", context: "a".repeat(64) } }] } };
  sent = 0;
  assert.ok(await translate(ok)); assert.equal(sent, 1);
  for (const path of ["src/background/ai-profile-resolver.js", "src/background/ai/transports/server.js", "src/background/context-menu.js"])
    assert.doesNotMatch(read(path), /route_quote_failure|route_price_sync|paidAccountViewCache/, path);
  const popup = read("src/popup/controllers/paid-service-controller.js");
  const ready = popup.slice(popup.indexOf("state.paidReady = Boolean(available"), popup.indexOf("if (loginSelection.source === \"login\") state.paidReady"));
  assert.doesNotMatch(ready, /route_price_sync|route_quote_failure/, "quote state never gates Paid readiness");
});

await test("the real result replaces the saved state: refusal saved with Center's message, success clears it", async () => {
  for (const key of Object.keys(store)) delete store[key];
  sent = 0;
  const error = await translate(refused(503, "paid_route_unavailable")).catch((e) => e);
  assert.equal(error.code, "paid_route_unavailable"); assert.equal(sent, 1);
  assert.deepEqual({ ...store[PAID_ROUTE_OUTCOME_KEY], at: 0 },
    { base: A, model: MODEL, code: "PAID_ROUTE_UNAVAILABLE", message: "Center: paid_route_unavailable", at: 0 });
  await translate(ok);
  assert.equal(store[PAID_ROUTE_OUTCOME_KEY].code, "", "success clears the saved refusal");
  const before = structuredClone(store[PAID_ROUTE_OUTCOME_KEY]);
  await translate(ok);
  assert.deepEqual(store[PAID_ROUTE_OUTCOME_KEY], before, "an ordinary success writes nothing");
  await translate(refused(503, "paid_provider_capacity", { upstreamStatus: 402, requestDispatched: true })).catch(() => {});
  await translate(refused(429, "paid_rate_limited")).catch(() => {});
  assert.deepEqual(store[PAID_ROUTE_OUTCOME_KEY], before, "transient refusals say nothing about the route");
  await translate(refused(400, "paid_thinking_unsupported")).catch(() => {});
  assert.equal(store[PAID_ROUTE_OUTCOME_KEY].code, "PAID_THINKING_UNSUPPORTED", "capability mismatch is still saved");
});

await test("PAID_PROVIDER_CAPACITY is transient: it never fences a run; real billing stops still do", async () => {
  const capacity = { code: "paid_provider_capacity", status: 503, upstreamStatus: 402, requestDispatched: true };
  assert.equal(isProviderBillingFailure(capacity), false);
  assert.equal(isProviderBillingFailure({ ...capacity, tpError: { code: "PAID_PROVIDER_CAPACITY", upstreamStatus: 402 } }), false);
  for (const code of ["paid_provider_key_limit", "paid_provider_balance", "paid_insufficient_credits", "billing_required"])
    assert.equal(isProviderBillingFailure({ code, upstreamStatus: 402 }), true, code);
  assert.notEqual(providerBillingFenceCode("paid", capacity), "paid_provider_capacity");
  assert.match(userMessageForCode("paid_provider_capacity"), /ชั่วคราว/);
  // Center evidence the decision rests on: in-flight budget, "wait, then retry".
  const center = read("../TextPhantom-Control-Center/api/backend/paid/customer/provider_errors.py");
  assert.match(center, /openrouter_in_flight_budget"[\s\S]{0,80}"PAID_PROVIDER_CAPACITY"[\s\S]{0,200}wait_for_shared_workload/);
});

// --------------------------------------------------------------------- popup
const { popupEntryFixture } = await import("./lib/popup-entry-fixture.mjs");
const unavailable = { status: "unavailable", unit: "TP_PER_1000_TOKENS", input_tp: null, output_tp: null, basis: "paired_endpoint_metadata" };
const price = (i, o, basis) => ({ status: "estimated", unit: "TP_PER_1000_TOKENS", input_tp: String(i), output_tp: String(o), model_revision: 2, policy_revision: 1, ...(basis ? { basis } : {}) });
const IDS = [MODEL, "fixture/other-model"];
// The popup does real crypto/storage work: wait on the observable, not on turn counts.
async function until(popup, predicate, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await popup.settle(20); await new Promise((r) => setTimeout(r, 5)); }
  return predicate();
}
async function quiet(popup) { await popup.settle(60); await new Promise((r) => setTimeout(r, 250)); await popup.settle(60); }
function environment() {
  let status = 503, code = "PAID_ROUTE_UNAVAILABLE", clock = Date.now();
  let rows = IDS.map((id, i) => ({ id, name: `Model ${i}`, eligible_tp: "1250", max_output: 8192, catalogue_pricing: price(2 + i, 4 + i),
    pricing: unavailable, price_sync: { automatic: true, status: "current", checked_at: 1700000000 },
    route_price_sync: { status: "unavailable", account_policy_verified: false } }));
  const local = { mode: "lens_text", sources: "ai", lang: "th", customApiUrl: A, apiUrlDefault: A, apiDefaultsFetchedAt: Date.now(),
    aiServiceMode: "paid", paidTranslationSource: "tp", paidSessionToken: "synthetic-a", paidApiBase: A, paidServiceApiBase: A, paidModel: MODEL };
  const requests = [];
  const reply = async (url, options = {}) => {
    const parsed = new URL(url), path = parsed.pathname;
    requests.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/meta") return Response.json({ ok: true, paid: { available: true, configured: true } });
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/paid/me") return Response.json({ email: "a@example.test", credits: { available: "1250", held: "0" },
      price_quote_available: true, models: structuredClone(rows), addons: { entitlements: [] } });
    if (path === "/paid/price-quote") return status === 200
      ? Response.json({ pricing: { ...price(80, 90, "paired_endpoint_metadata") }, route: { basis: "paired_endpoint_metadata", checked_at: 1700000001, revision: 3 } })
      : Response.json({ error: { code, message: "Synthetic selected route unavailable" } }, { status });
    if (path === "/paid/auth/status") return Response.json({ available: true, registration_enabled: true });
    return Response.json({});
  };
  return { local, requests, quotes: () => requests.filter((r) => r.path === "/paid/price-quote").length,
    set status(v) { status = v; }, set rows(v) { rows = v; }, get rows() { return rows; }, advance(ms = 601000) { clock += ms; },
    now: () => clock, open: () => popupEntryFixture({ local, session: {}, fetchReply: reply, now: () => clock, manualTimers: true }) };
}

await test("popup asks a saved failure again once on open, on visible and on the change token — never on a timer", async () => {
  const env = environment();
  const first = await env.open(); await until(first, () => env.quotes() >= 1); await quiet(first);
  assert.equal(first.errors.length, 0, first.errors.join("\n"));
  assert.equal(env.quotes(), 1, JSON.stringify(env.requests.map((r) => r.path)));
  assert.match(first.fields.get("ai-paid-status").textContent, /No priced route/);
  first.close(); env.advance();
  const popup = await env.open();
  try {
    await until(popup, () => env.quotes() >= 2); await quiet(popup); assert.equal(env.quotes(), 2, "reopen asks once");
    env.advance(); popup.runDueTimers(); await until(popup, () => env.quotes() >= 2); await quiet(popup); assert.equal(env.quotes(), 2, "no timer asks again");
    popup.setVisibility("hidden"); env.advance(); popup.setVisibility("visible"); await until(popup, () => env.quotes() >= 3); await quiet(popup); assert.equal(env.quotes(), 3, "becoming visible asks once " + JSON.stringify(env.requests.slice(-6).map((r) => r.path)));
    env.advance(5000);
    await popup.writeLocal({ tpChangeTokensV1: { scope: "s", tokens: { b: "aaaaaa", prices: "bbbbbb" }, changed: ["prices"], seq: 7, at: env.now() } });
    await until(popup, () => env.quotes() >= 4); await quiet(popup); assert.equal(env.quotes(), 4, "the prices change token asks once");
    // A non-forcing re-read (profile prompt edit) keeps the saved failure when
    // the catalogue is unchanged, and asks again when Center's catalogue changed.
    const key = JSON.stringify([A, MODEL]);
    env.advance(5000);
    await popup.writeLocal({ paidAiProfilesV1: { version: 1, entries: { [key]: { profile: { thinking: "minimum", pageImage: "off" }, prompts: { th: { text: "one" } } } } } });
    await until(popup, () => env.quotes() >= 4); await quiet(popup); assert.equal(env.quotes(), 4, "unchanged catalogue reuses the saved failure");
    const rows = env.rows; rows[1].catalogue_pricing = price(9, 9); env.rows = rows; env.advance(5000);
    await popup.writeLocal({ paidAiProfilesV1: { version: 1, entries: { [key]: { profile: { thinking: "minimum", pageImage: "off" }, prompts: { th: { text: "two" } } } } } });
    await until(popup, () => env.quotes() >= 5); await quiet(popup); assert.equal(env.quotes(), 5, "a changed Center catalogue asks once " + JSON.stringify(env.requests.slice(-5).map((r) => r.path)));
  } finally { popup.close(); }
});

await test("popup applies the translation result: Center's refusal message, then success re-asks and clears", async () => {
  const env = environment();
  const popup = await env.open();
  try {
    await until(popup, () => env.quotes() >= 1); await quiet(popup); assert.equal(env.quotes(), 1);
    await popup.writeLocal({ [PAID_ROUTE_OUTCOME_KEY]: { base: A, model: MODEL, code: "PAID_IMAGE_UNSUPPORTED", message: "Center refused page images", at: 1 } });
    await until(popup, () => env.quotes() >= 1); await quiet(popup); assert.equal(env.quotes(), 1, "a refusal from the real request needs no extra quote");
    assert.match(popup.fields.get("ai-paid-status").textContent, /Center refused page images/);
    env.status = 200;
    await popup.writeLocal({ [PAID_ROUTE_OUTCOME_KEY]: { base: A, model: MODEL, code: "", message: "", at: 2 } });
    await until(popup, () => env.quotes() >= 2); await quiet(popup); assert.equal(env.quotes(), 2, "success clears the saved failure with one fresh quote");
    assert.doesNotMatch(popup.fields.get("ai-paid-status").textContent, /Center refused|No priced route/);
    assert.equal(popup.fields.get("ai-paid-model-input").textContent, "≈ 80 TP");
    // Another model's outcome does not touch this selection.
    await popup.writeLocal({ [PAID_ROUTE_OUTCOME_KEY]: { base: A, model: IDS[1], code: "PAID_ROUTE_UNAVAILABLE", message: "x", at: 3 } });
    await quiet(popup);
    assert.doesNotMatch(popup.fields.get("ai-paid-status").textContent, /\bx\b|No priced route/);
  } finally { popup.close(); }
});

console.log(JSON.stringify({ suite: "paid-quote-failure-no-block-10491", passed: checks }));
