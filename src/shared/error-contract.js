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
  API_UNREACHABLE:
    "เชื่อมต่อ API ไม่ได้—ตรวจว่าเปิดเซิร์ฟเวอร์แล้ว, URL ถูกต้อง และเบราว์เซอร์อนุญาตการเชื่อมต่อ",
  NET_TIMEOUT: "เซิร์ฟเวอร์ตอบช้าเกินเวลา กรุณาลองใหม่",
  CANCELLED: "ยกเลิกแล้ว",
  GATEWAY_502: "เซิร์ฟเวอร์ตัวกลางขัดข้องชั่วคราว (502)",
  API_5XX: "API ขัดข้องชั่วคราว",
  API_BAD_RESPONSE: "API ส่งข้อมูลกลับมาไม่ถูกต้อง",
  LENS_FAILED: "ระบบอ่านข้อความจากภาพขัดข้อง",
  GROUP_ORIENTATION_INVALID: "ข้อมูลตำแหน่งข้อความไม่พอสำหรับจัดวางส่วนที่แยกไว้ กรุณาลองอ่านข้อความจากภาพใหม่",
  GROUP_FAILED: "ระบบจัดกลุ่มข้อความขัดข้อง",
  AI_KEY_MISSING: "ยังไม่ได้ตั้งค่า API key [AI option > API key]",
  AI_PROVIDER_MISSING: "ยังไม่ได้เลือก Provider [AI option > Provider]",
  AI_MODEL_MISSING: "ยังไม่ได้เลือกโมเดล [AI option > Model]",
  AI_PROMPT_MISSING: "ยังไม่ได้ตั้งค่า AI Style [AI option > Set prompt]",
  API_URL_MISSING: "ยังไม่ได้ตั้งค่า TextPhantom API [Tools > Custom API URL]",
  AI_KEY_INVALID: "AI key ใช้งานไม่ได้",
  AI_RATE_LIMIT: "ผู้ให้บริการ AI จำกัดการใช้งานชั่วคราว",
  AI_QUOTA_EXHAUSTED:
    "โควตาหรือเครดิต AI หมด กรุณาเติมเครดิตหรือตรวจแผนการใช้งาน",
  AI_BILLING_REQUIRED: "ต้องตั้งค่าหรือชำระค่าบริการ AI ก่อนจึงจะใช้งานต่อได้",
  AI_CAPABILITY_CHANGED: "ข้อมูลความสามารถโมเดลเปลี่ยน กรุณารีเฟรชรายชื่อโมเดลก่อนแปล ยังไม่ได้เรียก AI",
  AI_MODEL_UNAVAILABLE: "โมเดล AI ที่เลือกใช้งานไม่ได้",
  AI_INCOMPLETE: "AI แปลได้ไม่ครบ—เก็บข้อความเดิมในส่วนที่ขาด",
  LOCAL_ENDPOINT_MISSING: "ยังไม่ได้ตั้งค่า URL ของ Local AI [AI option > Local server URL]",
  LOCAL_ENDPOINT_UNSAFE:
    "URL ของ Local AI ต้องเป็นเครื่องนี้หรือเครือข่ายส่วนตัว",
  LOCAL_UNREACHABLE:
    "เชื่อมต่อ Local AI ไม่ได้—ตรวจว่าเปิดโปรแกรม, URL และ CORS แล้ว",
  LOCAL_TIMEOUT: "Local AI ตอบช้าเกินเวลาที่กำหนด",
  LOCAL_MODEL_MISSING: "ยังไม่ได้เลือกโมเดล Local AI",
  LOCAL_MODEL_UNAVAILABLE: "โมเดล Local AI ที่เลือกใช้งานไม่ได้",
  LOCAL_INCOMPATIBLE: "Local AI ไม่รองรับ API รูปแบบที่เลือก",
  LOCAL_SERVER_ERROR: "โปรแกรม Local AI ขัดข้อง กรุณาตรวจ log ของโปรแกรม",
  LOCAL_BAD_RESPONSE: "Local AI ส่งข้อมูลกลับมาไม่ถูกต้อง",
  LOCAL_OUTPUT_INVALID: "Local AI แปลผลไม่ตรงรูปแบบที่ต้องใช้",
  LOCAL_THINKING_NO_ANSWER:
    "Local AI สร้างเฉพาะ Thinking แต่ยังไม่ส่งคำแปล—ลองปิด AI Thinking หรือลด Context",
  LOCAL_EXTENSION_ONLY: "Custom Local Adapter ใช้ได้เฉพาะโหมด Extension",
  LOCAL_REMOTE_API_ROUTE: "Local AI อยู่บนเครื่องนี้—กรุณาเลือกโหมด Extension",
  LOCAL_PROMPT_UNAVAILABLE:
    "โหลดคำสั่งแปลจาก TextPhantom API ไม่ได้—ตรวจการเชื่อมต่อ API แล้วลองใหม่",
  RENDER_FAILED: "สร้างข้อความทับภาพไม่สำเร็จ",
  INSERT_FAILED: "หน้าเว็บไม่รับข้อความแปล",
  SERVER_BUSY: "เซิร์ฟเวอร์ไม่ว่างชั่วคราว",
  REQUEST_REJECTED: "เซิร์ฟเวอร์ปฏิเสธคำขอนี้—ลองรีเฟรชหน้าเว็บแล้วสั่งใหม่",
  API_CAPS_UNAVAILABLE:
    "ตรวจสอบความสามารถของเซิร์ฟเวอร์ไม่สำเร็จ—เซิร์ฟเวอร์อาจกำลังเริ่มทำงาน ลองใหม่อีกครั้ง",
  API_STARTING: "API server กำลังเริ่มทำงานหรือยังไม่พร้อม กรุณาลองใหม่",
  API_CAPS_LEGACY: "API รุ่นนี้ไม่รองรับการตรวจสอบความสามารถ กรุณาอัปเดต API",
  API_HTTP_ERROR: "API ปฏิเสธการตรวจสอบความสามารถ กรุณาตรวจสถานะเซิร์ฟเวอร์",
  IMG_SOURCE_UNREACHABLE: "โหลดภาพจากเว็บไซต์ต้นทางไม่ได้",
  AI_UNREACHABLE: "เชื่อมต่อผู้ให้บริการ AI ไม่ได้ กรุณาลองใหม่",
  AI_TIMEOUT: "ผู้ให้บริการ AI ตอบช้าเกินเวลา กรุณาลองใหม่",
  AI_PROVIDER_ERROR: "ผู้ให้บริการ AI ปฏิเสธคำขอ—ตรวจ AI key และสิทธิ์ของบัญชี",
  AI_MODEL_NOT_FOUND: "ไม่พบโมเดลที่เลือกใน Provider",
  AI_MODEL_ACCESS_DENIED: "บัญชีนี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก",
  AI_CONTENT_BLOCKED: "Provider ปฏิเสธเนื้อหานี้",
  AI_ADAPTER_ERROR:
    "ตัวเชื่อม Provider ภายใน TextPhantom ไม่เข้ากัน—กรุณาอัปเดตระบบ",
  AI_PROVIDER_FAILED: "Provider ทำคำขอนี้ไม่สำเร็จ—ตรวจ Trace ID",
  AI_REQUEST_TOO_LARGE:
    "คำขอที่ส่งให้ AI มีขนาดใหญ่เกินขีดจำกัดของผู้ให้บริการ",
  AI_PROVIDER_UNSUPPORTED: "ยังไม่รองรับผู้ให้บริการ AI รายนี้",
  AI_STOPPED: "AI หยุดสร้างข้อความกลางคัน กรุณาลองใหม่",
  AI_OUTPUT_INVALID: "AI แปลผลไม่ตรงรูปแบบที่ต้องใช้",
  AI_ERASE_OWNERSHIP_INVALID: "ระบุกรอบลบข้อความให้ตรงกับคำแปลไม่ได้—เก็บภาพเดิมไว้เพื่อป้องกันลบผิดส่วน",
  AI_WRONG_LANGUAGE: "AI ตอบกลับเป็นภาษาที่ไม่ตรงกับภาษาที่เลือก",
  AI_NOT_CONFIGURED:
    "เซิร์ฟเวอร์ไม่มี AI key ให้ใช้—กรุณาใส่ AI key ของคุณเองในหน้าตั้งค่า",
  UNCLASSIFIED: "เกิดข้อผิดพลาดที่ระบบยังไม่มีคำอธิบาย",
});

