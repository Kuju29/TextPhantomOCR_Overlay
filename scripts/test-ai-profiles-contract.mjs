import assert from "node:assert/strict";

// Public, dependency-free contract for the Provider + Model profile core.
// Runtime/UI tests belong elsewhere; this suite deliberately tests values,
// migration and persistence boundaries without reading implementation source.
const {
  AI_PROFILES_SCHEMA_VERSION,
  AI_PROFILE_PROVIDER_OPTIONS,
  createAiProfiles,
  makeProviderIdentity,
  makeProfilePromptKey,
  getAiProfilePrompt,
  setAiProfilePrompt,
  resetAiProfilePrompt,
  migrateAiProfiles,
  requireActiveAiProfile,
  resolveAiProfile,
  updateAiProfile,
  buildAiProfileStoragePatch,
  pruneAiProfiles,
  sanitizeAiProfileTrace,
  exportAiProfiles,
} = await import("../src/shared/ai-profiles.js");

assert.equal(AI_PROFILES_SCHEMA_VERSION, 1);
assert.ok(AI_PROFILE_PROVIDER_OPTIONS instanceof Set,
  "providerOptions must have one auditable allowlist");

// Provider identity is provider + normalized endpoint. Equivalent endpoint
// spellings must share a profile; distinct compatible servers must not.
const openRouter = makeProviderIdentity(" OpenRouter ", "HTTPS://OPENROUTER.AI/api/v1/");
assert.equal(openRouter, makeProviderIdentity("openrouter", "https://openrouter.ai/api/v1"));
assert.equal(makeProviderIdentity("openrouter", ""), makeProviderIdentity("openrouter", "default"));
assert.equal(makeProviderIdentity("openrouter", "auto"), makeProviderIdentity("openrouter", "default"));
assert.notEqual(openRouter, makeProviderIdentity("openrouter", "https://proxy.example/v1"));
assert.notEqual(
  makeProviderIdentity("customlocal", "http://127.0.0.1:1234/v1"),
  makeProviderIdentity("customlocal", "http://127.0.0.1:5678/v1"),
);
assert.throws(() => makeProviderIdentity("openrouter", "javascript:alert(1)"), /endpoint|url|protocol/i);

// Query-bearing compatible endpoints either form distinct tenant identities,
// or are rejected explicitly. Silently stripping the tenant query would make
// separate accounts share settings. Normalization must also be stable.
const tenantAUrl = "https://gateway.example/v1?tenant=alpha";
const tenantBUrl = "https://gateway.example/v1?tenant=beta";
let tenantA;
let tenantB;
let tenantPolicyError = null;
try {
  tenantA = makeProviderIdentity("customcloud", tenantAUrl);
  tenantB = makeProviderIdentity("customcloud", tenantBUrl);
} catch (error) {
  tenantPolicyError = error;
}
if (tenantPolicyError) {
  assert.ok(tenantPolicyError instanceof TypeError);
  assert.match(String(tenantPolicyError.message), /endpoint|query|tenant|url/i);
  assert.throws(() => makeProviderIdentity("customcloud", tenantBUrl), TypeError,
    "query policy must reject consistently");
} else {
  assert.notEqual(tenantA, tenantB, "different endpoint tenants must not share an identity");
  assert.equal(tenantA, makeProviderIdentity(" CUSTOMCLOUD ", "HTTPS://GATEWAY.EXAMPLE/v1?tenant=alpha"),
    "endpoint identity normalization must be stable");
}

const defaults = {
  thinking: "off",
  tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 },
  temperature: null,
  pageImage: "off",
  memoryMode: "off",
  concurrency: { mode: "auto", max: 0 },
  providerOptions: {},
};

let profiles = createAiProfiles();
assert.deepEqual(profiles, {
  version: 1,
  active: { providerIdentity: "", model: "auto" },
  providers: {},
});

// Merely discovering a model is read-only. A profile is created lazily only
// when selected/edited, and a stale model remains stored for later reuse.
const untouched = resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a",
  defaults,
});
assert.deepEqual(untouched.profile, defaults);
assert.strictEqual(untouched.state, profiles, "resolve/discovery must not create storage records");

