#!/usr/bin/env node

// Headless diagnostic runner for the extension-owned pipeline. It composes the
// same decoder, grouping transport, AI transport and document functions used
// by the service worker; browser DOM/session delivery is intentionally outside
// this process and is reported as not tested.
import fs from "node:fs/promises";
import path from "node:path";
import { createLensDirectPath } from "../src/background/pipeline/lens-direct.js";
import { fetchLensRawViaRest } from "../src/background/transports/lens.js";
import { groupParagraphsWithArtifactFallback } from "../src/background/transports/groups.js";
import { translateViaServer } from "../src/background/ai/transports/server.js";
import {
  applyTranslations,
  canRenderFaithfully,
  translationUnits,
} from "../src/shared/lens-document.js";
import { isLocalAiTarget } from "../src/shared/constants.js";

const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) {
  console.error("usage: node scripts/cli-extension-driver.mjs <config.json>");
  process.exit(2);
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const outDir = path.resolve(String(config.outDir || "debug"));
await fs.mkdir(outDir, { recursive: true });
// A successful rerun must not leave a stale failure beside fresh artifacts.
await fs.rm(path.join(outDir, "error.json"), { force: true });
const timeline = [];
const written = [];
const now = () => new Date().toISOString();
const event = (stage, state, details = {}) => timeline.push({ at: now(), stage, state, ...details });
const redact = (value) => {
  const secretKeys = /(?:api[_-]?key|authorization|token|credential|secret)/i;
  const sensitiveValues = new Set();
  const collect = (node, key = "") => {
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node)) collect(child, childKey);
      return;
    }
    if (typeof node !== "string") return;
    if (secretKeys.test(key) && node) sensitiveValues.add(node);
    if (/(?:url|endpoint)/i.test(key)) {
      try {
        const parsed = new URL(node);
        if (parsed.username) sensitiveValues.add(parsed.username);
        if (parsed.password) sensitiveValues.add(parsed.password);
        for (const queryValue of parsed.searchParams.values())
          if (queryValue) sensitiveValues.add(queryValue);
      } catch {}
    }
  };
  collect(config);
  const scrubUrls = (text) => String(text).replace(
    /https?:\/\/[^\s"'<>]+/gi,
    (raw) => {
      try {
        const parsed = new URL(raw);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch { return "[REDACTED_URL]"; }
    },
  );
  const visit = (node, key = "") => {
    if (secretKeys.test(key)) return node ? "[REDACTED]" : "";
    if (Array.isArray(node)) return node.map((item) => visit(item));
    if (node && typeof node === "object")
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v, k)]));
    if (typeof node === "string" && /(?:url|endpoint|route)/i.test(key)) {
      try {
        const parsed = new URL(node);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {}
    }
    if (typeof node === "string") {
      let clean = scrubUrls(node);
      for (const secret of sensitiveValues)
        if (secret) clean = clean.split(secret).join("[REDACTED]");
      return clean;
    }
    return node;
  };
  return visit(value);
};
const writeJson = async (name, value) => {
  // Every durable JSON boundary is redacted, including exact provider route
  // replies and extension trace events. OCR/translation content is preserved.
  await fs.writeFile(path.join(outDir, name), `${JSON.stringify(redact(value), null, 2)}\n`, "utf8");
  written.push(name);
};

const safeRequest = redact({
  schema: "tp.cli-extension/1",
  engine: "runsextension",
  apiUrl: config.apiUrl,
  image: { name: config.imageName, mime: config.mime, width: config.width, height: config.height },
  lensReplay: Boolean(config.lensReplay),
  mode: config.mode,
  source: config.source,
  targetLang: config.lang,
  provider: config.ai,
});
await writeJson("00_effective_request.redacted.json", safeRequest);

