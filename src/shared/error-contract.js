// TextPhantom's stable cross-context error contract. Diagnostics stay in logs;
// only the short Thai message and support code are sent to page content.

export const TP_ERROR_SCHEMA = "tp.error/1";

const USER_MESSAGES = Object.freeze({
  IMG_NO_TEXT: "ไม่พบข้อความในภาพ",
  IMG_READ_FAILED: "ส่วนขยายอ่านไฟล์ภาพไม่ได้",
  IMG_BLOCKED: "เว็บไซต์ไม่อนุญาตให้อ่านภาพนี้",
  IMG_INVALID: "ไฟล์นี้ไม่ใช่ภาพที่รองรับ",
  IMG_TOO_LARGE: "ภาพมีขนาดใหญ่เกินไป",
  NET_OFFLINE: "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจอินเทอร์เน็ต",
  NET_TIMEOUT: "เซิร์ฟเวอร์ตอบช้าเกินเวลา กรุณาลองใหม่",
  CANCELLED: "ยกเลิกแล้ว",
  GATEWAY_502: "เซิร์ฟเวอร์ตัวกลางขัดข้องชั่วคราว (502)",
  API_5XX: "API ขัดข้องชั่วคราว",
  API_BAD_RESPONSE: "API ส่งข้อมูลกลับมาไม่ถูกต้อง",
  LENS_FAILED: "ระบบอ่านข้อความจากภาพขัดข้อง",
  GROUP_FAILED: "ระบบจัดกลุ่มข้อความขัดข้อง",
  AI_KEY_MISSING: "ยังไม่ได้ตั้งค่า AI key",
  AI_KEY_INVALID: "AI key ใช้งานไม่ได้",
  AI_RATE_LIMIT: "ผู้ให้บริการ AI จำกัดการใช้งานชั่วคราว",
  AI_MODEL_UNAVAILABLE: "โมเดล AI ที่เลือกใช้งานไม่ได้",
  AI_INCOMPLETE: "AI แปลได้ไม่ครบ—เก็บข้อความเดิมในส่วนที่ขาด",
  RENDER_FAILED: "สร้างข้อความทับภาพไม่สำเร็จ",
  INSERT_FAILED: "หน้าเว็บไม่รับข้อความแปล",
  SERVER_BUSY: "เซิร์ฟเวอร์ไม่ว่างชั่วคราว",
  UNKNOWN: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ",
});

const stageDefault = (stage) => stage === "lens" ? "LENS_FAILED"
  : stage === "grouping" ? "GROUP_FAILED"
    : stage === "render" ? "RENDER_FAILED"
      : stage === "insert" ? "INSERT_FAILED" : "UNKNOWN";

export function userMessageForCode(code) {
  const raw = String(code || "").trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const aliases = {
    no_text: "IMG_NO_TEXT", no_translatable_text: "IMG_NO_TEXT",
    image_read_failed: "IMG_READ_FAILED", image_fetch_failed: "IMG_READ_FAILED",
    image_blocked: "IMG_BLOCKED", invalid_image: "IMG_INVALID", image_too_large: "IMG_TOO_LARGE",
    network_error: "NET_OFFLINE", network_unreachable: "NET_OFFLINE", transport_error: "NET_OFFLINE",
    lens_transport_error: "LENS_FAILED", lens_upstream_failed: "LENS_FAILED", lens_session_unavailable: "LENS_FAILED",
    request_timeout: "NET_TIMEOUT", timeout: "NET_TIMEOUT", cancelled: "CANCELLED",
    bad_gateway: "GATEWAY_502", hosting_gateway_bad_gateway: "GATEWAY_502", gateway_502: "GATEWAY_502",
    internal_error: "API_5XX", api_error: "API_5XX", malformed_response: "API_BAD_RESPONSE",
    grouping_failed: "GROUP_FAILED", onnx_failed: "GROUP_FAILED",
    missing_api_key: "AI_KEY_MISSING", invalid_api_key: "AI_KEY_INVALID",
    provider_key_mismatch: "AI_KEY_INVALID", provider_rate_limited: "AI_RATE_LIMIT",
    rate_gate_busy: "AI_RATE_LIMIT", local_rate_gate_busy: "AI_RATE_LIMIT",
    model_unavailable: "AI_MODEL_UNAVAILABLE", missing_translation_units: "AI_INCOMPLETE",
    ai_incomplete: "AI_INCOMPLETE", render_failed: "RENDER_FAILED", insert_failed: "INSERT_FAILED",
    server_busy: "SERVER_BUSY",
  };
  return USER_MESSAGES[raw] || USER_MESSAGES[aliases[normalized]] || USER_MESSAGES.UNKNOWN;
}

