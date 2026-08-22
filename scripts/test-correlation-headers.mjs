import assert from "node:assert/strict";

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "2026.test" }) },
  storage: { local: { get: (_keys, cb) => cb({}), set: (_value, cb) => cb?.() } },
};

const { fetchLensRawViaRest, groupParagraphsViaRest, translateViaSyncRest } =
  await import("../src/background/transport.js");
const { translateUnits } = await import("../src/background/ai-local.js");

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), headers: new Headers(init.headers), body: init.body };
  requests.push(record);
  let body = { ok: true };
  if (record.url.endsWith("/v1/lens/raw")) body = { lens: {} };
  if (record.url.endsWith("/v1/ai/translate")) {
    body = { schema: "tp.ai.result/1", translations: [{ id: "p0", text: "แปล" }], missing: [] };
  }
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
};

const common = { jobId: "job-1", imageId: "img-1", batchId: "batch-1" };
await fetchLensRawViaRest("https://api.test", {
  imageBytes: new Uint8Array([1]), mime: "image/png", lang: "th", ...common,
});
await groupParagraphsViaRest("https://api.test", {
  imageDataUri: "data:image/png;base64,AQ==", tree: {}, context: {}, ...common,
});
await translateViaSyncRest("https://api.test", { metadata: {} }, { ...common });
await translateUnits([{ id: "p0", text: "text" }], {
  route: "server", ai: {}, base: "https://api.test", targetLang: "th",
  sourceLang: "en", operationId: "operation-1", ...common,
});

assert.equal(requests.length, 4);
const requestIds = new Set();
for (const request of requests) {
  assert.equal(request.headers.get("X-TP-Job-Id"), "job-1");
  assert.equal(request.headers.get("X-TP-Image-Id"), "img-1");
  assert.equal(request.headers.get("X-TP-Batch-Id"), "batch-1");
  assert.equal(request.headers.get("X-TP-Client-Version"), "2026.test");
  const requestId = request.headers.get("X-TP-Request-Id");
  assert.ok(requestId, "every HTTP attempt needs a request id");
  requestIds.add(requestId);
}
assert.equal(requestIds.size, requests.length, "request ids must be unique per HTTP attempt");

console.log("Correlation header test passed: all split/full endpoints carry optional stable IDs.");
