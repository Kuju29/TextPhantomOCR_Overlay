export class GroupingResultContractError extends Error {
  constructor(code, details = {}) {
    super(String(code));
    this.name = "GroupingResultContractError";
    this.code = String(code);
    this.details = { ...details };
  }
}

function fail(code, details) {
  throw new GroupingResultContractError(code, details);
}

function canonicalJsonValue(value, path = "$") {
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("raw_tree_not_canonical_json", {
      path, valueType: "nonfinite_float",
    });
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) fail("raw_tree_not_canonical_json", {
        path, valueType: "unsafe_integer",
      });
      return `i${Object.is(value, -0) ? 0 : value};`;
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, false);
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `d${hex};`;
  }
  if (Array.isArray(value)) {
    return `a[${value.map((item, index) =>
      canonicalJsonValue(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `o{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJsonValue(value[key], `${path}.${key}`)}`,
    ).join(",")}}`;
  }
  fail("raw_tree_not_canonical_json", {
    path, valueType: value?.constructor?.name || typeof value,
  });
}

function canonicalJson(value) {
  return canonicalJsonValue(value);
}

/** SHA-256 of the complete raw tree calculated in this runtime. */
export async function groupingTreeFingerprint(rawTree) {
  const bytes = new TextEncoder().encode(canonicalJson(rawTree));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
