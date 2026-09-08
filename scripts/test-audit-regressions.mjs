import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  domainKeyOf,
  hostOf,
  shouldPrefetchDataUri,
} from "../src/background/pipeline/image-routing.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(root, p), "utf8");

const caps = await read("src/background/capabilities.js");
assert.match(caps, /capacityAi:\s*data\?\.capacityAi/);
assert.match(caps, /adaptive:\s*data\?\.adaptive/);

assert.equal(hostOf("https://IMG.Example.CO.UK/a.png"), "img.example.co.uk");
assert.equal(domainKeyOf("https://IMG.Example.CO.UK/a.png"), "img.example.co.uk",
  "domain memory must use the exact normalized host, not the last two labels");
assert.equal(domainKeyOf("not a URL"), "");
const browserFetchDomains = new Set(["img.example.co.uk"]);
assert.equal(shouldPrefetchDataUri(
  { src: "https://img.example.co.uk/a.png" }, browserFetchDomains,
), true);
assert.equal(shouldPrefetchDataUri(
  { src: "https://unrelated.co.uk/a.png" }, browserFetchDomains,
), false, "an unrelated public-suffix sibling must not inherit browser-prefetch memory");

const messaging = await read("src/content/messaging.js");
assert.match(messaging, /!mime\.toLowerCase\(\)\.startsWith\("image\/"\)/);
assert.match(messaging, /25 \* 1024 \* 1024/);

const popup = await read("src/popup/popup.html");
const localRegistry = await read("src/shared/ai/providers/local-registry.js");
for (const value of ["koboldcpp", "vllm", "llamafile", "gpt4all"]) {
  assert.equal((localRegistry.match(new RegExp(`\\bas ${value}\\b`, "g")) || []).length, 1,
    `${value} must have one registry owner`);
  assert.equal((popup.match(new RegExp(`value=\\"${value}\\"`, "g")) || []).length, 0,
    `${value} must not be duplicated in static popup HTML`);
}

const manifest = JSON.parse(await read("platform/base.json"));
const viewer = await read("src/viewer/viewer.html");
const scripts = manifest.content_scripts[0].js;
let last = -1;
for (const script of scripts) {
  const rel = script.startsWith("shared/") ? `../${script}` : `../${script}`;
  const needle = `src="${rel}"`;
  const i = viewer.indexOf(needle);
  assert.ok(i >= 0, `viewer missing ${script}`);
  assert.ok(i > last, `viewer order differs at ${script}`);
  last = i;
}

