import assert from "node:assert/strict";
import { createApiHealthController } from "../src/popup/controllers/api-health-controller.js";

const pending = new Map();
const availability = [];
const state = { lastApiOk: true, healthSeq: 0, userInteractedApi: true };
const els = { apiUrl: { value: "https://old.example" }, lang: { value: "en" }, sources: { value: "ai" } };
const controller = createApiHealthController({ els, state,
  normalizeUrl: (url) => String(url || ""), checkHealthOnce: async () => true,
  fetchJson: async (url) => new Promise((resolve) => pending.set(url, resolve)),
  paths: { META: "/meta" }, timeout: 200, retryDelays: [],
  setStatus: () => {}, setSelectOptions: () => {}, orderLanguages: (list) => list,
  languages: [], sources: [], pinnedLanguages: [], persist: async () => {},
  toggleUi: () => {}, paidAvailability: (...args) => availability.push(args),
});

const old = controller.refreshMeta(els.apiUrl.value);
els.apiUrl.value = "https://new.example";
controller.invalidateMeta();
pending.get("https://old.example/meta")({ ok: true, paid: { available: true } });
await old;
assert.equal(availability.some(([enabled]) => enabled === true), false,
  "A delayed response from the old API must not show Paid");
const current = controller.refreshMeta(els.apiUrl.value);
pending.get("https://new.example/meta")({ ok: true, paid: { available: true } });
await current;
assert.deepEqual(availability.at(-1), [true, "https://new.example"]);
const malformed = controller.refreshMeta(els.apiUrl.value);
pending.get("https://new.example/meta")({ ok: false, paid: { available: true } });
await malformed;
assert.deepEqual(availability.at(-1), [false, "https://new.example"],
  "An invalid meta response must revoke Paid availability");
console.log("Paid availability belongs to the latest healthy API URL and valid meta response.");
