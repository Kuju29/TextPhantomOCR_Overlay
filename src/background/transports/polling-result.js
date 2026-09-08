export function pollFailure(record, status = "") {
  if (String(status) === "aborted" && record?.result && typeof record.result === "object")
    return { ...record.result, code: "cancelled", message: "cancelled", origin: "api", stage: "poll" };
  if (String(status) === "aborted") {
    return {
      code: "cancelled",
      message: "cancelled",
      origin: "api",
      stage: "poll",
    };
  }
  const raw = [record?.result, record?.error, record?.message].find(
    (value) =>
      value != null && (typeof value === "object" || String(value).trim()),
  );
  if (raw && typeof raw === "object") {
    if (raw.schema === "tp.error/1" || raw.tpError) return raw;
    if (raw.detail && typeof raw.detail === "object") return raw.detail;
    if (raw.error && typeof raw.error === "object") return raw.error;
    return raw;
  }
  if (String(raw || "").trim()) return String(raw).trim();
  return {
    code: "API_BAD_RESPONSE",
    message: "API job ended without structured error detail",
    origin: "api",
    stage: "response_validation",
  };
}
