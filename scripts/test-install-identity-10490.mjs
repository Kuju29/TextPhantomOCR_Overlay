// 10490: the shared API limits work per browser install (X-TP-Install).
// * every request that does work carries the install id (never traced),
// * an install 429 waits its Retry-After (bounded) and retries, then explains,
// * shared-API cookie Logins (Gemini/DeepSeek) read "Own API only",
// * an inline data: image is sent once (src dropped) and images above the
//   API's 24 MiB cap fail in the browser with an image-size error.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const INSTALL = "ab".repeat(16);
const store = { tpInstallIdV1: INSTALL };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "2026.test" }), sendMessage: () => Promise.resolve() },
  storage: {
    local: {
      get: (keys, cb) => {
        const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || store);
        const out = Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
        cb ? cb(out) : null;
        return Promise.resolve(out);
      },
      set: (value, cb) => { Object.assign(store, value); cb?.(); return Promise.resolve(); },
    },
  },
};

let checks = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); checks++; console.log("PASS " + name); }
  catch (error) { failures.push(name); console.log("FAIL " + name + "\n" + (error?.stack || error)); }
}

const requests = [];
let respond = () => ({ ok: true });
globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), method: init.method || "GET", headers: new Headers(init.headers), body: init.body };
  requests.push(record);
  const answer = await respond(record);
  if (answer instanceof Response) return answer;
  return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
};
const json429 = (seconds, code = "identity_rate_limited") => new Response(JSON.stringify({ detail: {
  schema: "tp.error/1", code, message: "Too many translation requests from this browser; retry shortly.",
  origin: "client", stage: "ingress_quota", category: "admission", retryable: true, httpStatus: 429,
  retryAfterSeconds: seconds } }), { status: 429, headers: { "content-type": "application/json", "Retry-After": String(seconds) } });

const { installReady, installHeader, isInstallRateLimited, installRetryDelayMs, INSTALL_RETRY_MAX_MS,
  resetInstallHeaderForTest } = await import("../src/background/transports/install-header.js");
const { fetchLensRawViaRest } = await import("../src/background/transports/lens.js");
const { groupParagraphsViaRest } = await import("../src/background/transports/groups.js");
const { translateViaSyncRest, submitJobViaRest, wirePayload } = await import("../src/background/transports/translate.js");
const { cancelJobsViaRest } = await import("../src/background/transports/cancel.js");
const { pollJobViaRest } = await import("../src/background/transports/polling.js");
const { pendingByJob } = await import("../src/background/job-registry.js");
const { translateViaServer } = await import("../src/background/ai/transports/server.js");
const { repairRequest } = await import("../src/background/repair/client.js");
const { fetchJson } = await import("../src/popup/api.js");
const { userMessageForCode } = await import("../src/shared/error-contract.js");
const { MAX_API_IMAGE_BYTES } = await import("../src/shared/constants.js");
const { fetchImageDataUriFromUrl } = await import("../src/background/images.js");
const { UI_TEXT } = await import("../src/shared/ui-text.js");

const common = { jobId: "job-1", imageId: "img-1", batchId: "batch-1", traceId: "trace-1" };
const base = "https://api.test";
const DATA = "data:image/png;base64," + "A".repeat(400);

await test("install id is read once per service-worker start and cached", async () => {
  resetInstallHeaderForTest();
  assert.deepEqual(installHeader(), {}, "nothing before the first read");
  assert.equal(await installReady(), INSTALL);
  assert.deepEqual(installHeader(), { "X-TP-Install": INSTALL });
  store.tpInstallIdV1 = "cd".repeat(16);
  assert.equal(await installReady(), INSTALL, "cached for this worker start");
  store.tpInstallIdV1 = INSTALL;
});