const stageDefault = (stage) => {
  const normalized = String(stage || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (/^(?:lens|image_ocr)$/.test(normalized)) return "LENS_FAILED";
  if (normalized === "grouping") return "GROUP_FAILED";
  if (normalized === "render") return "RENDER_FAILED";
  if (normalized === "insert") return "INSERT_FAILED";
  if (/^(?:image_read|prefetch_datauri|prefetch_datauri_tab)$/.test(normalized))
    return "IMG_READ_FAILED";
  if (/^(?:ai|text)$/.test(normalized)) return "AI_FAILED";
  if (normalized === "ai_configuration") return "AI_CONFIGURATION_FAILED";
  if (/^context_menu_(?:all|single)$/.test(normalized)) return "COMMAND_FAILED";
  if (normalized === "capabilities") return "API_CAPS_UNAVAILABLE";
  if (normalized === "response_validation") return "API_BAD_RESPONSE";
  if (normalized === "http") return "HTTP_FAILED";
  if (normalized === "server_processing_lens_ai")
    return "SERVER_PROCESSING_FAILED";
  return "PROCESSING_FAILED";
};

const NATIVE_ERROR_CODES = Object.freeze({
  ReferenceError: "REFERENCE_ERROR",
  TypeError: "TYPE_ERROR",
  SyntaxError: "SYNTAX_ERROR",
  RangeError: "RANGE_ERROR",
  URIError: "URI_ERROR",
  EvalError: "EVAL_ERROR",
  AbortError: "CANCELLED",
  TimeoutError: "NET_TIMEOUT",
});

// Error codes cross into arbitrary web pages. Keep useful machine identifiers,
// but reject anything that could be a provider body, URL, credential or markup.
function safeMachineCode(value) {
  const code = String(value || "").trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(code)) return "";
  if (/^(?:unknown|unknown_error|error|undefined|null)$/i.test(code)) return "";
  if (
    /^(?:sk-|hf_|AIza|Bearer)/i.test(code) ||
    /(?:secret|password)/i.test(code)
  )
    return "";
  return code;
}