profiles = updateAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a",
  defaults, patch: { thinking: "off", temperature: 0.2 }, select: true, now: 100,
});
assert.equal(profiles.active.providerIdentity, openRouter);
assert.equal(profiles.active.model, "model-a");
assert.equal(resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a", defaults,
}).profile.thinking, "off");

// Profile records are an allowlisted data contract too. Large unknown fields
// must not survive resolution or persistence and consume unbounded storage.
assert.throws(() => updateAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a",
  defaults, patch: { unknownBlob: "x".repeat(200_000) }, now: 350,
}), /profile|field|unsupported/i, "new writes must reject unknown fields");
const unknownStored = structuredClone(profiles);
unknownStored.providers[openRouter].models["model-a"].profile.unknownBlob = "x".repeat(200_000);
assert.throws(() => resolveAiProfile(unknownStored, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a", defaults,
}), (error) => error.code === "AI_PROFILE_INVALID",
"corrupt canonical profile fields must fail instead of being silently dropped");
assert.throws(() => pruneAiProfiles(unknownStored, { maxBytes: 1_000_000 }),
  (error) => error.code === "AI_PROFILE_INVALID");

// A new model starts from provider/safe defaults, never from the previously
// selected model. Returning to model A restores A exactly.
profiles = updateAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-b",
  defaults, patch: {}, select: true, now: 200,
});
assert.equal(resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-b", defaults,
}).profile.thinking, "off");
assert.equal(resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a", defaults,
}).profile.temperature, 0.2);

// Identical model names at another provider/endpoint are isolated.
profiles = updateAiProfile(profiles, {
  provider: "customcloud", endpoint: "https://cloud.example/v1", model: "model-a",
  defaults, patch: { thinking: "on", temperature: 0.8 }, select: false, now: 300,
});
assert.equal(resolveAiProfile(profiles, {
  provider: "customcloud", endpoint: "https://cloud.example/v1", model: "model-a", defaults,
}).profile.thinking, "on");
assert.equal(resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a", defaults,
}).profile.thinking, "off");

// Unknown provider options are rejected, rather than copied into an outbound
// provider request. Connection/credential fields can never be model options.
for (const forbidden of ["apiKey", "headers", "baseUrl", "url", "endpoint", "credentialRef", "model"]) {
  assert.throws(() => updateAiProfile(profiles, {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a",
    defaults, patch: { providerOptions: { [forbidden]: "unsafe" } }, now: 400,
  }), /providerOptions|allow|unsupported/i, forbidden);
}
const validProviderOptionValues = {
  reasoningEffort: "low",
  reasoningExclude: true,
  responseFormat: "text",
  modelCapabilities: { reasoning: { supported: true, mandatory: false,
    supports_max_tokens: true, supported_efforts: ["low", "high"] } },
  capabilityAccountHash: "0123456789abcdef",
};
assert.deepEqual([...AI_PROFILE_PROVIDER_OPTIONS].sort(), Object.keys(validProviderOptionValues).sort(),
  "the audited providerOptions allowlist changed without contract coverage");
for (const allowed of AI_PROFILE_PROVIDER_OPTIONS) {
  assert.doesNotThrow(() => updateAiProfile(profiles, {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "model-a",
    defaults, patch: { providerOptions: { [allowed]: validProviderOptionValues[allowed] } }, now: 401,
  }), allowed);
}

// Nested profile contracts are allowlisted and typed too. Unknown nested keys
// must not bypass the top-level allowlist, and provider values must use the
// exact canonical spelling expected by adapters.
const nestedWriteCases = [
  { patch: { tokenPolicy: { unknownBlob: "x" } }, label: "tokenPolicy.unknownBlob" },
  { patch: { concurrency: { evil: true } }, label: "concurrency.evil" },
  { patch: { capacity: { evil: true } }, label: "capacity.evil" },
  { patch: { providerOptions: { reasoningExclude: null } }, label: "reasoningExclude null" },
  { patch: { providerOptions: { reasoningExclude: {} } }, label: "reasoningExclude object" },
  { patch: { providerOptions: { reasoningExclude: "true" } }, label: "reasoningExclude string" },
  { patch: { providerOptions: { reasoningExclude: 1 } }, label: "reasoningExclude number" },
  { patch: { providerOptions: { reasoningEffort: "LOW" } }, label: "reasoningEffort case variant" },
  { patch: { providerOptions: { reasoningEffort: "turbo" } }, label: "reasoningEffort unsupported" },
  { patch: { providerOptions: { responseFormat: "TEXT" } }, label: "responseFormat case variant" },
  { patch: { providerOptions: { responseFormat: "xml" } }, label: "responseFormat unsupported" },
];
for (const { patch, label } of nestedWriteCases) {
  assert.throws(() => updateAiProfile(profiles, {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "nested-invalid",
    defaults, patch, now: 402,
  }), /profile|field|token|concurr|capacity|providerOptions|reasoning|response|invalid|unsupported/i, label);
}

