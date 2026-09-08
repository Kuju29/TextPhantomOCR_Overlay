import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rawTreeFingerprint } from "../src/background/pipeline/lens-direct.js";

const fixture = {
  paragraphs: [{
    id: "日本語-r0",
    bounds: [1.0, 2.5, 3.0, 4.125],
    items: [{ text: "漢字", vertices: [[0.0, 1.25], [2.0, 3.5]] }],
    nested: { scale: 1.0, confidence: 0.875 },
    // Real Lens values from the replay that exposed decimal-printer drift:
    // JS used fixed notation for the first two while Python used exponents.
    spans: [{ t0_raw: 4.5771398617944214e-06 },
      { t0_raw: 9.733258775668219e-05 },
      { t0_raw: 3.3414312383683864e-07 }],
  }],
};

const jsHash = await rawTreeFingerprint(fixture);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const apiRoot = resolve(projectRoot, "api");
const python = [
  "import json,sys",
  "from backend.grouping import raw_tree_fingerprint",
  // parse_float=float deliberately preserves integral-valued JSON floats as
  // Python floats, exercising the representation mismatch at the contract.
  "tree=json.loads(sys.stdin.read(), parse_float=float)",
  "print(raw_tree_fingerprint(tree))",
].join(";");
const pythonHash = execFileSync(process.env.PYTHON || "python", ["-c", python], {
  cwd: apiRoot,
  env: {
    ...process.env,
    PYTHONPATH: [apiRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  },
  input: JSON.stringify(fixture),
  encoding: "utf8",
}).trim();

assert.equal(
  jsHash,
  pythonHash,
  "tp.grouping-result/2 treeFingerprint must be identical for integral floats, fractional numbers, unicode and nested arrays",
);

await assert.rejects(
  rawTreeFingerprint({ value: Number.NaN }),
  (error) => error?.code === "raw_tree_not_canonical_json" &&
    error?.details?.valueType === "nonfinite_float",
  "non-finite numbers must fail instead of acquiring a platform spelling",
);

await assert.rejects(
  rawTreeFingerprint({ value: Number.MAX_SAFE_INTEGER + 1 }),
  (error) => error?.code === "raw_tree_not_canonical_json" &&
    error?.details?.valueType === "unsafe_integer",
  "integers that cannot cross the JS/Python boundary exactly must fail",
);

console.log("Grouping tree fingerprint is canonical across JavaScript and Python: PASS");