export function userMessageForCode(code) {
  const raw = String(code || "").trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const aliases = {
    no_text: "IMG_NO_TEXT",
    no_translatable_text: "IMG_NO_TEXT",
    image_read_failed: "IMG_READ_FAILED",
    image_fetch_failed: "IMG_READ_FAILED",
    image_blocked: "IMG_BLOCKED",
    invalid_image: "IMG_INVALID",
    image_too_large: "IMG_TOO_LARGE",
    network_error: "NET_OFFLINE",
    network_unreachable: "NET_OFFLINE",
    transport_error: "NET_OFFLINE",
    lens_transport_error: "LENS_FAILED",
    lens_upstream_failed: "LENS_FAILED",
    lens_session_unavailable: "LENS_FAILED",
    request_timeout: "NET_TIMEOUT",
    timeout: "NET_TIMEOUT",
    cancelled: "CANCELLED",
    bad_gateway: "GATEWAY_502",
    hosting_gateway_bad_gateway: "GATEWAY_502",
    gateway_502: "GATEWAY_502",
    internal_error: "API_5XX",
    api_error: "API_5XX",
    malformed_response: "API_BAD_RESPONSE",
    grouping_failed: "GROUP_FAILED",
    missing_api_key: "AI_KEY_MISSING",
    ai_provider_missing: "AI_PROVIDER_MISSING",
    ai_model_missing: "AI_MODEL_MISSING",
    ai_prompt_missing: "AI_PROMPT_MISSING",
    ai_prompt_required: "AI_PROMPT_MISSING",
    ai_profile_incomplete: "AI_PROVIDER_MISSING",
    ai_profile_invalid: "AI_PROVIDER_MISSING",
    ai_profile_migration_conflict: "AI_PROVIDER_MISSING",
    ai_profile_migration_incomplete: "AI_PROVIDER_MISSING",
    api_url_missing: "API_URL_MISSING",
    invalid_api_key: "AI_KEY_INVALID",
    provider_key_mismatch: "AI_KEY_INVALID",
    provider_rate_limited: "AI_RATE_LIMIT",
    provider_quota_exhausted: "AI_QUOTA_EXHAUSTED",
    billing_required: "AI_BILLING_REQUIRED",
    rate_gate_busy: "AI_RATE_LIMIT",
    local_rate_gate_busy: "AI_RATE_LIMIT",
    ai_output_capability_changed: "AI_CAPABILITY_CHANGED",
    model_unavailable: "AI_MODEL_UNAVAILABLE",
    missing_translation_units: "AI_INCOMPLETE",
    ai_endpoint_missing: "LOCAL_ENDPOINT_MISSING",
    local_endpoint_missing: "LOCAL_ENDPOINT_MISSING",
    invalid_local_endpoint: "LOCAL_ENDPOINT_UNSAFE",
    local_endpoint_not_private: "LOCAL_ENDPOINT_UNSAFE",
    local_ai_unreachable: "LOCAL_UNREACHABLE",
    local_connection_failed: "LOCAL_UNREACHABLE",
    local_cors_blocked: "LOCAL_UNREACHABLE",
    local_ai_timeout: "LOCAL_TIMEOUT",
    local_timeout: "LOCAL_TIMEOUT",
    local_model_missing: "LOCAL_MODEL_MISSING",
    local_model_not_found: "LOCAL_MODEL_UNAVAILABLE",
    local_ai_endpoint_incompatible: "LOCAL_INCOMPATIBLE",
    local_ai_http_error: "LOCAL_INCOMPATIBLE",
    local_ai_server_error: "LOCAL_SERVER_ERROR",
    local_models_http_error: "LOCAL_SERVER_ERROR",
    local_models_empty: "LOCAL_MODEL_MISSING",
    local_protocol_error: "LOCAL_INCOMPATIBLE",
    invalid_local_response: "LOCAL_BAD_RESPONSE",
    local_response_invalid: "LOCAL_BAD_RESPONSE",
    invalid_model_output: "AI_OUTPUT_INVALID",
    ai_erase_ownership_invalid: "AI_ERASE_OWNERSHIP_INVALID",
    repair_erase_conflict: "AI_ERASE_OWNERSHIP_INVALID",
    wrong_language_output: "AI_WRONG_LANGUAGE",
    orientation_unresolved: "GROUP_ORIENTATION_INVALID",
    local_ai_thinking_no_answer: "LOCAL_THINKING_NO_ANSWER",
    local_output_incomplete: "AI_INCOMPLETE",
    custom_local_extension_only: "LOCAL_EXTENSION_ONLY",
    local_ai_unreachable_from_remote_api: "LOCAL_REMOTE_API_ROUTE",
    local_prompt_unavailable: "LOCAL_PROMPT_UNAVAILABLE",
    ai_incomplete: "AI_INCOMPLETE",
    render_failed: "RENDER_FAILED",
    insert_failed: "INSERT_FAILED",
    server_busy: "SERVER_BUSY",
    // Codes the API emits today. Every one of these used to fall through to
    // UNKNOWN, which told the reader nothing while the real cause sat in the
    // `code` field right next to it.
    invalid_request: "REQUEST_REJECTED",
    service_unavailable: "API_5XX",
    api_caps_unavailable: "API_CAPS_UNAVAILABLE",
    api_unreachable: "API_UNREACHABLE",
    api_starting: "API_STARTING",
    api_caps_legacy: "API_CAPS_LEGACY",
    api_http_error: "API_HTTP_ERROR",
    lens_http_error: "LENS_FAILED",
    lens_invalid_response: "LENS_FAILED",
    image_fetch_failed: "IMG_SOURCE_UNREACHABLE",
    image_fetch_http_error: "IMG_SOURCE_UNREACHABLE",
    provider_transport: "AI_UNREACHABLE",
    provider_timeout: "AI_TIMEOUT",
    provider_http: "AI_PROVIDER_ERROR",
    unsupported_provider: "AI_PROVIDER_UNSUPPORTED",
    provider_auth_failed: "AI_KEY_INVALID",
    provider_payload_too_large: "AI_REQUEST_TOO_LARGE",
    provider_model_not_found: "AI_MODEL_NOT_FOUND",
    provider_model_access_denied: "AI_MODEL_ACCESS_DENIED",
    provider_content_blocked: "AI_CONTENT_BLOCKED",
    provider_client_contract_error: "AI_ADAPTER_ERROR",
    provider_adapter_error: "AI_ADAPTER_ERROR",
    internal_provider_adapter_error: "AI_ADAPTER_ERROR",
    provider_failed: "AI_PROVIDER_FAILED",
    generation_stopped: "AI_STOPPED",
    empty_output: "AI_STOPPED",
    invalid_output_contract: "AI_OUTPUT_INVALID",
    model_output_contract: "AI_OUTPUT_INVALID",
    local_ai_error: "LOCAL_SERVER_ERROR",
    incomplete_output: "AI_INCOMPLETE",
    ai_not_configured: "AI_NOT_CONFIGURED",
    unsafe_base_url: "LOCAL_ENDPOINT_UNSAFE",
  };
  return (
    USER_MESSAGES[raw] ||
    USER_MESSAGES[aliases[normalized]] ||
    USER_MESSAGES.UNCLASSIFIED
  );
}

