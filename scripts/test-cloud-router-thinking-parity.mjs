import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";
import {
  concreteReasoningPreferences, reasoningOptionsForCapability, resolveReasoningPreference,
} from "../src/shared/reasoning-preference.js";

// Read the real API leaf map, then apply the actual Extension resolver. This
// catches a model option visible in one runtime but hidden in the other.
const source = `import json
from backend.ai.providers.cloud_together import _reasoning_capability
for model in ('Qwen/Qwen3.5-9B', 'zai-org/GLM-5.2', 'openai/gpt-oss-120b'):
    print(json.dumps({'model': model, 'capability': _reasoning_capability(model)}))
`;
const rows = execFileSync("python", ["-c", source], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PYTHONPATH: ["api", process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  encoding: "utf8",
}).trim().split("\n").map(JSON.parse);
for (const { model, capability: cap } of rows) {
  if (model === "openai/gpt-oss-120b") {
    assert.deepEqual(concreteReasoningPreferences(cap), ["low", "medium", "high"]);
    assert.equal(resolveReasoningPreference("minimum", cap), "low");
    continue;
  }
  assert.deepEqual(concreteReasoningPreferences(cap), ["off", "on"], model);
  assert.deepEqual(reasoningOptionsForCapability(cap).map(option => option.value),
    ["minimum", "off", "on"], model);
  assert.equal(resolveReasoningPreference("minimum", cap), "off", model);
  assert.equal(resolveReasoningPreference("on", cap), "on", model);
}
console.log("PASS Together API/Extension On, Off and Lowest capability parity (3 exact models)");