await test("every work request carries X-TP-Install (Lens, groups, translate, AI, repair, poll, cancel, popup resolve)", async () => {
  resetInstallHeaderForTest(); // the first request of a fresh worker must already carry it
  requests.length = 0;
  respond = (r) => {
    if (r.url.includes("/lens/raw")) return { lens: {} };
    if (r.url.includes("/ai/translate") || r.url.includes("/tasks/"))
      return { schema: "tp.ai.result/1", translations: [{ id: "p0", text: "แปล" }], missing: [] };
    if (new URL(r.url).pathname === "/translate" && r.method === "POST") return { id: "job-9" };
    if (r.url.endsWith("/translate/poll")) return { jobs: [{ id: "job-9", status: "done", result: { ok: true } }] };
    return { ok: true };
  };
  await fetchLensRawViaRest(base, { imageBytes: new Uint8Array([1]), mime: "image/png", lang: "th", ...common });
  await groupParagraphsViaRest(base, { imageDataUri: DATA, tree: {}, context: {}, ...common });
  await translateViaSyncRest(base, { metadata: {} }, common);
  await submitJobViaRest(base, { metadata: {}, context: {} });
  const traced = [];
  await translateViaServer([{ id: "p0", text: "text" }], { ai: { prompt: "style" }, base, targetLang: "th",
    sourceLang: "en", operationId: "op-1", ...common,
    wireTrace: async (event, data) => { if (event === "providerRequest") traced.push(data.headers); } });
  await repairRequest({ base, id: "run-1", token: "tok", sessionId: "s", batchId: "b" }, "register", { runId: "run-1" });
  store.customApiUrl = base; // cancel resolves the configured API itself
  await cancelJobsViaRest({ jobIds: ["job-9"] });
  pendingByJob.set("job-9", { sessionId: "" });
  await pollJobViaRest(base, "job-9", { session: "" }).catch(() => {});
  pendingByJob.delete("job-9");
  await fetchJson(`${base}/ai/resolve`, { provider: "openai" }, 2000);
  const work = requests.filter((r) => r.method === "POST");
  const paths = work.map((r) => new URL(r.url).pathname);
  for (const path of ["/v1/lens/raw", "/v2/engine/runsextension/groups", "/v1/translate", "/translate",
    "/v1/ai/translate", "/v2/engine/runsextension/repair-runs", "/translate/cancel", "/translate/poll", "/ai/resolve"])
    assert(paths.includes(path), "request sent: " + path);
  for (const r of work) assert.equal(r.headers.get("X-TP-Install"), INSTALL, "install header on " + r.url);
  assert.equal(traced.length, 1, "wire trace recorded the request");
  assert.equal(Object.keys(traced[0]).some((k) => k.toLowerCase() === "x-tp-install"), false,
    "the install id is never written to the wire trace");
});

await test("an install 429 is typed with Retry-After on Lens, sync translate and AI routes", async () => {
  respond = () => json429(7);
  const lens = await fetchLensRawViaRest(base, { imageBytes: new Uint8Array([1]), mime: "image/png", ...common }).catch((e) => e);
  assert.equal(isInstallRateLimited(lens), true);
  assert.equal(lens.retryAfterMs, 7000);
  const sync = await translateViaSyncRest(base, { metadata: {} }, common).catch((e) => e);
  assert.equal(isInstallRateLimited(sync), true);
  assert.equal(sync.retryAfterMs, 7000);
  const ai = await translateViaServer([{ id: "p0", text: "t" }], { ai: {}, base, targetLang: "th", operationId: "op-2", ...common }).catch((e) => e);
  assert.equal(isInstallRateLimited(ai), true);
  assert.equal(ai.retryAfterMs, 7000);
  assert.equal(Number(ai.generationAttempts || 0), 0, "nothing was generated");
  assert.equal(isInstallRateLimited({ status: 429, code: "provider_rate_limited" }), false, "a provider 429 is not an install limit");
});

await test("install retry delays are bounded (1 s .. 60 s)", () => {
  assert.equal(installRetryDelayMs({ retryAfterMs: 0 }), 1000);
  assert.equal(installRetryDelayMs({ retryAfterMs: 250 }), 1000);
  assert.equal(installRetryDelayMs({ retryAfterMs: 7000 }), 7000);
  assert.equal(installRetryDelayMs({ retryAfterMs: 3_600_000 }), INSTALL_RETRY_MAX_MS);
  for (const path of ["src/background/jobs.js", "src/background/pipeline/server-translation.js",
    "src/background/ai/translation-paths/request-slot.js"])
    assert.match(read(path), /INSTALL_RETRY_BUDGET_MS/, path + " bounds the total wait");
});

await test("AI request slot waits an install 429 and sends the same operation again", async () => {
  const { withRequestSlot } = await import("../src/background/ai/translation-paths/request-slot.js");
  const payload = { mode: "lens_text", source: "ai", engine: "extension", ai: { provider: "openai", model: "gpt-x", base_url: "" } };
  let calls = 0;
  const started = Date.now();
  const answer = await withRequestSlot({ payload, unitCount: 1 }, null, async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("Text-only AI failed: HTTP 429"),
      { status: 429, code: "identity_rate_limited", retryAfterMs: 1000, generationAttempts: 0 });
    return { ok: true };
  });
  assert.deepEqual(answer, { ok: true });
  assert.equal(calls, 2);
  assert(Date.now() - started >= 900, "waited the server's Retry-After before sending again");
  const busy = await withRequestSlot({ payload, unitCount: 1 }, null, async () => {
    throw Object.assign(new Error("dispatched"), { status: 429, code: "identity_rate_limited", requestDispatched: true });
  }).catch((e) => e);
  assert.equal(busy.code, "identity_rate_limited", "a dispatched request is never resent");
});