function legacyCode(message, stage = "") {
  const m = String(message || "").toLowerCase();
  if (/cancel/.test(m)) return "CANCELLED";
  if (/timeout|timed out/.test(m)) return "NET_TIMEOUT";
  if (/failed to fetch|networkerror|network error|load failed/.test(m))
    return "NET_OFFLINE";
  if (/no text|no[_ -]?translatable/.test(m)) return "IMG_NO_TEXT";
  if (/no ai key|missing_api_key|api_key is required/.test(m))
    return "AI_KEY_MISSING";
  if (/invalid.*key|unauthorized/.test(m)) return "AI_KEY_INVALID";
  if (/rate.?limit|provider_rate_limited/.test(m)) return "AI_RATE_LIMIT";
  if (/model.*(?:unavailable|not found)/.test(m)) return "AI_MODEL_UNAVAILABLE";
  if (/incomplete|missing_translation_units/.test(m)) return "AI_INCOMPLETE";
  if (/no overlay data|expected json|returned a web page/.test(m))
    return "API_BAD_RESPONSE";
  if (/overlay insert|dom replace/.test(m)) return "INSERT_FAILED";
  if (/renderer|could not erase/.test(m)) return "RENDER_FAILED";
  if (/server busy|server_busy/.test(m)) return "SERVER_BUSY";
  return stageDefault(stage);
}