const hugeNested = { payload: "x".repeat(250_000) };
for (const patch of [
  { tokenPolicy: { unknownBlob: hugeNested } },
  { concurrency: { evil: hugeNested } },
  { capacity: { evil: hugeNested } },
  { providerOptions: { reasoningExclude: hugeNested } },
]) {
  assert.throws(() => updateAiProfile(profiles, {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "huge-invalid",
    defaults, patch, now: 403,
  }), /profile|field|token|concurr|capacity|providerOptions|reasoning|invalid|unsupported|size/i,
  "huge nested writes must be rejected before persistence");
}

// Exact, bounded canonical values survive a write/read/normalization cycle.
profiles = updateAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "nested-valid",
  defaults,
  patch: {
    tokenPolicy: { mode: "manual", maxOutputTokens: 4096 },
    concurrency: { mode: "manual", max: 2 },
    providerOptions: { reasoningExclude: true, reasoningEffort: "low", responseFormat: "text" },
  },
  now: 404,
});
const validNestedProfile = resolveAiProfile(profiles, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "nested-valid", defaults,
}).profile;
assert.deepEqual(validNestedProfile.tokenPolicy, { mode: "manual", maxOutputTokens: 4096 });
assert.deepEqual(validNestedProfile.concurrency, { mode: "manual", max: 2 });
assert.deepEqual(validNestedProfile.providerOptions,
  { reasoningExclude: true, reasoningEffort: "low", responseFormat: "text" });

// Stored/corrupt nested data is rejected. Silent normalization hides the first
// broken contract and can make runtime behavior appear unrelated to storage.
const nestedCorrupt = structuredClone(profiles);
const corruptProfile = nestedCorrupt.providers[openRouter].models["model-a"].profile;
corruptProfile.tokenPolicy = { mode: "dynamic", maxOutputTokens: 2048, unknownBlob: hugeNested };
corruptProfile.concurrency = { mode: "auto", max: 0, evil: hugeNested };
corruptProfile.capacity = { evil: hugeNested };
corruptProfile.providerOptions = {
  reasoningExclude: hugeNested,
  reasoningEffort: "LOW",
  responseFormat: "xml",
};
assert.throws(() => pruneAiProfiles(nestedCorrupt, { maxBytes: 1_000_000 }),
  (error) => error.code === "AI_PROFILE_INVALID",
  "corrupt canonical nested values must fail at their contract boundary");

// Prompt identity includes all three dimensions and uses collision-safe
// encoding. Same language/model on separate providers cannot overwrite.
const promptA = makeProfilePromptKey(openRouter, "same/model", "th");
assert.equal(promptA, makeProfilePromptKey(openRouter, "same/model", "th"));
assert.notEqual(promptA, makeProfilePromptKey(openRouter, "same/model", "en"));
assert.notEqual(promptA, makeProfilePromptKey(
  makeProviderIdentity("customcloud", "https://cloud.example/v1"), "same/model", "th",
));
assert.notEqual(
  makeProfilePromptKey(openRouter, "a::b", "th"),
  makeProfilePromptKey(openRouter, "a", "b::th"),
  "delimiter-like user values must not collide",
);