const gemini = await read("api/backend/ai/providers/cloud_gemini.py");
assert.match(gemini, /def _accepts_sampling_parameters/);
assert.match(gemini, /if _accepts_sampling_parameters\(model\):/);
assert.doesNotMatch(gemini, /"generationConfig": \{\n\s*"temperature":/);

const aiConfig = gemini;
assert.match(aiConfig, /"3-flash":\s+"gemini-3\.6-flash"/);
assert.match(aiConfig, /"3-pro":\s+"gemini-3\.1-pro-preview"/);
assert.match(aiConfig, /"3-pro-image":\s+"gemini-3-pro-image"/);

const prompts = await read("api/backend/ai/prompts/styles.py");
assert.match(prompts, /"th": TH_STYLE/);
assert.match(prompts, /return _with_canonical_target_header\(lang, selected\)/);

console.log("audit regression test passed");

// Provider/model discovery: the picker must promise only key/account-scoped
// models that this build can actually send through its transport.
{
  const providers = await read("api/backend/ai/provider_resolution.py");
  const openrouterProvider = await read("api/backend/ai/providers/cloud_openrouter.py");
  const togetherProvider = await read("api/backend/ai/providers/cloud_together.py");
  const resolver = await read("api/backend/ai/resolve.py");
  const geminiProvider = await read("api/backend/ai/providers/cloud_gemini.py");
  const openaiProvider = await read("api/backend/ai/providers/cloud_openai.py");
  const deepseekProvider = await read("api/backend/ai/providers/cloud_deepseek.py");
  const anthropicProvider = await read("api/backend/ai/providers/cloud_anthropic.py");
  const popupHtml = await read("src/popup/popup.html");
  const popupDom = await read("src/popup/dom.js");
  const popupJs = await read("src/popup/popup.js");
  const popupProviderMeta = await read("src/popup/controllers/provider-meta-controller.js");
  const aiRoute = await read("api/backend/api/routes/ai_v1.py");
  const aiApplication = (await Promise.all([
    "orchestration.py", "provider_execution.py", "provider_errors.py",
    "rate_admission.py", "request_validation.py", "response_mapping.py", "telemetry.py",
  ].map((name) => read(`api/backend/application/ai_translation/${name}`)))).join("\n");
  const translate = (await Promise.all([
    "invocation.py", "result_decode.py", "model_resolution.py",
  ].map((name) => read(`api/backend/ai/translation/${name}`)))).join("\n");

  assert.doesNotMatch(
    popupHtml,
    /<select id="ai-provider"[\s\S]{0,250}?<option value="auto"/,
    "new UI must require an explicit provider instead of guessing ambiguous sk-* keys",
  );
  assert.match(popupHtml, /<option value="" disabled selected>Select provider…<\/option>/);
  assert.match(openrouterProvider, /\/models\/user/,
    "OpenRouter discovery must use its account-scoped catalogue");
  assert.match(openrouterProvider, /available_on_current_plan/,
    "OpenRouter must exclude models unavailable on the current plan");
  assert.match(openrouterProvider, /endpoint_type[\s\S]{0,120}?!= "chat"/,
    "OpenRouter must reject explicitly non-chat endpoints");
  assert.match(openrouterProvider, /output_modalities[\s\S]{0,220}?"text" not in/,
    "OpenRouter must reject models that cannot return text");
  assert.match(togetherProvider, /get\("type"\)[\s\S]{0,100}?==\s*"chat"/,
    "Together discovery must expose only chat-completion models");
  assert.match(geminiProvider, /"generateContent" in \(item\.get\("supportedGenerationMethods"\)/,
    "Gemini discovery must expose only generateContent-capable models");
  assert.match(geminiProvider, /if status == 403:[\s\S]{0,120}?status="forbidden"/,
    "Gemini must preserve an explicit forbidden discovery result");
  assert.match(providers, /return matches\[0\] if len\(matches\) == 1 else ""/,
    "ambiguous key prefixes must never guess a provider");
  assert.match(providers, /def provider_key_mismatch/);
  assert.match(resolver, /error="provider_key_mismatch"/);
  assert.match(translate, /AI provider\/key mismatch/);
  assert.match(resolver, /models=\[\],[\s\S]{0,140}?source="none"/);
  assert.doesNotMatch(resolver, /GEMINI_FALLBACK_MODELS|HF_FALLBACK_MODELS|_fallback_models/);
  assert.match(popupDom, /No `auto` or static fallback is offered/);
  assert.match(popupProviderMeta, /model_access_denied:\s*\["error",\s*" • ✕ Account cannot use this model"\]/);
  assert.match(popupProviderMeta, /probeMessages\[probe\.status\]/,
    "provider probe status must select the explicit model-access-denied message");
  assert.match(aiRoute, /from backend\.application\.ai_translation\.orchestration import ai_schema, execute/,
    "the extension AI route must delegate to the application service");
  assert.match(aiApplication, /AI provider must be selected explicitly for this API key/);
  assert.match(translate, /AI provider must be selected explicitly for this API key/);
  assert.match(geminiProvider, /DEFAULT_MODEL = "gemini-3\.6-flash"/);
  assert.match(openaiProvider, /DEFAULT_MODEL = "gpt-5\.6-luna"/);
  assert.match(deepseekProvider, /"deepseek-v4-flash"/);
  assert.match(anthropicProvider, /DEFAULT_MODEL = "claude-sonnet-5"/);
}

console.log("provider/model live-verification regression checks passed");

// Hugging Face Docker Spaces Dev Mode compatibility.
{
  const dockerfile = await read("api/Dockerfile");
  for (const pkg of ["bash", "curl", "wget", "procps", "git", "git-lfs"]) {
    assert.match(dockerfile, new RegExp(`\\b${pkg.replace("-", "\\-")}\\b`), `Dockerfile missing Dev Mode package ${pkg}`);
  }
  assert.match(dockerfile, /useradd -m -u 1000/);
  assert.match(dockerfile, /chown -R 1000:1000 \/app/);
  assert.match(dockerfile, /ENV HOME=\/home\/user/);
  assert.match(dockerfile, /USER 1000/);
  assert.match(dockerfile, /^CMD /m);
}

console.log("HF Spaces Dev Mode Docker regression checks passed");