function legacyCode(message, stage = "") {
  const m = String(message || "").toLowerCase();
  if (/cancel/.test(m)) return "CANCELLED";
  if (/timeout|timed out/.test(m)) return "NET_TIMEOUT";
  if (/failed to fetch|networkerror|network error|load failed/.test(m)) return "NET_OFFLINE";
  if (/no text|no[_ -]?translatable/.test(m)) return "IMG_NO_TEXT";
  if (/no ai key|missing_api_key|api_key is required/.test(m)) return "AI_KEY_MISSING";
  if (/invalid.*key|unauthorized/.test(m)) return "AI_KEY_INVALID";
  if (/rate.?limit|provider_rate_limited/.test(m)) return "AI_RATE_LIMIT";
  if (/model.*(?:unavailable|not found)/.test(m)) return "AI_MODEL_UNAVAILABLE";
  if (/incomplete|missing_translation_units/.test(m)) return "AI_INCOMPLETE";
  if (/no overlay data|expected json|returned a web page/.test(m)) return "API_BAD_RESPONSE";
  if (/overlay insert|dom replace/.test(m)) return "INSERT_FAILED";
  if (/renderer|could not erase/.test(m)) return "RENDER_FAILED";
  if (/server busy|server_busy/.test(m)) return "SERVER_BUSY";
  return stageDefault(stage);
}

export function makeTpError(input = {}) {
  if (input?.tpError?.schema === TP_ERROR_SCHEMA) return input.tpError;
  const source = typeof input === "string" ? { message: input } : (input || {});
  const status = Number(source.httpStatus ?? source.status) || 0;
  const stage = String(source.stage || source.failedStage || "unknown");
  let code = String(source.code || "").trim();
  const origin = String(source.origin || source.actor || "extension");
  if (!code && status === 502 && origin === "hosting_gateway") code = "GATEWAY_502";
  if (!code && status >= 500) code = "API_5XX";
  if (!code) code = legacyCode(source.message, stage);
  const retryable = typeof source.retryable === "boolean"
    ? source.retryable : code === "NET_OFFLINE" || code === "NET_TIMEOUT" ||
      code === "GATEWAY_502" || code === "API_5XX" || code === "SERVER_BUSY";
  return Object.freeze({
    schema: TP_ERROR_SCHEMA,
    code,
    category: String(source.category || (code.startsWith("NET_") ? "network" : "processing")),
    origin,
    stage,
    httpStatus: status,
    upstreamStatus: Number(source.upstreamStatus ?? source.upstream_status) || 0,
    retryable,
    userMessage: userMessageForCode(code),
    diagnostic: String(source.diagnostic || source.message || "Unknown error").replace(/\s+/g, " ").slice(0, 500),
    traceId: String(source.traceId || ""),
    requestId: String(source.requestId || source.request_id || ""),
    jobId: String(source.jobId || source.job_id || ""),
    batchId: String(source.batchId || source.batch_id || ""),
    imageId: String(source.imageId || source.image_id || ""),
    correlationId: String(source.correlationId || source.correlation_id || ""),
    upstream: String(source.upstream || ""),
    generationAttempted: source.generationAttempted === true,
  });
}

export function attachTpError(error, input = {}) {
  const err = error instanceof Error ? error : new Error(String(error || input?.message || "Unknown error"));
  err.tpError = makeTpError({ ...input, message: input.message || err.message });
  for (const key of ["code", "stage", "origin", "httpStatus", "upstreamStatus", "retryable", "traceId",
    "requestId", "jobId", "batchId", "imageId", "correlationId"]) {
    if (err.tpError[key] !== undefined) {
      try { err[key === "httpStatus" ? "status" : key] = err.tpError[key]; } catch { /* DOMException fields may be readonly */ }
    }
  }
  return err;
}

export function publicTpError(error, traceId = "") {
  const e = makeTpError(error instanceof Error
    ? { ...(error.tpError || {}), message: error.message, status: error.status,
        code: error.code, failedStage: error.failedStage, retryable: error.retryable,
        traceId: error.traceId || traceId }
    : typeof error === "object" ? { ...error, traceId: error?.traceId || traceId }
      : { message: error, traceId });
  return {
    schema: e.schema, code: e.code, category: e.category, origin: e.origin,
    stage: e.stage, httpStatus: e.httpStatus, upstreamStatus: e.upstreamStatus, retryable: e.retryable,
    userMessage: e.userMessage, traceId: e.traceId || String(traceId || ""),
    requestId: e.requestId, jobId: e.jobId, batchId: e.batchId, imageId: e.imageId,
    correlationId: e.correlationId,
  };
}
