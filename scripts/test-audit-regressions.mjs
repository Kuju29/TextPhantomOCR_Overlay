import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(path.join(root, p), "utf8");

const caps = await read("src/background/capabilities.js");
assert.match(caps, /capacityAi:\s*data\?\.capacityAi/);
assert.match(caps, /adaptive:\s*data\?\.adaptive/);

const jobs = await read("src/background/jobs.js");
assert.match(jobs, /function domainKeyOf\(u\)[\s\S]*hostOf\(u\)\.toLowerCase\(\)/);
assert.doesNotMatch(jobs, /labels\.slice\(-2\)/);

const messaging = await read("src/content/messaging.js");
assert.match(messaging, /!mime\.toLowerCase\(\)\.startsWith\("image\/"\)/);
assert.match(messaging, /25 \* 1024 \* 1024/);

const popup = await read("src/popup/popup.html");
for (const value of ["koboldcpp", "vllm", "llamafile", "gpt4all"]) {
  assert.equal((popup.match(new RegExp(`value=\\"${value}\\"`, "g")) || []).length, 1, `${value} duplicated`);
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

const gemini = await read("api/backend/ai/clients/gemini.py");
assert.match(gemini, /def _accepts_sampling_parameters/);
assert.match(gemini, /if _accepts_sampling_parameters\(model\):/);
assert.doesNotMatch(gemini, /"generationConfig": \{\n\s*"temperature":/);

const aiConfig = await read("api/backend/ai/config.py");
assert.match(aiConfig, /"3-flash":\s+"gemini-3\.6-flash"/);
assert.match(aiConfig, /"3-pro":\s+"gemini-3\.1-pro-preview"/);
assert.match(aiConfig, /"3-pro-image":\s+"gemini-3-pro-image"/);

const launcher = await read("launcher/textphantom_launcher.py");
assert.match(launcher, /THAI_STYLE_COMPACT/);
const prompts = await read("api/backend/ai/prompts.py");
assert.match(prompts, /LANG_STYLE\.get\("th"\) or THAI_STYLE_COMPACT/);

console.log("audit regression test passed");

// Provider/model discovery: the picker must promise only key/account-scoped
// models that this build can actually send through its transport.
{
  const providers = await read("api/backend/ai/providers.py");
  const resolver = await read("api/backend/ai/resolve.py");
  const aiConfig2 = await read("api/backend/ai/config.py");
  const popupHtml = await read("src/popup/popup.html");
  const popupDom = await read("src/popup/dom.js");
  const popupJs = await read("src/popup/popup.js");
  const aiRoute = await read("api/backend/api/routes/ai_v1.py");
  const translate = await read("api/backend/ai/translate.py");

  assert.doesNotMatch(
    popupHtml,
    /<select id="ai-provider"[\s\S]{0,250}?<option value="auto"/,
    "new UI must require an explicit provider instead of guessing ambiguous sk-* keys",
  );
  assert.match(popupHtml, /<option value="" disabled selected>Select provider…<\/option>/);
  assert.match(providers, /if prov == "openrouter":[\s\S]{0,180}?\/models\/user/);
  assert.match(providers, /available_on_current_plan/);
  assert.match(providers, /if str\(item\.get\("type"\)[\s\S]{0,80}?!= "chat"/);
  assert.match(providers, /"generateContent" not in methods/);
  assert.match(providers, /if r\.status_code == 403:[\s\S]{0,120}?status="forbidden"/);
  assert.match(providers, /return ""\n\n\ndef canonical_provider/);
  assert.match(providers, /def provider_key_mismatch/);
  assert.match(resolver, /error="provider_key_mismatch"/);
  assert.match(translate, /AI provider\/key mismatch/);
  assert.match(resolver, /models=\[\],[\s\S]{0,140}?source="none"/);
  assert.doesNotMatch(resolver, /GEMINI_FALLBACK_MODELS|HF_FALLBACK_MODELS|_fallback_models/);
  assert.match(popupDom, /No `auto` or static fallback is offered/);
  assert.match(popupJs, /probe\.status === "model_access_denied"/);
  assert.match(aiRoute, /AI provider must be selected explicitly for this API key/);
  assert.match(translate, /AI provider must be selected explicitly for this API key/);
  assert.match(aiConfig2, /"gemini":\s+\{"model": "gemini-3\.6-flash"/);
  assert.match(aiConfig2, /"openai":\s+\{"model": "gpt-5\.6-luna"/);
  assert.match(aiConfig2, /"deepseek":\s+\{"model": "deepseek-v4-flash"/);
  assert.match(aiConfig2, /"anthropic":\s+\{"model": "claude-sonnet-5"/);
}

console.log("provider/model live-verification regression checks passed");