// Flat settings migrate once into the active Provider+Model. Credentials stay
// in provider-scoped credential storage and never appear in a model profile.
const legacy = {
  aiProvider: "openrouter",
  aiBaseUrl: "https://openrouter.ai/api/v1/",
  aiModel: "deepseek/example",
  aiCloudKey: "top-secret",
  aiThinking: "off",
  aiPageImage: "always",
  aiMemoryMode: "terms",
  rateLimitEnabled: false,
  rateRpm: 30,
  rateBurst: 2,
  aiPromptByLang: { th: "Thai style" },
};
const migrated = migrateAiProfiles({ stored: undefined, legacy, now: 500 });
assert.equal(migrated.state.version, 1);
assert.equal(migrated.changed, true);
assert.equal(migrated.credentials[openRouter], "top-secret");
assert.ok(!JSON.stringify(migrated.state).includes("top-secret"));
assert.ok(!JSON.stringify(migrated.state.providers).match(/apiKey|aiCloudKey/i));
assert.deepEqual(migrated.prompts[makeProfilePromptKey(openRouter, "deepseek/example", "th")],
  { text: "Thai style", mode: "replace" });
const migratedAgain = migrateAiProfiles({
  stored: migrated.state, credentials: migrated.credentials, prompts: migrated.prompts, legacy, now: 999,
});
assert.deepEqual(migratedAgain.state, migrated.state, "migration must be idempotent");
assert.deepEqual(migratedAgain.credentials, migrated.credentials);
assert.deepEqual(migratedAgain.prompts, migrated.prompts);
assert.equal(migratedAgain.changed, false);
for (const corruptPrompt of ["old string", { text: "missing mode" }, { text: "bad mode", mode: "auto" }]) {
  assert.throws(() => migrateAiProfiles({
    stored: migrated.state,
    credentials: migrated.credentials,
    prompts: { [makeProfilePromptKey(openRouter, "deepseek/example", "th")]: corruptPrompt },
    legacy,
  }), (error) => error.code === "AI_PROFILE_INVALID",
  "a present canonical prompt record must remain fixed replace");
}

// A valid canonical schema is authoritative after migration. Reopening with
// stale flat rollback keys must neither change selection nor request a write.
// Read-time normalization also must not mutate timestamps.
const canonicalBeforeReopen = structuredClone(migrated.state);
const staleLegacyReopen = migrateAiProfiles({
  stored: migrated.state,
  credentials: {
    ...migrated.credentials,
    [makeProviderIdentity("ollama", "http://127.0.0.1:11434")]:
      "must-be-ignored-for-local",
  },
  prompts: migrated.prompts,
  legacy: {
    aiProvider: "ollama",
    aiBaseUrl: "http://127.0.0.1:11434",
    aiModel: "stale-local-model",
    aiCloudKey: "stale-flat-secret",
  },
  now: 999_999,
});
assert.deepEqual(staleLegacyReopen.effective, {
  aiProvider: "openrouter",
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiModel: "deepseek/example",
});
assert.equal(staleLegacyReopen.changed, false,
  "opening a valid canonical profile must not request a storage write");
assert.deepEqual(staleLegacyReopen.state, canonicalBeforeReopen,
  "opening must not update profile/provider timestamps");
assert.equal(
  staleLegacyReopen.credentials[
    makeProviderIdentity("ollama", "http://127.0.0.1:11434")
  ],
  undefined,
  "read-time views must ignore credentials attached to Local identities",
);

// Cloud -> Local -> Cloud keeps the exact provider/model/endpoint/key/prompt
// because each identity owns its own model record and scoped companion data.
const ollamaIdentity = makeProviderIdentity("ollama", "http://127.0.0.1:11434");
let roundTripState = updateAiProfile(migrated.state, {
  provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "qwen-local",
  defaults, patch: { thinking: "off" }, select: true, now: 700,
});
roundTripState = updateAiProfile(roundTripState, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "deepseek/example",
  defaults, patch: {}, select: true, now: 701,
});
const roundTrip = migrateAiProfiles({
  stored: roundTripState,
  credentials: migrated.credentials,
  prompts: migrated.prompts,
  legacy: { aiProvider: "ollama", aiModel: "qwen-local" },
  now: 999,
});
assert.deepEqual(roundTrip.effective, {
  aiProvider: "openrouter",
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiModel: "deepseek/example",
});
assert.equal(roundTrip.credentials[openRouter], "top-secret");
assert.equal(roundTrip.credentials[ollamaIdentity], undefined);
assert.equal(
  roundTrip.prompts[makeProfilePromptKey(openRouter, "deepseek/example", "th")].text,
  "Thai style",
);