export function makeTpError(input = {}) {
  if (input?.tpError?.schema === TP_ERROR_SCHEMA) return input.tpError;
  const source = typeof input === "string" ? { message: input } : input || {};
  const status = Number(source.httpStatus ?? source.status) || 0;
  const stage = String(source.stage || source.failedStage || "unknown");
  let code = String(source.code || "").trim();
  const origin = String(source.origin || source.actor || "extension");
  if (!code && status === 502 && origin === "hosting_gateway")
    code = "GATEWAY_502";
  if (!code && status >= 500) code = "API_5XX";
  code = safeMachineCode(code);
  if (!code)
    code =
      NATIVE_ERROR_CODES[String(source.errorName || source.name || "")] ||
      legacyCode(source.message, stage);
  code = safeMachineCode(code) || stageDefault(stage);
  const retryable =
    typeof source.retryable === "boolean"
      ? source.retryable
      : code === "NET_OFFLINE" ||
        code === "NET_TIMEOUT" ||
        code === "GATEWAY_502" ||
        code === "API_5XX" ||
        code === "API_STARTING" ||
        code === "API_UNREACHABLE" ||
        code === "SERVER_BUSY";
  return Object.freeze({
    schema: TP_ERROR_SCHEMA,
    code,
    category: String(
      source.category || (code.startsWith("NET_") ? "network" : "processing"),
    ),
    origin,
    stage,
    httpStatus: status,
    upstreamStatus:
      Number(source.upstreamStatus ?? source.upstream_status) || 0,
    retryable,
    userMessage: userMessageForCode(code),
    diagnostic: String(source.diagnostic || source.message || "Unknown error")
      .replace(/\s+/g, " ")
      .slice(0, 500),
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
  const err =
    error instanceof Error
      ? error
      : new Error(String(error || input?.message || "Unknown error"));
  err.tpError = makeTpError({
    ...input,
    message: input.message || err.message,
  });
  for (const key of [
    "code",
    "stage",
    "origin",
    "httpStatus",
    "upstreamStatus",
    "retryable",
    "traceId",
    "requestId",
    "jobId",
    "batchId",
    "imageId",
    "correlationId",
  ]) {
    if (err.tpError[key] !== undefined) {
      try {
        err[key === "httpStatus" ? "status" : key] = err.tpError[key];
      } catch {
        /* DOMException fields may be readonly */
      }
    }
  }
  return err;
}

export function publicTpError(error, traceId = "") {
  const e = makeTpError(
    error instanceof Error
      ? {
          ...(error.tpError || {}),
          message: error.message,
          status: error.status,
          code: error.code,
          failedStage: error.failedStage,
          retryable: error.retryable,
          errorName: error.name,
          traceId: error.traceId || traceId,
        }
      : typeof error === "object"
        ? error?.tpError?.schema === TP_ERROR_SCHEMA
          ? {
              ...error.tpError,
              message: error?.message || error.tpError?.diagnostic,
              traceId: error.tpError?.traceId || traceId,
            }
          : { ...error, traceId: error?.traceId || traceId }
        : { message: error, traceId },
  );
  return {
    schema: e.schema,
    code: e.code,
    category: e.category,
    origin: e.origin,
    stage: e.stage,
    httpStatus: e.httpStatus,
    upstreamStatus: e.upstreamStatus,
    retryable: e.retryable,
    userMessage: e.userMessage,
    traceId: e.traceId || String(traceId || ""),
    requestId: e.requestId,
    jobId: e.jobId,
    batchId: e.batchId,
    imageId: e.imageId,
    correlationId: e.correlationId,
  };
}
