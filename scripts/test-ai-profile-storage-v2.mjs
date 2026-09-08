import assert from "node:assert/strict";
import { AI_PROFILE_STORAGE_VERSION, prepareAiProfileStorageV2, ensureAiProfileStorageV2, migrateKnownBuiltInPromptRecords } from "../src/shared/ai-profile-storage.js";
import { makeProviderIdentity } from "../src/shared/ai-profiles.js";

const oldIdentity = `${encodeURIComponent("openrouter")}::${encodeURIComponent("https://OPENROUTER.ai/api/v1/")}`;
const canonicalIdentity = makeProviderIdentity("OpenRouter", "https://OPENROUTER.ai/api/v1/");
const oldPromptKey = [oldIdentity, "deepseek/model", "th"].map(encodeURIComponent).join("::");

const historicalFixture = "known historical built-in fixture";
const historicalFixtureHash = Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(historicalFixture),
)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const knownDefaultMigration = await migrateKnownBuiltInPromptRecords(
  { [oldPromptKey]: { text: historicalFixture, mode: "replace" } },
  { historicalThaiHashes: [historicalFixtureHash] },
);
assert.equal(knownDefaultMigration.changed, true);
assert.match(knownDefaultMigration.prompts[oldPromptKey].text, /Omit obvious subjects and person-pronouns/,
  "a byte-identical known built-in advances to the current bundled Thai prompt");
const customMigration = await migrateKnownBuiltInPromptRecords(
  { [oldPromptKey]: { text: `${historicalFixture}!`, mode: "replace" } },
  { historicalThaiHashes: [historicalFixtureHash] },
);
assert.equal(customMigration.changed, false);
assert.equal(customMigration.prompts[oldPromptKey].text, `${historicalFixture}!`,
  "even a one-byte-different custom prompt remains authoritative");
const markerless = {
  aiProvider: "openrouter", aiBaseUrl: "https://openrouter.ai/api/v1", aiModel: "deepseek/model",
  aiProfilesV1: { version: 1, active: { providerIdentity: oldIdentity, model: "deepseek/model" }, providers: {
    [oldIdentity]: { provider: "OpenRouter", endpoint: "https://OPENROUTER.ai/api/v1/", credentialRef: oldIdentity, updatedAt: 1, models: {
      "deepseek/model": { profile: { thinking: "off", tokenPolicy: { mode: "dynamic", maxOutputTokens: 0 }, temperature: null, pageImage: "off", memoryMode: "off", concurrency: { mode: "auto", max: 0 }, providerOptions: {} }, updatedAt: 1 },
    } },
  } },
  aiProfileCredentialsV1: { [oldIdentity]: "secret" },
  aiProfilePromptsV1: { [oldPromptKey]: "Thai series note" },
};

const migrated = prepareAiProfileStorageV2(markerless, markerless);
assert.equal(migrated.patch.aiProfileStorageVersion, AI_PROFILE_STORAGE_VERSION);
assert.equal(migrated.state.active.providerIdentity, canonicalIdentity);
assert.equal(migrated.credentials[canonicalIdentity], "secret");
assert.deepEqual(Object.values(migrated.prompts)[0], { text: "Thai series note", mode: "replace" });

const v2 = { ...markerless, ...migrated.patch };
const reopened = prepareAiProfileStorageV2(v2, { aiProvider: "ollama", aiBaseUrl: "http://localhost:11434", aiModel: "wrong" });
assert.equal(reopened.changed, false);
assert.equal(reopened.patch, null);
assert.equal(reopened.effective.aiProvider, "openrouter");
const oldV2 = structuredClone(v2);
oldV2.aiProfileStorageVersion = 2;
for (const record of Object.values(oldV2.aiProfilePromptsV1)) record.mode = "append";
const upgradedV3 = prepareAiProfileStorageV2(oldV2, {});
assert.equal(upgradedV3.changed, true);
assert.equal(upgradedV3.patch.aiProfileStorageVersion, 3);
assert.equal(Object.values(upgradedV3.prompts)[0].mode, "replace");
const forbiddenAppend = structuredClone(v2);
Object.values(forbiddenAppend.aiProfilePromptsV1)[0].mode = "append";
assert.throws(() => prepareAiProfileStorageV2(forbiddenAppend, {}),
  (error) => error.code === "AI_PROFILE_INVALID");
assert.throws(() => prepareAiProfileStorageV2({ ...v2, aiProfilesV1: { ...v2.aiProfilesV1, version: 99 } }), (error) => error.code === "AI_PROFILE_INVALID");
let invalidMigrationCalls = 0;
let invalidWrites = 0;
await assert.rejects(
  ensureAiProfileStorageV2({}, {
    read: async () => ({ ...structuredClone(v2), aiProfilesV1: { ...structuredClone(v2.aiProfilesV1), version: 99 } }),
    write: async () => { invalidWrites += 1; },
    migrateKnown: async () => {
      invalidMigrationCalls += 1;
      return { prompts: {}, changed: true };
    },
  }),
  (error) => error.code === "AI_PROFILE_INVALID",
);
assert.equal(invalidMigrationCalls, 0,
  "known-default migration must not inspect prompts before profile validation");
assert.equal(invalidWrites, 0,
  "an invalid profile must remain unchanged");
for (const badPrompts of [
  { safe: { text: "missing mode" } },
  { constructor: { text: "bad key", mode: "replace" } },
]) assert.throws(() => prepareAiProfileStorageV2({ ...v2, aiProfilePromptsV1: badPrompts }),
  (error) => error.code === "AI_PROFILE_INVALID");

const broken = structuredClone(markerless);
broken.aiProfilesV1.active.model = "missing";
broken.aiProvider = "ollama"; broken.aiBaseUrl = "http://localhost:11434"; broken.aiModel = "not-persisted";
assert.throws(() => prepareAiProfileStorageV2(broken, broken), (error) => error.code === "AI_PROFILE_MIGRATION_INCOMPLETE");

let storage = structuredClone(markerless);
let writes = 0;
const read = async () => structuredClone(storage);
const write = async (patch) => { writes += 1; storage = { ...storage, ...structuredClone(patch) }; };
await Promise.all([ensureAiProfileStorageV2(markerless, { read, write }), ensureAiProfileStorageV2(markerless, { read, write })]);
assert.equal(writes, 1);
await ensureAiProfileStorageV2(markerless, { read, write });
assert.equal(writes, 1);

// Simulate another extension context committing between our initial read and
// pre-write re-read. Its valid winner must be used without a stale overwrite.
let raceReads = 0;
let raceWrites = 0;
const winner = structuredClone(storage);
const raced = await ensureAiProfileStorageV2(markerless, {
  read: async () => (++raceReads === 1 ? structuredClone(markerless) : structuredClone(winner)),
  write: async () => { raceWrites += 1; },
});
assert.equal(raced.changed, false);
assert.equal(raceWrites, 0);
console.log("AI profile storage v2 migration tests passed.");
