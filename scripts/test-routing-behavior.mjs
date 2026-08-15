// Executes the routing decisions and HTTP calls that protect the engine boundary.
// This is deliberately behavioural: it imports the production functions, invokes
// them with concurrent jobs, and observes the requests rather than searching text.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.chrome = {
  storage: { local: { get: (_keys, cb) => cb({}), set: (_v, cb) => cb?.() } },
};

const { engineCompatibilityIssue } = await import("../src/background/capabilities.js");

const legacy = { syncTranslate: false, reason: "HTTP 404" };
const modern = { syncTranslate: true };
assert.match(
  engineCompatibilityIssue({ engine: "extension", mode: "lens_text" }, legacy),
  /stopped; it was not sent to the legacy full-server pipeline/i,
  "extension lens_text must stop when only the legacy full pipeline is available",
);
assert.equal(
  engineCompatibilityIssue({ engine: "extension", mode: "lens_text" }, modern), "",
  "extension lens_text may use a server with the split synchronous path",
);
assert.equal(
  engineCompatibilityIssue({ engine: "api", mode: "lens_text" }, legacy), "",
  "the explicitly selected API engine may use the legacy full pipeline",
);
assert.equal(
  engineCompatibilityIssue({ engine: "extension", mode: "lens_images" }, legacy), "",
  "lens_images keeps its legacy server route",
);

// The first incompatible job must be observable. Assert the production router
// establishes the trace and stores its correlated context before probing, then
// enables tracing from that probe before it emits the stop event.
const jobsSource = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
const traceCreatedAt = jobsSource.indexOf("traceId = newTraceId()");
const contextStoredAt = jobsSource.indexOf("pendingByImage.set(payload.metadata.image_id, makeContext())");
const capsAt = jobsSource.indexOf("const caps = await getCapabilities(base)");
const tracingAt = jobsSource.indexOf("setTracingEnabled(", capsAt);
const issueAt = jobsSource.indexOf("const compatibilityIssue = engineCompatibilityIssue", capsAt);
const stopAt = jobsSource.indexOf('traceNote("background/jobs.js", "engineRoute"', issueAt);
assert.ok(
  traceCreatedAt > 0 && traceCreatedAt < contextStoredAt && contextStoredAt < capsAt &&
    capsAt < tracingAt && tracingAt < issueAt && issueAt < stopAt,
  "first-job order must be trace -> registry context -> capabilities -> tracing enabled -> stop event",
);

