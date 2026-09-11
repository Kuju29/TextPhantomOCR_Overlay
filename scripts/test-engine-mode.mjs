// Proves the "Where the work runs" setting survives storage -> settings -> payload,
// and that the API engine actually skips the extension-first path.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `chrome.storage.local` stands in for the browser; nothing else is stubbed.
let stored = {};
globalThis.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb(stored),
      set: (patch, cb) => {
        stored = { ...stored, ...patch };
        cb?.();
      },
    },
  },
};

const { readFullSettings } = await import("../src/shared/settings.js");
const {
  RUNS_API_AVAILABLE,
  effectiveEngineMode,
} = await import("../src/shared/engine-mode.js");

// --- the setting round-trips ------------------------------------------------
{
  stored = {};
  const fresh = await readFullSettings();
  assert.equal(fresh.engineMode, "extension", "the extension engine is the default");

  stored = { engineMode: "api" };
  const savedApiSettings = await readFullSettings();
  assert.equal(savedApiSettings.engineMode, "api", "the saved API preference survives a read");
  assert.equal(RUNS_API_AVAILABLE, false, "runsapi must remain feature-disabled");
  assert.equal(
    effectiveEngineMode(savedApiSettings.engineMode),
    "extension",
    "a stored API preference must emit Extension while runsapi is unavailable",
  );

  stored = { engineMode: "nonsense" };
  assert.equal(
    (await readFullSettings()).engineMode,
    "extension",
    "an unknown value falls back to the default rather than routing nowhere",
  );

  stored = {};
  const defaults = await readFullSettings();
  assert.equal(defaults.rateLimitEnabled, false, "fresh installs must not enable manual RPM pacing");
  assert.equal(defaults.aiLocalUnlimited, undefined, "removed Local pacing preference is not exposed at runtime");
  assert.equal(defaults.apiLocalUnlimited, true, "local API removes time pacing by default");
  assert.equal(defaults.aiLocalCapacityMode, "auto", "new and migrated Local AI defaults to bounded Auto capacity");
  assert.equal(defaults.aiLocalManualConcurrency, 1, "manual Local AI capacity starts safely at one");

  stored = { aiLocalUnlimited: false };
  const legacyUnlimited = await readFullSettings();
  assert.equal(legacyUnlimited.aiLocalUnlimited, undefined, "legacy false pacing preference is ignored");
  assert.equal(legacyUnlimited.aiLocalCapacityMode, "auto", "legacy pacing never changes bounded concurrency");

  stored = { aiLocalCapacityMode: "manual", aiLocalManualConcurrency: 99 };
  const boundedManual = await readFullSettings();
  assert.equal(boundedManual.aiLocalCapacityMode, "manual");
  assert.equal(boundedManual.aiLocalManualConcurrency, 4, "manual capacity is clamped to the UI/runtime ceiling");

  stored = { rateLimitEnabled: true, rateRpm: 0, rateBurst: 0 };
  const migratedCap = await readFullSettings();
  assert.equal(migratedCap.rateLimitEnabled, true);
  assert.equal(migratedCap.rateRpm, 30, "enabled legacy zero RPM must use the visible safe default");
  assert.equal(migratedCap.rateBurst, 4, "enabled legacy zero burst must use the visible safe default");
  assert.equal(migratedCap.rateProfile, "custom");

  stored = { rateLimitEnabled: false, rateRpm: 0, rateBurst: 0 };
  const explicitOff = await readFullSettings();
  assert.equal(explicitOff.rateLimitEnabled, false, "an explicit off switch must remain off");
  assert.equal(explicitOff.rateRpm, 0);
  assert.equal(explicitOff.rateBurst, 0);
}