await test("repair control calls retry an install 429 at most twice, then surface it", async () => {
  let n = 0;
  respond = () => (++n === 1 ? json429(1) : { ok: true });
  assert.deepEqual(await repairRequest({ base, id: "r", token: "t" }, "seal", {}), { ok: true });
  assert.equal(n, 2);
  n = 0;
  respond = () => { n++; return json429(1); };
  const error = await repairRequest({ base, id: "r", token: "t" }, "seal", {}).catch((e) => e);
  assert.equal(n, 3, "one try + two bounded retries");
  assert.equal(error.code, "identity_rate_limited");
  assert.equal(error.retryAfterMs, 1000);
  n = 0;
  respond = () => { n++; return json429(1, "repair_identity_capacity"); };
  assert.equal((await repairRequest({ base, id: "r", token: "t" }, "", { runId: "r" }).catch((e) => e)).code, "repair_identity_capacity");
  assert.equal(n, 1, "a pool share limit is not retried");
});

await test("popup resolve: one short Retry-After wait, otherwise a typed 429", async () => {
  let n = 0;
  respond = () => (++n === 1 ? json429(1) : { ok: true, models: [] });
  assert.deepEqual(await fetchJson(`${base}/ai/resolve`, { model: "m" }, 5000), { ok: true, models: [] });
  assert.equal(n, 2);
  n = 0;
  respond = () => { n++; return json429(30); };
  const error = await fetchJson(`${base}/ai/resolve`, { model: "m" }, 5000).catch((e) => e);
  assert.equal(n, 1, "a long Retry-After is not waited inside the popup request");
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 30000);
  // 10491: selecting a Manual model sends no generation probe at all.
  assert.doesNotMatch(read("src/popup/controllers/provider-meta-controller.js"), /AI_PROBE|probe_busy/);
});

await test("install quota errors have Thai user messages", () => {
  for (const code of ["identity_rate_limited", "ai_conversation_identity_capacity", "repair_identity_capacity"]) {
    const text = userMessageForCode(code);
    assert.match(text, /[฀-๿]/, code);
    assert.notEqual(text, userMessageForCode("definitely_unknown_code"), code);
  }
});