const requests = [];
let releaseFirst;
const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
globalThis.fetch = async (url, init = {}) => {
  const record = { url: String(url), headers: new Headers(init.headers) };
  requests.push(record);
  // Hold the first request open while the second is created. A module-global
  // unlimited flag would allow the second job to alter the first job's policy.
  if (requests.length === 1) await firstHeld;
  const body = record.url.endsWith("/translate") && !record.url.endsWith("/v1/translate")
    ? { id: "legacy-job" }
    : record.url.endsWith("/v1/lens/raw")
      ? { lens: { ok: true } }
      : { ok: true };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const {
  fetchLensRawViaRest,
  groupParagraphsViaRest,
  groupParagraphsWithArtifactFallback,
  submitJobViaRest,
  translateViaSyncRest,
} = await import("../src/background/transport.js");
const bytes = new Uint8Array([1, 2, 3]);
const unlimited = fetchLensRawViaRest("http://localhost:7860", {
  imageBytes: bytes, mime: "image/png", lang: "en", apiUnlimited: true,
});
await new Promise((resolve) => setTimeout(resolve, 0));
const paced = fetchLensRawViaRest("http://localhost:7860", {
  imageBytes: bytes, mime: "image/png", lang: "en", apiUnlimited: false,
});
await new Promise((resolve) => setTimeout(resolve, 0));
releaseFirst();
await Promise.all([unlimited, paced]);

assert.equal(requests.length, 2);
assert.equal(requests[0].headers.get("X-TP-Local-Unlimited"), "1");
assert.equal(
  requests[1].headers.get("X-TP-Local-Unlimited"), null,
  "a concurrent paced job must not inherit the unlimited header",
);

requests.length = 0;
await fetchLensRawViaRest("https://api.example.test", {
  imageBytes: bytes, mime: "image/png", lang: "en", apiUnlimited: true,
});
assert.equal(
  requests[0].headers.get("X-TP-Local-Unlimited"), null,
  "the unlimited override must never be sent to a non-local API",
);

// Exercise every processing endpoint with all three policies. These calls use
// the real transport functions, so they also catch a call site that forgets to
// pass the per-job policy into limitHeaders().
const cases = [
  ["http://localhost:7860", true, "1"],
  ["http://localhost:7860", false, null],
  ["https://api.example.test", true, null],
];
const assertPolicies = async (name, invoke) => {
  for (const [base, enabled, expected] of cases) {
    requests.length = 0;
    await invoke(base, enabled);
    assert.equal(requests.length, 1, `${name} must make exactly one request`);
    assert.equal(
      requests[0].headers.get("X-TP-Local-Unlimited"), expected,
      `${name} policy mismatch for base=${base}, enabled=${enabled}`,
    );
  }
};

await assertPolicies("/v1/groups", (base, apiUnlimited) => groupParagraphsViaRest(base, {
  imageDataUri: "data:image/png;base64,AQ==", tree: {}, context: {}, apiUnlimited,
}));
await assertPolicies("/v1/translate", (base, apiUnlimited) => translateViaSyncRest(base, {
  mode: "lens_text", limits: { apiUnlimited }, context: {},
}));
await assertPolicies("legacy /translate", (base, apiUnlimited) => submitJobViaRest(base, {
  mode: "lens_images", limits: { apiUnlimited }, context: {},
}));

// Extension groups uses the short-lived Lens artifact without resending the
// image. Only an explicit artifact 410 may retry exactly once with legacy bytes.
const artifactRequests = [];
let artifactReplies = [];
globalThis.fetch = async (url, init = {}) => {
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  artifactRequests.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
  const reply = artifactReplies.shift() || { status: 200, body: { ok: true } };
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
};
const artifactOptions = {
  imageArtifactToken: "art-1",
  imageDataUri: "data:image/png;base64,AQ==",
  tree: { paragraphs: [] },
  context: { tp_tab_session: "s1" },
};
artifactReplies = [{ status: 200, body: { ok: true } }];
await groupParagraphsWithArtifactFallback("http://localhost:7860", artifactOptions);
assert.equal(artifactRequests.length, 1);
assert.equal(artifactRequests[0].url.endsWith("/v1/groups"), true);
assert.equal(artifactRequests[0].body.imageArtifactToken, "art-1");
assert.equal("imageDataUri" in artifactRequests[0].body, false, "token request must not resend pixels");

artifactRequests.length = 0;
artifactReplies = [
  { status: 410, body: { detail: { code: "artifact_expired" } } },
  { status: 200, body: { ok: true } },
];
await groupParagraphsWithArtifactFallback("http://localhost:7860", artifactOptions);
assert.equal(artifactRequests.length, 2, "explicit artifact expiry retries exactly once");
assert.equal(artifactRequests.every((r) => r.url.endsWith("/v1/groups")), true);
assert.equal(artifactRequests[1].body.imageDataUri, artifactOptions.imageDataUri);
assert.equal("imageArtifactToken" in artifactRequests[1].body, false);

artifactRequests.length = 0;
const cancelledBetweenAttempts = new AbortController();
globalThis.fetch = async (url, init = {}) => {
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  artifactRequests.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
  cancelledBetweenAttempts.abort();
  return new Response(JSON.stringify({ detail: { code: "artifact_expired" } }), {
    status: 410, headers: { "content-type": "application/json" },
  });
};
await assert.rejects(
  groupParagraphsWithArtifactFallback("http://localhost:7860", {
    ...artifactOptions, signal: cancelledBetweenAttempts.signal,
  }),
  (error) => error.name === "AbortError",
);
assert.equal(artifactRequests.length, 1, "navigation between attempts prevents the legacy resend");

globalThis.fetch = async (url, init = {}) => {
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  artifactRequests.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
  const reply = artifactReplies.shift() || { status: 200, body: { ok: true } };
  return new Response(JSON.stringify(reply.body), {
    status: reply.status, headers: { "content-type": "application/json" },
  });
};

for (const [status, code] of [[400, "artifact_expired"], [403, "artifact_unavailable"], [410, "artifact_wrong_scope"]]) {
  artifactRequests.length = 0;
  artifactReplies = [{ status, body: { detail: { code } } }];
  await assert.rejects(
    groupParagraphsWithArtifactFallback("http://localhost:7860", artifactOptions),
    (error) => error.status === status && error.code === code,
  );
  assert.equal(artifactRequests.length, 1, `${status}/${code} must not resend pixels`);
}

artifactRequests.length = 0;
artifactReplies = [{ status: 200, body: { ok: true } }];
await groupParagraphsWithArtifactFallback("http://localhost:7860", {
  ...artifactOptions, imageArtifactToken: "",
});
assert.equal(artifactRequests.length, 1, "old API/data-only path remains one request");
assert.equal(artifactRequests[0].body.imageDataUri, artifactOptions.imageDataUri);

artifactRequests.length = 0;
const aborted = new AbortController();
aborted.abort();
await assert.rejects(
  groupParagraphsWithArtifactFallback("http://localhost:7860", { ...artifactOptions, signal: aborted.signal }),
  (error) => error.name === "AbortError",
);
assert.equal(artifactRequests.length, 0, "cancelled work must not attempt token or byte requests");

console.log("Routing behavior test passed: engine boundary and per-request policy on all processing endpoints.");