// Prompt text and behavior are scoped by provider+model+language. Old string
// records migrate to append; explicit replace survives save/load; reset only
// removes the selected identity.
const promptKeyTh = makeProfilePromptKey(openRouter, "deepseek/example", "th");
const promptKeyEn = makeProfilePromptKey(openRouter, "deepseek/example", "en");
let promptRecords = setAiProfilePrompt(migrated.prompts, promptKeyTh, {
  text: "  Replace Thai style  ", mode: "replace",
});
promptRecords = setAiProfilePrompt(promptRecords, promptKeyEn, {
  text: "English notes", mode: "replace",
});
assert.deepEqual(getAiProfilePrompt(promptRecords, promptKeyTh),
  { text: "Replace Thai style", mode: "replace" });
assert.deepEqual(getAiProfilePrompt(promptRecords, promptKeyEn),
  { text: "English notes", mode: "replace" });
const promptStoragePatch = buildAiProfileStoragePatch({
  state: migrated.state,
  credentials: migrated.credentials,
  prompts: promptRecords,
  providerIdentity: openRouter,
  model: "deepseek/example",
  language: "th",
});
assert.deepEqual(promptStoragePatch.aiProfilePromptsV1[promptKeyTh],
  { text: "Replace Thai style", mode: "replace" });
assert.equal(promptStoragePatch.aiPrompt, "Replace Thai style",
  "flat rollback output remains text-only and is derived from canonical");
promptRecords = resetAiProfilePrompt(promptStoragePatch.aiProfilePromptsV1, promptKeyTh);
assert.deepEqual(getAiProfilePrompt(promptRecords, promptKeyTh),
  { text: "", mode: "replace" });
assert.deepEqual(getAiProfilePrompt(promptRecords, promptKeyEn),
  { text: "English notes", mode: "replace" });

// Only absence permits the one-time flat migration. Once the canonical key is
// present, corrupt/future data fails and flat values must never mask it.
for (const stored of [[], "bad", { version: 999, providers: {} }, { version: 1, providers: "bad" }]) {
  assert.throws(() => migrateAiProfiles({ stored, legacy, now: 600 }),
    (error) => error.code === "AI_PROFILE_INVALID");
}

// Nested provider corruption is visible at the canonical boundary.
for (const nested of [null, 0, 42, "bad-provider"]) {
  const stored = {
    version: 1,
    active: { providerIdentity: "broken", model: "model-a" },
    providers: { broken: nested },
  };
  assert.throws(() => migrateAiProfiles({ stored, legacy, now: 601 }),
    (error) => error.code === "AI_PROFILE_INVALID");
}

const brokenActive = structuredClone(migrated.state);
brokenActive.active = { providerIdentity: openRouter, model: "missing-model" };
assert.throws(() => requireActiveAiProfile(brokenActive),
  (error) => error.code === "AI_PROFILE_INCOMPLETE",
  "a broken active pointer must not fall back to flat provider/model values");
assert.throws(() => migrateAiProfiles({ stored: brokenActive, legacy }),
  (error) => error.code === "AI_PROFILE_INCOMPLETE",
  "canonical hydration must expose a broken active pointer before runtime dispatch");

// Dynamic object-path components must reject JavaScript prototype keys. The
// rejection itself is verified together with absence of prototype mutation.
for (const reserved of ["__proto__", "constructor", "prototype"]) {
  assert.throws(() => makeProviderIdentity(reserved, "https://safe.example/v1"),
    /reserved|provider|key/i, `provider key ${reserved}`);
  assert.throws(() => updateAiProfile(createAiProfiles(), {
    provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: reserved,
    defaults, patch: { thinking: "off" }, now: 602,
  }), /reserved|model|key/i, `model key ${reserved}`);
  assert.throws(() => makeProfilePromptKey(openRouter, "model-a", reserved),
    /reserved|language|key/i, `language key ${reserved}`);
}
assert.equal(Object.prototype.polluted, undefined);
assert.equal(({}).polluted, undefined);