try {
  if (config.mode !== "lens_text") throw new Error("extension CLI currently supports only --mode lens_text");
  if (config.source === "ai" && isLocalAiTarget(config.ai?.provider, config.ai?.base_url)) {
    const error = new Error(
      "headless extension CLI does not emulate the browser's direct-local runtime; use a Cloud provider here or test Local AI in the browser",
    );
    error.code = "extension_cli_local_requires_browser";
    throw error;
  }

  const imageBytes = Buffer.from(String(config.imageBase64 || ""), "base64");
  const imageDataUri = `data:${config.mime || "image/jpeg"};base64,${config.imageBase64}`;
  const capabilities = { engineRoutesV2: true };
  let rawLensEnvelope = null;
  let groupRequest = null;
  let groupResponse = null;
  const traces = [];
  const fetchLens = async (base, options) => {
    event("lens", "started", { replay: Boolean(config.lensReplay) });
    if (config.lensReplay) {
      rawLensEnvelope = {
        lens: config.lensReplay,
        image: { width: config.width, height: config.height },
        replay: true,
      };
    } else {
      rawLensEnvelope = await fetchLensRawViaRest(base, options);
    }
    await writeJson("01_lens_raw.json", rawLensEnvelope.lens);
    event("lens", "finished");
    return rawLensEnvelope;
  };
  const group = async (base, options) => {
    groupRequest = redact({
      route: "/v2/engine/runsextension/groups",
      imageArtifactToken: options.imageArtifactToken ? "[REDACTED]" : "",
      imageDataUri: options.imageArtifactToken ? "" : "[IMAGE_DATA_REDACTED]",
      tree: options.tree,
      context: options.context,
    });
    await writeJson("03_group_request.redacted.json", groupRequest);
    event("groups", "started");
    groupResponse = await groupParagraphsWithArtifactFallback(base, options);
    await writeJson("04_group_route_response.json", groupResponse);
    event("groups", "finished");
    return groupResponse;
  };
  const runLens = createLensDirectPath({
    fetchFromUrl: async () => imageDataUri,
    fetchFromTab: async () => { throw new Error("tab byte fetch requires a browser"); },
    fetchLensRaw: fetchLens,
    groupParagraphs: group,
    runStage: async (_name, fn) => fn(),
    markPhase: () => {},
    trace: (name, data) => traces.push({ name, data }),
    traceLayout: () => {},
    getTrace: () => "cli-extension",
    log: { warn: (message, details) => traces.push({ name: "warning", data: { message, details } }) },
  });

  const payload = {
    engine: "runsextension",
    mode: "lens_text",
    source: config.source,
    lang: config.lang,
    imageDataUri,
    naturalSize: { width: config.width, height: config.height },
    render: { lensDocument: true },
    context: { tp_trace: "cli-extension", tp_tab_session: "cli-headless" },
    metadata: { image_id: "cli-image", batch_id: "cli-batch" },
    debug: { raw: true },
  };
  const decline = {};
  const lensResult = await runLens(String(config.apiUrl || ""), payload, {
    jobId: "cli-job", decline, capabilities,
  });
  if (!lensResult) throw decline.error || new Error(decline.reason || "extension Lens path declined");
  await writeJson("02_lens_decode.json", lensResult.debugLens || {});
  const canonicalOriginalTree = lensResult.debugLens?.canonicalOriginalTree || null;
  const rawOriginalTree = lensResult.debugLens?.trees?.grouping || null;
  if (canonicalOriginalTree) await writeJson("original_tree.json", canonicalOriginalTree);
  if (rawOriginalTree) await writeJson("original_tree_raw.json", rawOriginalTree);

  const units = translationUnits(lensResult.lensDocument);
  await writeJson("05_translation_units.json", units);
  let document = lensResult.lensDocument;
  let aiResponse = null;
  let applyReport = null;
  const aiWire = { schema: "tp.ai-wire-trace/1", identity: { engine: "runsextension",
    traceId: "cli-extension", imageId: "cli-image", batchId: "cli-batch" } };
  const wireTrace = async (stage, value) => { aiWire[stage] = value; };
  if (config.source === "ai") {
    const aiRequestSafe = redact({
      label: "safe client input (the transport constructs the exact HTTP envelope)",
      route: "/v2/engine/runsextension/ai/translate",
      units,
      targetLang: config.lang,
      sourceLang: document.sourceLang || "",
      provider: config.ai,
      prompt: config.ai?.prompt || "",
    });
    await writeJson("06_ai_request.safe.json", aiRequestSafe);
    event("ai", "started", { route: "/v2/engine/runsextension/ai/translate" });
    const translatable = units.filter((unit) => unit.translatable);
    if (!translatable.length) {
      aiResponse = { schema: "tp.ai.result/1", translations: [], missing: [], meta: { skipped: "no_translatable_text" } };
      await writeJson("07_ai_route_response.json", aiResponse);
    } else {
      const nativeFetch = globalThis.fetch;
      let exactRouteResponse = null;
      globalThis.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const url = String(args[0]?.url || args[0] || "");
        if (url.includes("/v2/engine/runsextension/ai/translate")) {
          const copy = response.clone();
          const text = await copy.text();
          try { exactRouteResponse = JSON.parse(text); }
          catch { exactRouteResponse = { nonJsonBody: text.slice(0, 4000), status: response.status }; }
        }
        return response;
      };
      try {
        aiResponse = await translateViaServer(translatable, {
          ai: config.ai,
          targetLang: config.lang,
          sourceLang: document.sourceLang || "",
          base: config.apiUrl,
          operationId: `cli-${Date.now()}`,
          batchId: "cli-batch",
          imageId: "cli-image",
          jobId: "cli-job",
          traceId: "cli-extension",
          capabilities,
          wireTrace,
        });
      } catch (error) {
        await writeJson("07_ai_route_response.json", exactRouteResponse ?? { capture: "response_unavailable" });
        throw error;
      } finally {
        globalThis.fetch = nativeFetch;
      }
      await writeJson("07_ai_route_response.json", exactRouteResponse ?? { capture: "response_unavailable" });
    }
    event("ai", "finished");
    const applied = applyTranslations(document, aiResponse.translations);
    document = applied.document;
    applyReport = applied.report;
    aiWire.validation = { missingIds: Array.isArray(aiResponse?.missing) ? aiResponse.missing.map(String) : [],
      wrongLanguageIds: [] };
    aiWire.applyResult = applyReport;
    await writeJson("ai-wire-trace.json", aiWire);
  }
  await writeJson("08_post_ai_document.json", { document, report: applyReport });
  const renderSource = config.source === "ai" ? "ai" : config.source;
  const preflight = {
    source: renderSource,
    fidelity: canRenderFaithfully(document, renderSource),
    browserDom: "not_tested_requires_browser",
    serviceWorkerSession: "not_tested_requires_browser",
    deliveryInsertion: "not_tested_requires_browser",
  };
  await writeJson("09_render_preflight.json", preflight);
  event("complete", "finished");
  await writeJson("10_timeline.json", [...timeline, ...traces.map((entry) => ({ ...entry, source: "extension_trace" }))]);
  await writeJson("11_summary.json", {
    ok: preflight.fidelity.ok === true,
    structuralOk: preflight.fidelity.ok === true,
    engine: "runsextension",
    source: config.source,
    aiEndToEnd: config.source === "ai"
      ? "completed_to_render_preflight_browser_insertion_not_tested"
      : "not_tested_source_not_ai",
    providerGenerationAttempts: config.source === "ai"
      ? Number(aiResponse?.meta?.generationAttempts || 0)
      : 0,
    canonicalRoutesOnly: true,
    lensReplay: Boolean(config.lensReplay),
    grouping: groupResponse ? "requested" : "skipped_horizontal_or_not_needed",
    units: units.length,
    translations: aiResponse?.translations?.length || 0,
    renderPreflight: preflight,
    artifacts: [...written, "11_summary.json"],
  });
  await writeJson("run_status.json", {
    schema: "tp.cli-run-status/1",
    engine: "runsextension",
    source: config.source,
    structuralOk: preflight.fidelity.ok === true,
    aiEndToEnd: config.source === "ai"
      ? "completed_to_render_preflight_browser_insertion_not_tested"
      : "not_tested_source_not_ai",
    providerGenerationAttempts: config.source === "ai"
      ? Number(aiResponse?.meta?.generationAttempts || 0)
      : 0,
    browserDom: "not_tested_requires_browser",
    serviceWorkerSession: "not_tested_requires_browser",
    deliveryInsertion: "not_tested_requires_browser",
  });
} catch (error) {
  event("error", "failed", { code: String(error?.code || ""), message: String(error?.message || error) });
  await writeJson("10_timeline.json", timeline);
  await writeJson("error.json", redact({
    ok: false,
    engine: "runsextension",
    code: String(error?.code || "extension_cli_failed"),
    message: String(error?.message || error),
    status: Number(error?.status || 0),
    browserDom: "not_tested_requires_browser",
    artifacts: [...written, "error.json"],
  }));
  console.error(
    redact(`[cli-extension] ${error?.code || "error"}: ${error?.message || error}`),
  );
  process.exit(1);
}
