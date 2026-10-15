import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";
import { thinkingRecordForSelection } from "../src/popup/controllers/popup-ui-controller.js";
import { renderThinkingControl, THINKING_STATE_LABELS } from "../src/popup/controllers/reasoning-select.js";
import { classifyThinkingState } from "../src/shared/thinking-state.js";

// 10493: the popup's AI think state for every Manual Cloud provider, fed by the
// real API resolve() output (scripts/test-manual-thinking-matrix-10493.py, HTTP
// mocked, no generation request). Checks the extension reaches the same state
// from the same catalogue, and that "default" / "loading" render as the
// disabled control with the saved preference untouched.
const rows = JSON.parse(execFileSync(process.env.PYTHON || "python",
  ["scripts/test-manual-thinking-matrix-10493.py", "--json"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PYTHONPATH: ["api", process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
    encoding: "utf8",
  }));

const select = () => ({ value: "minimum", disabled: false, dataset: {}, options: [] });
const seen = new Map();
for (const row of rows) {
  const record = thinkingRecordForSelection({
    local: false, provider: row.provider, model: row.model, credential: row.credential,
    resolved: row.resolve, resolvedCredential: row.credential,
  });
  const state = classifyThinkingState(record.reasoning, { fresh: record.fresh });
  assert.equal(state, row.state, `${row.provider} ${row.model} (${row.source})`);
  const el = select();
  renderThinkingControl(el, { state, reasoning: record.reasoning });
  assert.equal(el.value, "minimum", "the saved preference is never rewritten");
  assert.equal(el.disabled, state !== "controllable", `${row.provider} ${row.model} disabled`);
  if (state !== "controllable") assert.equal(el.options[0].textContent, THINKING_STATE_LABELS[state]);
  seen.set(`${row.provider} ${row.model} ${row.source === "catalogue unreachable" ? "failed" : "live"}`, state);
}
// A failed catalogue is "loading" (translation waits), never "default".
for (const [key, state] of seen) if (key.endsWith("failed")) assert.equal(state, "loading", key);
assert.equal(seen.get("huggingface vendor/hf-model live"), "default");
assert.equal(seen.get("openai gpt-5-mini live"), "default");
assert.equal(seen.get("openrouter vendor/thinker live"), "controllable");
// The resolve result for one model must not classify a different selection.
const hf = rows.find(row => row.provider === "huggingface" && row.state === "default");
const other = thinkingRecordForSelection({
  local: false, provider: "huggingface", model: "vendor/other", credential: hf.credential,
  resolved: hf.resolve, resolvedCredential: hf.credential,
});
assert.equal(classifyThinkingState(other.reasoning, { fresh: other.fresh }), "loading");
console.log(`PASS Manual AI think matrix 10493 (popup): ${rows.length} rows, ${new Set(rows.map(r => r.provider)).size} providers`);