await test("shared-API cookie Logins read 'Own API only' with the shared-API explanation", async () => {
  const { createLoginServiceController } = await import("../src/popup/controllers/login-service-controller.js");
  const element = () => ({ value: "", textContent: "", style: {}, children: [], disabled: false, dataset: {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    replaceChildren(...children) { this.children = children; } });
  globalThis.document = { createElement: element };
  const message = "Not available on this shared API: this Login would send your website session cookies to a server other people use. Use your own local or self-hosted API.";
  for (const provider of ["login_gemini", "login_deepseek"]) {
    const els = Object.fromEntries(["aiPaidSource", "aiPaidSourceWrap", "aiPaidTpModel", "aiLoginPanel", "aiLoginProvider", "aiLoginModel",
      "aiLoginModelWrap", "aiLoginAccount", "aiLoginStatus", "aiLoginConnect", "aiLoginRefresh", "aiLoginLogout", "aiLoginCancel"].map((k) => [k, element()]));
    const state = {}, apiBase = "https://shared.test", token = "fixture";
    const storage = { paidTranslationSource: "login", loginProvider: provider, loginModel: "", paidApiBase: apiBase, paidSessionToken: token };
    const account = { addons: { entitlements: [{ code: "ai_login", status: "active" }] } };
    const providers = [
      { id: "login_claude", name: "Claude", available: true, supported: true, reason: "" },
      { id: "login_gemini", name: "Gemini", available: false, supported: true, reason: "disabled",
        disabled_reason: "shared_deployment_cookie_session", message: "server text" },
      { id: "login_deepseek", name: "DeepSeek", available: false, supported: true, reason: "disabled",
        disabled_reason: "shared_deployment_cookie_session", message: "server text" },
      { id: "login_chatgpt", name: "ChatGPT", available: false, supported: true, reason: "disabled", disabled_reason: "operator_disabled" },
    ];
    const controller = createLoginServiceController({ els, state, getStorage: async () => ({ ...storage }),
      setStorage: async (patch) => Object.assign(storage, patch), readAuth: async () => ({}), writeAuth: async () => {}, toggleUi() {},
      request: async () => ({ providers }) });
    await controller.initialize(storage, { apiBase, token, account });
    controller.sync({ active: true, account, accountVerified: true, apiBase, token });
    for (let i = 0; i < 100 && !(els.aiLoginStatus.textContent && !/Checking/.test(els.aiLoginStatus.textContent)); i++)
      await new Promise((r) => setTimeout(r, 2));
    const labels = Object.fromEntries(els.aiLoginProvider.children.map((o) => [o.value, o.textContent]));
    assert.equal(labels.login_gemini, "Gemini · Own API only");
    assert.equal(labels.login_deepseek, "DeepSeek · Own API only");
    assert.equal(labels.login_chatgpt, "ChatGPT · Disabled", "other disabled reasons keep their label");
    assert.equal(els.aiLoginStatus.textContent, message, provider);
    assert.equal(els.aiLoginConnect.disabled, true, "sign-in is unavailable");
    controller.dispose();
  }
  for (const name of ["ChatGPT", "Gemini", "Claude", "DeepSeek"]) assert(UI_TEXT.has(name + " · Own API only"), name);
  assert(UI_TEXT.has(message));
});

await test("an inline data: image is sent once: src dropped only when identical to imageDataUri", async () => {
  assert.deepEqual(wirePayload({ src: DATA, imageDataUri: DATA, mode: "m" }), { imageDataUri: DATA, mode: "m" });
  const url = { src: "https://img.test/p.png", imageDataUri: DATA };
  assert.equal(wirePayload(url), url, "an http(s) src stays (page identity, server fallback)");
  const other = { src: "data:image/png;base64,QQ==", imageDataUri: DATA };
  assert.equal(wirePayload(other), other, "a different data: src stays");
  const only = { src: DATA };
  assert.equal(wirePayload(only), only, "src is the only image: it stays");
  respond = (r) => (r.url.endsWith("/translate") ? { id: "j" } : { ok: true });
  requests.length = 0;
  const payload = { src: DATA, imageDataUri: DATA, metadata: {}, context: {} };
  await submitJobViaRest(base, payload);
  await translateViaSyncRest(base, payload, common);
  for (const r of requests) {
    const body = JSON.parse(r.body);
    assert.equal("src" in body, false, r.url);
    assert.equal(body.imageDataUri, DATA, r.url);
  }
  assert.equal(payload.src, DATA, "the caller's payload is not modified");
  assert.match(read("api/backend/jobs/stages/payload_io.py"), /if payload\.get\("imageDataUri"\):\s*\n\s*return (?:data_uri_to_bytes|_inline_bytes)\(payload\["imageDataUri"\]\)/,
    "the API reads imageDataUri before src");
});

await test("images above the API's 24 MiB cap fail in the browser with an image-size error", async () => {
  assert.equal(MAX_API_IMAGE_BYTES, 24 * 1024 * 1024);
  const sized = (n) => new Response(new Uint8Array(n), { status: 200, headers: { "content-type": "image/png" } });
  respond = () => sized(MAX_API_IMAGE_BYTES + 1);
  await assert.rejects(fetchImageDataUriFromUrl("https://img.test/big.png", ""), /Image too large/);
  respond = () => sized(4096);
  assert.match(await fetchImageDataUriFromUrl("https://img.test/ok.png", ""), /^data:image\/png;base64,/);
  assert.match(userMessageForCode("IMG_TOO_LARGE"), /24 MiB/);
  for (const path of ["src/content/messaging.js", "src/content/sites/kagane/page-bridge.js", "src/background/image-composition.js"]) {
    const source = read(path);
    assert.match(source, /24 ?\* ?1024 ?\* ?1024/, path);
    assert.doesNotMatch(source, /25 ?\* ?1024 ?\* ?1024/, path);
  }
  assert.doesNotMatch(read("src/content/reader/runtime.js"), /36\*1024\*1024/);
  assert.match(read("src/auto/auto.js"), /blob\.size > MAX_API_IMAGE_BYTES/);
});

console.log(JSON.stringify({ suite: "install-identity-10490", passed: checks, failed: failures }));
if (failures.length) process.exit(1);
