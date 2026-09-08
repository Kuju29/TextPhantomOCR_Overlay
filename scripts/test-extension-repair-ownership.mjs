import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const transport = await readFile(new URL("../src/background/ai/transports/server.js", import.meta.url), "utf8");
const route = await readFile(new URL("../api/backend/api/routes/ai_v1.py", import.meta.url), "utf8");
const application = (await Promise.all([
  "orchestration.py", "provider_execution.py", "request_validation.py",
].map((name) => readFile(new URL(`../api/backend/application/ai_translation/${name}`, import.meta.url), "utf8")))).join("\n");
const pipeline = await readFile(new URL("../api/backend/jobs/pipeline.py", import.meta.url), "utf8");
const imageFlow = await readFile(new URL("../api/backend/jobs/stages/image_flow.py", import.meta.url), "utf8");
const apiAiStage = await readFile(new URL("../api/backend/jobs/stages/ai_stage.py", import.meta.url), "utf8");
const apiRepair = await readFile(new URL("../api/backend/jobs/stages/ai_repair.py", import.meta.url), "utf8");
const apiConfig = await readFile(new URL("../api/backend/jobs/stages/config.py", import.meta.url), "utf8");
const aiContracts = await readFile(new URL("../api/backend/ai/translation/contracts.py", import.meta.url), "utf8");

assert.match(transport, /repair:\s*\{\s*owner:\s*"extension",\s*enabled:\s*false\s*\}/,
  "every extension-owned server AI generation must explicitly suppress backend repair");
assert.match(route, /return await execute\(request, payload, idempotency_key\)/,
  "the HTTP route must delegate repair policy to the application service");
assert.match(application, /repair_enabled=not ai_request\.extension_owns_repair\(payload\)/,
  "the application service must consume the explicit ownership contract");
assert.match(application, /return translate\(/,
  "the extension application service must dispatch exactly one backend translation call");
assert.doesNotMatch(route, /_translate_with_one_repair\(/,
  "the extension HTTP route must never invoke the backend repair orchestrator");
assert.doesNotMatch(application, /_translate_with_one_repair\(/,
  "the extension application service must never invoke the backend repair orchestrator");
assert.match(apiAiStage, /ai_repair\.translate_with_one_repair\(/,
  "runs:API AI stage must retain validation and partial-result handling");
assert.match(apiAiStage, /ai_cfg\.repair_enabled = False/,
  "runs:API stage must defensively enforce one provider generation per image");
assert.match(pipeline, /from backend\.jobs\.stages\.image_flow import process_image/,
  "runs:API pipeline must remain wired to the extracted image flow");
assert.match(imageFlow, /from backend\.jobs\.stages import ai_stage/,
  "runs:API image flow must remain wired to the AI stage that owns repair dispatch");
assert.match(apiRepair, /def translate_with_one_repair\(/,
  "the API repair stage must retain the bounded repair orchestrator");
assert.match(apiRepair, /getattr\(config, "repair_enabled", True\) is False/,
  "backend validator must return an attributable partial when repair is disabled");
assert.match(apiConfig, /repair_enabled=False/,
  "runs:API request configuration must not allow a client to enable repair");
assert.match(aiContracts, /repair_enabled:\s*bool\s*=\s*False/,
  "AI configuration must default to the one-generation policy");

console.log("AI request ownership passed: Extension and runs:API both enforce one generation per image.");