// --- the popup temporarily exposes only extension execution -----------------
{
  const popupHtml = await readFile(path.join(projectRoot, "src/popup/popup.html"), "utf8");
  const popupJs = await readFile(path.join(projectRoot, "src/popup/popup.js"), "utf8");
  const popupHydration = await readFile(path.join(projectRoot, "src/popup/controllers/settings-hydration-controller.js"), "utf8");
  const popupEvents = await readFile(path.join(projectRoot, "src/popup/controllers/popup-event-controller.js"), "utf8");
  const domJs = await readFile(path.join(projectRoot, "src/popup/dom.js"), "utf8");
  const autoJs = await readFile(path.join(projectRoot, "src/auto/auto.js"), "utf8");

  assert.ok(popupHtml.includes('id="engine-mode"'), "the popup must expose the engine selector");
  assert.ok(popupHtml.includes('value="extension"') && popupHtml.includes('value="api"'),
    "both engine values must remain represented for a reversible UI change");

  // The LABEL must match the VALUE. Everything downstream is an identity
  // mapping, so the only way the switch can lie is by putting the wrong words
  // next to the right value - and no other test would notice.
  const options = [...popupHtml.matchAll(/<option value="(extension|api)"([^>]*)>([^<]*)<\/option>/g)]
    .map(([, value, attributes, label]) => ({ value, attributes, label: label.trim() }));
  assert.equal(options.length, 2, "the engine selector must have exactly the two options");
  const optionFor = Object.fromEntries(options.map((option) => [option.value, option]));
  assert.match(
    optionFor.extension.label,
    /^Extension\b/i,
    `value="extension" is labelled ${JSON.stringify(optionFor.extension.label)}`,
  );
  assert.match(
    optionFor.api.label,
    /^API server\b/i,
    `value="api" is labelled ${JSON.stringify(optionFor.api.label)}`,
  );
  assert.match(optionFor.api.attributes, /\bdisabled\b/, "the API option must reject user selection");
  assert.match(optionFor.api.attributes, /aria-disabled="true"/, "the API option must expose its unavailable state");
  assert.match(optionFor.api.label, /temporarily unavailable/i, "the API option must explain its temporary state");
  assert.match(
    popupHtml,
    /id="engine-mode-availability"[^>]*role="status"[^>]*>[\s\S]*?temporarily unavailable[\s\S]*?run in the extension/i,
    "the selector must have an accessible availability notice",
  );
  assert.match(
    popupHydration,
    /if\s*\(els\.engineMode\)\s*els\.engineMode\.value\s*=\s*effectiveEngineMode\(stored\.engineMode\);/,
    "the popup must use extension without restoring a stored API choice into the UI",
  );
  assert.match(
    popupEvents,
    /els\.engineMode\?\.addEventListener\("change", async \(\) => \{[\s\S]{0,300}?els\.engineMode\.value = effectiveEngineMode\(els\.engineMode\.value\);/,
    "the popup must reject programmatic API selection",
  );
  assert.ok(domJs.includes('getElementById("engine-mode")'), "dom.js must bind the selector");
  assert.doesNotMatch(popupJs, /setStorage\(\{\s*engineMode\s*\}\)/,
    "the unavailable selector must not overwrite the stored API preference");
  assert.match(autoJs, /state\.engineMode = effectiveEngineMode\(stored\.engineMode\);/,
    "Auto must resolve a seeded API preference through the effective-engine gate");
  assert.match(autoJs, /state\.engineMode = effectiveEngineMode\(changes\.engineMode\.newValue\);/,
    "Auto must gate live preference changes too");
}

// --- the service worker reads it onto every payload -------------------------
{
  const menu = await readFile(path.join(projectRoot, "src/background/context-menu.js"), "utf8");
  const engineStamps = menu.match(/engine:\s*engineMode/g) || [];
  assert.equal(
    engineStamps.length,
    2,
    "both the single-image and whole-page payloads must carry the engine",
  );
  assert.ok(
    menu.includes("const resolvedSettings = profileSnapshot?.settings || flatSettings") &&
      menu.includes("engineMode: effectiveEngineMode(resolvedSettings.engineMode)"),
    "context-menu.js must gate either the AI snapshot or non-AI flat settings before preflight and payload creation",
  );
  assert.match(
    menu,
    /const profileSnapshot = usesAi[\s\S]{0,180}?resolveJobAiProfile[\s\S]{0,180}?: null;/,
    "only AI jobs may substitute a profile snapshot; non-AI jobs retain their stored engine identity",
  );
  assert.ok(
    menu.includes("const engineMode = effectiveEngineMode(settings.engineMode)"),
    "context-menu jobs must stamp only the effective engine",
  );
}

// --- and the job router acts on it ------------------------------------------
{
  const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");
  assert.match(
    jobs,
    /const\s+apiEngine\s*=\s*payload\?\.engine\s*===\s*["']api["']/,
    "jobs.js must read the engine off the payload",
  );
  assert.match(
    jobs,
    /const\s+mayUseLensDirect\s*=\s*!apiEngine\s*&&/,
    "the API engine must disable the extension-first Lens path for every mode",
  );
  // The no-fallback rule now covers every lens_text source, and it must still
  // exempt the API engine — there, `/v1/translate` IS the route, so firing the
  // rule would dead-end every job the user deliberately sent to the server.
  assert.match(
    jobs,
    /if\s*\(\s*!apiEngine\s*&&\s*payload\.mode\s*===\s*["']lens_text["']\s*\)/,
    "the no-fallback rule must be scoped to the extension engine and lens_text",
  );
  assert.ok(
    !jobs.includes('if (payload.source === "ai" && !apiEngine)'),
    "the old AI-only guard must be gone (see test-no-silent-fallback.mjs)",
  );
  assert.match(
    jobs,
    /payload\?\.engine\s*===\s*["']api["']\s*\?\s*\{\s*lensDocument:\s*false\s*\}\s*:\s*\{\s*\}/,
    "the API engine must not ask the server for a document the extension would render",
  );
  // The engine must be visible in the trace, or 'did the switch work?' is unanswerable.
  assert.match(
    jobs,
    /traceNote\(\s*["']background\/jobs\.js["']\s*,\s*["']runTranslateJob["']\s*,\s*\{[\s\S]{0,600}?engine:/,
    "runTranslateJob must record which engine ran",
  );
}

console.log("Engine mode test passed: setting round-trips, both payloads stamped, router acts on it.");
