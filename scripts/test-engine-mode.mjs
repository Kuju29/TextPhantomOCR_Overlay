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

// --- the setting round-trips ------------------------------------------------
{
  stored = {};
  const fresh = await readFullSettings();
  assert.equal(fresh.engineMode, "extension", "the extension engine is the default");

  stored = { engineMode: "api" };
  assert.equal((await readFullSettings()).engineMode, "api", "the API engine survives a read");

  stored = { engineMode: "nonsense" };
  assert.equal(
    (await readFullSettings()).engineMode,
    "extension",
    "an unknown value falls back to the default rather than routing nowhere",
  );

  stored = {};
  const defaults = await readFullSettings();
  assert.equal(defaults.aiLocalUnlimited, false, "unlimited local AI is opt-in");
  assert.equal(defaults.apiLocalUnlimited, false, "unlimited local API is opt-in");
}

// --- the popup writes the value the settings layer reads --------------------
{
  const popupHtml = await readFile(path.join(projectRoot, "src/popup/popup.html"), "utf8");
  const popupJs = await readFile(path.join(projectRoot, "src/popup/popup.js"), "utf8");
  const domJs = await readFile(path.join(projectRoot, "src/popup/dom.js"), "utf8");

  assert.ok(popupHtml.includes('id="engine-mode"'), "the popup must expose the engine selector");
  assert.ok(popupHtml.includes('value="extension"') && popupHtml.includes('value="api"'),
    "both engines must be offered");

  // The LABEL must match the VALUE. Everything downstream is an identity
  // mapping, so the only way the switch can lie is by putting the wrong words
  // next to the right value - and no other test would notice.
  const options = [...popupHtml.matchAll(/<option value="(extension|api)"\s*>([^<]*)<\/option>/g)]
    .map(([, value, label]) => [value, label.trim()]);
  assert.equal(options.length, 2, "the engine selector must have exactly the two options");
  const labelFor = Object.fromEntries(options);
  assert.match(
    labelFor.extension,
    /^Extension\b/i,
    `value="extension" is labelled ${JSON.stringify(labelFor.extension)}`,
  );
  assert.match(
    labelFor.api,
    /^API server\b/i,
    `value="api" is labelled ${JSON.stringify(labelFor.api)}`,
  );
  // ...and the handler must write the value it read, not its opposite.
  assert.match(
    popupJs,
    /const engineMode = els\.engineMode\.value === "api" \? "api" : "extension";/,
    "the popup must persist the selected value unchanged",
  );
  assert.match(
    popupJs,
    /els\.engineMode\.value = stored\.engineMode === "api" \? "api" : "extension";/,
    "the popup must show the stored value unchanged",
  );
  assert.ok(domJs.includes('getElementById("engine-mode")'), "dom.js must bind the selector");
  assert.match(popupJs, /setStorage\(\{\s*engineMode\s*\}\)/,
    "the popup must persist engineMode under that exact key");
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
    menu.includes('settings.engineMode === "api" ? "api" : "extension"'),
    "context-menu.js must normalise the stored value before stamping it",
  );
}

// --- and the job router acts on it ------------------------------------------
{
  const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");
  assert.ok(
    jobs.includes('const apiEngine = payload?.engine === "api"'),
    "jobs.js must read the engine off the payload",
  );
  assert.ok(
    jobs.includes("const mayUseLensDirect = !apiEngine &&"),
    "the API engine must disable the extension-first Lens path for every mode",
  );
  // The no-fallback rule now covers every lens_text source, and it must still
  // exempt the API engine — there, `/v1/translate` IS the route, so firing the
  // rule would dead-end every job the user deliberately sent to the server.
  assert.ok(
    jobs.includes('if (!apiEngine && payload.mode === "lens_text")'),
    "the no-fallback rule must be scoped to the extension engine and lens_text",
  );
  assert.ok(
    !jobs.includes('if (payload.source === "ai" && !apiEngine)'),
    "the old AI-only guard must be gone (see test-no-silent-fallback.mjs)",
  );
  assert.ok(
    jobs.includes('payload?.engine === "api" ? { lensDocument: false } : {}'),
    "the API engine must not ask the server for a document the extension would render",
  );
  // The engine must be visible in the trace, or 'did the switch work?' is unanswerable.
  assert.match(
    jobs,
    /traceNote\("background\/jobs\.js", "runTranslateJob", \{[\s\S]{0,600}?engine:/,
    "runTranslateJob must record which engine ran",
  );
}

console.log("Engine mode test passed: setting round-trips, both payloads stamped, router acts on it.");
