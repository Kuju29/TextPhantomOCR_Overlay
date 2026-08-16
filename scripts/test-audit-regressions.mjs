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
