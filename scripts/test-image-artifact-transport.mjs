import assert from "node:assert/strict";

globalThis.chrome = {
  storage: { local: { get: (_keys, cb) => cb({}), set: (_value, cb) => cb?.() } },
};

const { groupParagraphsWithArtifactFallback } = await import("../src/background/transport.js");
const calls = [];
let replies = [];
globalThis.fetch = async (url, init = {}) => {
  if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
  calls.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
  const reply = replies.shift() || { status: 200, body: { ok: true } };
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json" },
  });
};

const options = {
  imageArtifactToken: "artifact-1",
  imageDataUri: "data:image/png;base64,AQ==",
  tree: { paragraphs: [] },
  context: { tp_tab_session: "session-1" },
};

replies = [{ status: 200, body: { ok: true } }];
await groupParagraphsWithArtifactFallback("http://localhost:7860", options);
assert.equal(calls.length, 1);
assert.equal(calls[0].url.endsWith("/v1/groups"), true);
assert.deepEqual(Object.keys(calls[0].body).sort(), ["context", "imageArtifactToken", "tree"]);

for (const code of ["artifact_expired", "artifact_unavailable"]) {
  calls.length = 0;
  replies = [
    { status: 410, body: { detail: { code } } },
    { status: 200, body: { ok: true } },
  ];
  await groupParagraphsWithArtifactFallback("http://localhost:7860", options);
  assert.equal(calls.length, 2, `${code} retries exactly once`);
  assert.equal(calls[0].body.imageArtifactToken, options.imageArtifactToken);
  assert.equal("imageDataUri" in calls[0].body, false);
  assert.equal(calls[1].body.imageDataUri, options.imageDataUri);
  assert.equal("imageArtifactToken" in calls[1].body, false);
}

for (const [status, code] of [
  [400, "artifact_malformed"],
  [403, "artifact_wrong_scope"],
  [500, "artifact_unavailable"],
]) {
  calls.length = 0;
  replies = [{ status, body: { detail: { code } } }];
  await assert.rejects(groupParagraphsWithArtifactFallback("http://localhost:7860", options));
  assert.equal(calls.length, 1, `${status}/${code} must not retry`);
}

calls.length = 0;
const aborted = new AbortController();
aborted.abort();
await assert.rejects(
  groupParagraphsWithArtifactFallback("http://localhost:7860", { ...options, signal: aborted.signal }),
  (error) => error.name === "AbortError",
);
assert.equal(calls.length, 0);

console.log("Image artifact transport test passed: token-first, bounded legacy retry, and abort hold.");