// During rollback window, writes are dual-format: canonical state plus the
// current flat keys. Secrets remain provider-scoped rather than duplicated.
const storagePatch = buildAiProfileStoragePatch({
  state: migrated.state,
  credentials: migrated.credentials,
  prompts: migrated.prompts,
  providerIdentity: openRouter,
  model: "deepseek/example",
  language: "th",
});
assert.ok(storagePatch.aiProfilesV1);
assert.equal(storagePatch.aiProvider, "openrouter");
assert.equal(storagePatch.aiModel, "deepseek/example");
assert.equal(storagePatch.aiThinking, "off");
assert.equal(storagePatch.aiCloudKey, "top-secret");
assert.ok(!JSON.stringify(storagePatch.aiProfilesV1).includes("top-secret"));
assert.ok(!JSON.stringify(storagePatch.aiProfilesV1).match(/apiKey|aiCloudKey/i));

// Bounded storage uses deterministic least-recently-used eviction, but must
// retain the active profile and preserve the stale profile when under budget.
const underBudget = pruneAiProfiles(profiles, { maxBytes: 1_000_000 });
assert.deepEqual(underBudget.state, profiles);
assert.deepEqual(underBudget.evicted, []);
const bounded = pruneAiProfiles(profiles, { maxBytes: 700 });
assert.ok(bounded.bytes <= 700);
assert.ok(!bounded.evicted.includes(`${profiles.active.providerIdentity}\u0000${profiles.active.model}`),
  "active model must never be evicted");
assert.deepEqual(pruneAiProfiles(profiles, { maxBytes: 700 }), bounded,
  "LRU pruning must be deterministic");

// If the active profile alone cannot fit, it is retained but the caller must
// receive an explicit, actionable quota result rather than a false success.
let activeOnly = createAiProfiles();
activeOnly = updateAiProfile(activeOnly, {
  provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", model: "only-active",
  defaults, patch: {}, select: true, now: 700,
});
const impossibleLimit = 32;
const activeOverCap = pruneAiProfiles(activeOnly, { maxBytes: impossibleLimit });
assert.equal(activeOverCap.overBudget, true);
assert.equal(activeOverCap.limit, impossibleLimit);
assert.ok(activeOverCap.bytes > activeOverCap.limit);
assert.deepEqual(activeOverCap.state, activeOnly, "active profile must remain intact when over budget");
assert.deepEqual(activeOverCap.evicted, []);

// Trace/export are content-free: no key, prompt, glossary or translated text.
const sensitive = {
  state: migrated.state, credentials: migrated.credentials, prompts: migrated.prompts,
  glossary: ["private-term"], translatedText: "private-translation",
};
for (const output of [sanitizeAiProfileTrace(sensitive), exportAiProfiles(sensitive)]) {
  const text = JSON.stringify(output);
  for (const secret of ["top-secret", "Thai style", "private-term", "private-translation"]) {
    assert.ok(!text.includes(secret), `profile diagnostic/export leaked: ${secret}`);
  }
  assert.ok(!text.match(/apiKey|aiCloudKey|credential(s)?\s*[:"]/i));
}

// Endpoint paths/queries can carry tenant IDs or accidental secrets. Neither
// sanitized output may reveal them, and opaque provider identities must not be
// exposed because the current identity encoding can itself contain the URL.
const endpointSecret = "path-secret-7841";
const querySecret = "query-secret-9923";
let secretIdentity;
try {
  secretIdentity = makeProviderIdentity(
    "customcloud", `https://gateway.example/${endpointSecret}/v1?tenant=${querySecret}`,
  );
} catch (error) {
  assert.ok(error instanceof TypeError, "secret-bearing endpoint rejection must be typed");
}
if (secretIdentity) {
  let secretState = createAiProfiles();
  secretState = updateAiProfile(secretState, {
    provider: "customcloud",
    endpoint: `https://gateway.example/${endpointSecret}/v1?tenant=${querySecret}`,
    model: "safe-model", defaults, patch: {}, select: true, now: 800,
  });
  for (const output of [sanitizeAiProfileTrace({ state: secretState }), exportAiProfiles({ state: secretState })]) {
    const text = JSON.stringify(output);
    assert.ok(!text.includes(endpointSecret), "sanitized profile leaked endpoint path data");
    assert.ok(!text.includes(querySecret), "sanitized profile leaked endpoint query data");
    assert.ok(!text.includes(secretIdentity), "sanitized profile leaked opaque provider identity");
    assert.ok(!text.includes("gateway.example"), "sanitized profile leaked provider endpoint host");
  }
}

console.log("AI profiles contract tests passed.");
