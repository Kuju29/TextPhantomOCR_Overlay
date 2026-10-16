// TextPhantom's stable cross-context error contract. Diagnostics stay in logs;
// only the short Thai message and support code are sent to page content.

const TP_ERROR_SCHEMA = "tp.error/1";

const USER_MESSAGES = Object.freeze({
  IMG_NO_TEXT: "ไม่พบข้อความในภาพ",
  IMG_READ_FAILED: "ส่วนขยายอ่านไฟล์ภาพไม่ได้",
  IMG_BLOCKED: "เว็บไซต์ไม่อนุญาตให้อ่านภาพนี้",
  IMG_INVALID: "ไฟล์นี้ไม่ใช่ภาพที่รองรับ",
  IMG_TOO_LARGE: "ภาพมีขนาดใหญ่เกินไป (API รับภาพได้ไม่เกิน 24 MiB)",
  SESSION_STORAGE_LIMIT: "พื้นที่ชั่วคราวของส่วนขยายเต็ม งานซ่อมแปลหยุดแล้ว—เก็บภาพและผลแปลเดิมไว้",
  CHECKPOINT_FAILED: "บันทึกสถานะงานแปลไม่ได้ งานซ่อมแปลหยุดแล้ว—เก็บภาพและผลแปลเดิมไว้",
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
  AI_KEY_MISSING: "ยังไม่ได้ตั้งค่า API key [AI settings > API key]",
  AI_PROVIDER_MISSING: "ยังไม่ได้เลือก Provider [AI settings > Provider]",
  AI_MODEL_MISSING: "ยังไม่ได้เลือกโมเดล [AI settings > Model]",
  AI_PROMPT_MISSING: "ยังไม่ได้ตั้งค่า AI Style [AI settings > Set prompt]",
  API_URL_MISSING: "ยังไม่ได้ตั้งค่า TextPhantom API [Tools > Custom API URL]",
  AI_KEY_INVALID: "AI key ใช้งานไม่ได้",
  AI_RATE_LIMIT: "ผู้ให้บริการ AI จำกัดการใช้งานชั่วคราว",
  AI_QUOTA_EXHAUSTED:
    "โควตาหรือเครดิต AI หมด กรุณาเติมเครดิตหรือตรวจแผนการใช้งาน",
  AI_BILLING_REQUIRED: "ต้องตั้งค่าหรือชำระค่าบริการ AI ก่อนจึงจะใช้งานต่อได้",
  AI_CAPABILITY_CHANGED: "ข้อมูลความสามารถโมเดลเปลี่ยน กรุณารีเฟรชรายชื่อโมเดลก่อนแปล ยังไม่ได้เรียก AI",
  AI_MODEL_UNAVAILABLE: "โมเดล AI ที่เลือกใช้งานไม่ได้",
  AI_INCOMPLETE: "AI แปลได้ไม่ครบ—เก็บข้อความเดิมในส่วนที่ขาด",
  LOCAL_ENDPOINT_MISSING: "ยังไม่ได้ตั้งค่า URL ของ Local AI [AI settings > Local server URL]",
  LOCAL_ENDPOINT_UNSAFE:
    "URL ของ Local AI ต้องเป็นเครื่องนี้หรือเครือข่ายส่วนตัว",
  LOCAL_UNREACHABLE:
    "เชื่อมต่อ Local AI ไม่ได้—ตรวจว่าเปิดโปรแกรม, URL และ CORS แล้ว",
  LOCAL_TIMEOUT: "Local AI ตอบช้าเกินเวลาที่กำหนด",
  LOCAL_MODEL_MISSING: "ยังไม่ได้เลือกโมเดล Local AI",
  LOCAL_MODEL_UNAVAILABLE: "โมเดล Local AI ที่เลือกใช้งานไม่ได้",
  LOCAL_MODEL_NOT_LOADED: "LM Studio ยังไม่ได้โหลดโมเดลที่เลือก กรุณาโหลดโมเดลนั้นแล้วรีเฟรชรายชื่อก่อนแปล",
  LOCAL_MODEL_LOADED_STATE_UNVERIFIED: "ตรวจโมเดลที่โหลดใน LM Studio ไม่ได้ กรุณาตรวจ native API ก่อนแปล",
  LOCAL_MODEL_CONTEXT_UNVERIFIED: "LM Studio ไม่รายงานขนาด Context ของโมเดลที่โหลด กรุณาโหลดใหม่แล้วรีเฟรช",
  LOCAL_MODEL_THINKING_UNSUPPORTED: "โมเดลที่เลือกปิด Thinking ไม่ได้ กรุณาเลือกโหมดที่รองรับหรือเปลี่ยนโมเดล",
  LOCAL_MODEL_IDENTITY_MISMATCH: "LM Studio ตอบกลับด้วยโมเดลคนละตัวกับที่เลือก—ตรวจโมเดลที่โหลดใน LM Studio แล้วเชื่อมต่อใหม่",
  LOCAL_MODEL_VERIFY_TIMEOUT: "โมเดล Local AI ไม่ตอบการตรวจสอบอัตโนมัติก่อนเริ่มงาน",
  LOCAL_MODEL_VERIFY_FAILED: "โมเดล Local AI ไม่ผ่านการตรวจสอบอัตโนมัติก่อนเริ่มงาน",
  LOCAL_MODEL_THINKING_REQUIRED: "โมเดล Local AI นี้ต้องเปิด AI Thinking ก่อนใช้งาน",
  LOCAL_ADAPTER_MISSING: "ไม่พบตัวเชื่อมของ Local AI ที่เลือก",
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
  AI_SOURCE_MAPPING_INVALID: "ข้อมูลจับคู่ข้อความสำหรับแปลไม่ถูกต้อง—ยังไม่ได้ส่งให้ AI กรุณาอัปเดต API และส่วนขยายคู่กัน",
  REQUEST_REJECTED: "เซิร์ฟเวอร์ปฏิเสธคำขอนี้—ลองรีเฟรชหน้าเว็บแล้วสั่งใหม่",
  API_CAPS_UNAVAILABLE:
    "ตรวจสอบความสามารถของเซิร์ฟเวอร์ไม่สำเร็จ—เซิร์ฟเวอร์อาจกำลังเริ่มทำงาน ลองใหม่อีกครั้ง",
  API_STARTING: "API server กำลังเริ่มทำงานหรือยังไม่พร้อม กรุณาลองใหม่",
  API_CAPS_LEGACY: "API รุ่นนี้ไม่รองรับการตรวจสอบความสามารถ กรุณาอัปเดต API",
  API_HTTP_ERROR: "API ปฏิเสธการตรวจสอบความสามารถ กรุณาตรวจสถานะเซิร์ฟเวอร์",
  IMG_SOURCE_UNREACHABLE: "โหลดภาพจากเว็บไซต์ต้นทางไม่ได้",
  AI_UNREACHABLE: "เชื่อมต่อผู้ให้บริการ AI ไม่ได้ กรุณาลองใหม่",
  AI_TIMEOUT: "ผู้ให้บริการ AI ตอบช้าเกินเวลา กรุณาลองใหม่",
  // Phase-aware stream stops (API stream_progress.py).
  AI_STALLED: "ผู้ให้บริการ AI หยุดตอบกลับ (ไม่มีการคิดหรือข้อความ) จึงหยุดคำขอนี้ กรุณาลองใหม่",
  AI_THINKING_TOO_LONG: "AI คิดนานเกินงบเวลาโดยยังไม่เริ่มตอบ ลองลดระดับการคิดหรือเลือกโมเดลที่เร็วกว่า",
  AI_OUTPUT_NO_PROGRESS: "AI เขียนต่อเนื่องแต่ไม่มีบรรทัดแปลใหม่เสร็จ จึงหยุดคำขอนี้ บรรทัดที่เสร็จแล้วยังถูกเก็บไว้",
  AI_STREAM_CEILING: "คำตอบของ AI ใช้เวลาเกินเพดานความปลอดภัย จึงหยุดคำขอนี้",
  AI_PROVIDER_ERROR: "ผู้ให้บริการ AI ไม่รับคำขอนี้—ตรวจรหัสอ้างอิงและ HTTP status ก่อนสรุปว่าเป็นปัญหาคีย์",
  AI_MODEL_NOT_FOUND: "ไม่พบโมเดลที่เลือกใน Provider",
  AI_MODEL_ACCESS_DENIED: "บัญชีนี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก",
  AI_REGION_UNSUPPORTED: "Provider ไม่ให้บริการในภูมิภาคของบัญชีนี้",
  AI_CONTENT_BLOCKED: "Provider ปฏิเสธเนื้อหานี้",
  AI_ADAPTER_ERROR:
    "ตัวเชื่อม Provider ภายใน TextPhantom ไม่เข้ากัน—กรุณาอัปเดตระบบ",
  AI_PROVIDER_FAILED: "Provider ทำคำขอนี้ไม่สำเร็จ—ตรวจ Trace ID",
  AI_REQUEST_TOO_LARGE:
    "คำขอที่ส่งให้ AI มีขนาดใหญ่เกินขีดจำกัดของผู้ให้บริการ",
  AI_WORKLOAD_BUDGET_INSUFFICIENT:
    "คำสั่งแปล ตัวอย่าง และพื้นที่คำตอบรวมกันเกิน Context ที่โมเดลใช้งาน—เพิ่ม Context (ถ้าเป็น Local AI ให้ปรับในโปรแกรม) หรือย่อคำสั่งแปล แล้วลองใหม่ ยังไม่ได้ส่งคำขอให้ AI",
  AI_PROVIDER_UNSUPPORTED: "ยังไม่รองรับผู้ให้บริการ AI รายนี้",
  AI_STOPPED: "AI หยุดสร้างข้อความกลางคัน กรุณาลองใหม่",
  AI_OUTPUT_INVALID: "AI แปลผลไม่ตรงรูปแบบที่ต้องใช้",
  AI_ERASE_OWNERSHIP_INVALID: "ระบุกรอบลบข้อความให้ตรงกับคำแปลไม่ได้—เก็บภาพเดิมไว้เพื่อป้องกันลบผิดส่วน",
  AI_WRONG_LANGUAGE: "AI ตอบกลับเป็นภาษาที่ไม่ตรงกับภาษาที่เลือก",
  AI_NOT_CONFIGURED:
    "เซิร์ฟเวอร์ไม่มี AI key ให้ใช้—กรุณาใส่ AI key ของคุณเองในหน้าตั้งค่า",
  PAID_DATABASE_UNAVAILABLE: "ฐานข้อมูล Center ขัดข้อง ยังยืนยันสถานะคำขอ Paid ไม่ได้ กรุณาตรวจคำขอเดิมและประวัติเครดิตก่อนเริ่มใหม่",
  PAID_CAPACITY_BUSY: "บริการ Paid มีคำขอเต็มจำนวนที่รองรับ ยังไม่ได้ส่งไป AI หรือจองเครดิต รอสักครู่แล้วเริ่มใหม่",
  PAID_PROVIDER_CAPACITY: "บริการ AI มีงานเต็มชั่วคราว กรุณาลองใหม่ภายหลัง ยอด TP ของคุณไม่ใช่สาเหตุ",
  PAID_PROVIDER_KEY_LIMIT: "บริการ Paid ไม่พร้อมรับคำขอขณะนี้ ยอดเครดิตของคุณไม่ได้เป็นสาเหตุ",
  PAID_PROVIDER_ROUTE: "โมเดล Paid นี้ไม่พร้อมใช้งาน กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
  PAID_PROVIDER_AUTH: "บริการ Paid ไม่พร้อมใช้งาน กรุณาติดต่อฝ่ายสนับสนุน",
  PAID_PROVIDER_BALANCE: "บริการ Paid ไม่พร้อมรับคำขอขณะนี้ ยอดเครดิตของคุณไม่ได้เป็นสาเหตุ",
  PAID_PROVIDER_FORBIDDEN: "บริการ Paid ไม่สามารถทำคำขอนี้ได้ กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
  PAID_PROVIDER_REQUEST: "บริการ Paid ไม่รับคำขอนี้ กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง",
  PAID_PROVIDER_LIMITED: "ผู้ให้บริการ AI จำกัดคำขอ Paid ชั่วคราว ตรวจคำขอเดิมก่อนลองใหม่",
  PAID_PROVIDER_FAILED: "บริการ Paid ทำคำขอนี้ไม่สำเร็จ กรุณาตรวจคำขอเดิมหรือติดต่อฝ่ายสนับสนุน",
  PAID_PENDING_CALLS: "มีงาน Paid ค้างอยู่ กรุณาตรวจประวัติของคุณก่อนเริ่มงานใหม่",
  PAID_OUTCOME_PENDING: "ผลหรือต้นทุน Paid ยังไม่ยืนยัน กรุณาตรวจคำขอเดิม ห้ามเริ่มซ้ำด้วยรหัสใหม่",
  PAID_ALREADY_DISPATCHED: "คำขอ Paid นี้ส่งไปแล้ว ตรวจประวัติก่อนเริ่มงานใหม่เพื่อป้องกันการหักซ้ำ",
  PAID_OPERATION_CONFLICT: "รหัสคำขอ Paid ถูกใช้กับข้อมูลอื่นแล้ว กรุณาตรวจคำขอเดิม",
  PAID_PRICE_UNVERIFIED: "ยังตรวจสอบราคาปัจจุบันของโมเดล Paid ไม่ได้ กรุณาลองใหม่หลังระบบอัปเดตราคา เครดิตของคุณยังคงอยู่",
  PAID_RECONCILIATION_REQUIRED: "คำขอ Paid เดิมอยู่ระหว่างตรวจสอบ กรุณาติดต่อฝ่ายสนับสนุน",
  PAID_LEDGER_UNAVAILABLE: "ยอดเครดิต Paid อยู่ระหว่างตรวจสอบ กรุณาติดต่อฝ่ายสนับสนุน",
  PAID_OUTPUT_INVALID: "AI ไม่คืนคำแปลที่ใช้ได้ ระบบคืนวงเงินลูกค้าและแจ้งผู้ดูแลแล้ว",
  PAID_RATE_LIMITED: "ส่งคำขอ Paid บ่อยเกินไป กรุณารอก่อนเริ่มคำขอใหม่",
  PAID_AI_NOT_CONFIGURED: "บริการแปล Paid ยังไม่เปิดใช้งาน",
  PAID_MODEL_PAUSED: "โมเดลนี้พักชั่วคราว เลือกโมเดลอื่นหรือลองใหม่ภายหลัง ยังไม่ส่ง AI หรือจองเครดิต",
  PAID_PAUSED: "บริการแปล Paid พักชั่วคราว กรุณาลองใหม่ภายหลัง",
  PAID_REFUND_PENDING: "พัก Paid ชั่วคราวระหว่างคำนวณและยืนยันคืนเงิน ยังเปิดดูบัญชีและประวัติได้",
  PAID_ACCOUNT_RESTRICTED: "บัญชีถูกระงับ Paid ระหว่างตรวจ refund/dispute กรุณาติดต่อผู้ดูแล ยังเปิดดูบัญชีและประวัติได้",
  PAID_LOGIN_REQUIRED: "กรุณาเข้าสู่บัญชี Paid และเลือกโมเดลที่ AI settings",
  // 10495: Paid/Login need data-use consent; the background opened the consent
  // tab. Nothing was sent or charged. (Same text as privacy-content.js pageBlocked.)
  DATA_CONSENT_REQUIRED: "ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว ยังไม่ได้ส่งคำขอและไม่หักเครดิต",
  // A running Paid/Login job stopped because data use was withdrawn.
  DATA_CONSENT_REVOKED: "ยกเลิกการอนุญาตข้อมูลแล้ว งานที่ใช้บัญชีหยุดแล้ว ผลที่แปลเสร็จยังอยู่",
  LOGIN_ADDON_REQUIRED: "สิทธิ์ AI Login ไม่พร้อมใช้งาน กรุณาตรวจแพ็กเสริมในบัญชี",
  LOGIN_SESSION_REQUIRED: "กรุณาเชื่อมต่อบัญชี AI Login และเลือกโมเดลก่อนแปล",
  LOGIN_SESSION_EXPIRED: "การเชื่อมต่อ AI Login หมดอายุ กรุณาเชื่อมต่อบัญชีใหม่",
  LOGIN_CONNECT_FAILED: "เชื่อมต่อบัญชี AI Login ไม่สำเร็จ ยังไม่ได้เริ่มแปล กรุณาเปิดหน้าต่าง TextPhantom › Login ดูเหตุผล แล้วกดเชื่อมต่อใหม่",
  LOGIN_CONNECT_FIRST_TIME: "ครั้งแรกให้เปิดหน้าต่าง TextPhantom › AI Login แล้วกด Connect หนึ่งครั้ง (เพื่ออนุญาตให้อ่านว่าบัญชีไหนล็อกอินอยู่) หลังจากนั้นเวลาแปล TextPhantom จะเชื่อมต่อให้เอง ยังไม่ได้ส่งอะไรออกไป",
  LOGIN_CONNECT_PENDING: "ยังเชื่อมต่อบัญชี AI Login ไม่เสร็จ ยังไม่ได้เริ่มแปล กรุณาเข้าสู่ระบบในแท็บที่เปิดขึ้นให้เสร็จ แล้วกดแปลอีกครั้ง",
  AI_PROFILE_SAVE_FAILED: "บันทึกค่า AI ไม่สำเร็จ ค่าที่แก้ยังรอบันทึก กรุณาลองบันทึกอีกครั้ง",
  REQUEST_RESULT_EXPIRED: "คำขอนี้ปิดยอดแล้ว แต่ผลชั่วคราวหมดอายุ ระบบไม่ได้ส่ง AI หรือหัก TP ซ้ำ",
  PAID_QUEUE_CANCELLED: "ยกเลิกงานก่อนส่ง AI และจอง TP แล้ว",
  LOGIN_MEMORY_STORAGE_UNAVAILABLE: "อ่านสถานะ AI Login ในเบราว์เซอร์ไม่ได้ กรุณาเปิดส่วนขยายใหม่แล้วลองอีกครั้ง",
  LOGIN_CHAT_CONTEXT_CHANGED: "บริบทบทสนทนา AI Login เปลี่ยน กรุณาเริ่มรอบแปลใหม่",
  LOGIN_CHAT_INSTRUCTIONS_CHANGED: "คำสั่งแปลของบทสนทนา AI Login เปลี่ยน กรุณาเริ่มรอบแปลใหม่",
  LOGIN_CHAT_MODEL_CHANGED: "โมเดลของบทสนทนา AI Login เปลี่ยน กรุณาเริ่มรอบแปลใหม่",
  LOGIN_CHAT_LOST: "ไม่พบบทสนทนา AI Login เดิม กรุณาตรวจการเชื่อมต่อแล้วเริ่มรอบใหม่",
  LOGIN_RUN_EXPIRED: "รอบแปล AI Login หมดอายุ กรุณาเริ่มรอบใหม่",
  LOGIN_SEND_AMBIGUOUS: "ยังยืนยันผลคำขอ AI Login เดิมไม่ได้ ระบบหยุดส่งซ้ำเพื่อป้องกันงานซ้ำ",
  LOGIN_TAB_CLOSED: "ปิดแท็บเข้าสู่บัญชีก่อนยืนยันการเชื่อมต่อ กรุณาเชื่อมต่อบัญชี AI อีกครั้ง",
  LOGIN_CANCELLED: "ยกเลิกรอบแปล AI Login แล้ว",
  LOGIN_UNAVAILABLE: "AI Login ไม่พร้อมใช้งาน กรุณารีเฟรชการเชื่อมต่อบัญชี",
  LOGIN_MODEL_UNAVAILABLE: "โมเดล AI Login ที่เลือกไม่พร้อมใช้งาน กรุณารีเฟรชรายชื่อโมเดล",
  LOGIN_MODEL_ACCESS_DENIED: "บัญชีบนเว็บไซต์ AI ใช้โมเดลที่เลือกไม่ได้ (อาจต้องอัปเกรดแพ็กเกจ) ยังไม่ได้ส่งอะไรออกไป · กรุณาเลือกโมเดลอื่นที่ AI settings › Model แล้วแปลใหม่",
  // The website answered 403. For a chat turn this is a model the plan cannot use.
  LOGIN_PROVIDER_ACCESS_DENIED: "เว็บไซต์ AI ไม่อนุญาตให้บัญชีนี้ใช้โมเดลที่เลือก (บางโมเดลต้องอัปเกรดแพ็กเกจ เช่น Pro/Max) · กรุณาเลือกโมเดลอื่นที่ AI settings › Model แล้วแปลใหม่ · ถ้าเลือกโมเดลอื่นแล้วยังขึ้นอีก ให้กด Reconnect",
  LOGIN_TRANSLATION_UNSUPPORTED: "ผู้ให้บริการ AI Login นี้ยังไม่รองรับการแปลและอยู่ระหว่างปรับปรุง คุณยังเข้าสู่บัญชีได้ กรุณาเลือกผู้ให้บริการที่พร้อมแปล",
  LOGIN_ENDPOINT_NATIVE_PREPARATION_REQUIRED: "บัญชี ChatGPT นี้ต้องเตรียมคำขอผ่านเบราว์เซอร์ก่อนแปล ยังไม่ได้ส่งคำขอสร้างคำแปล",
  LOGIN_ENDPOINT_NATIVE_PREPARATION_UNAVAILABLE: "เตรียมคำขอ ChatGPT ผ่าน API ไม่สำเร็จ ยังไม่ได้ส่งคำขอสร้างคำแปล",
  LOGIN_ENDPOINT_CHALLENGE_REQUIRED: "เว็บไซต์ AI ต้องการการยืนยันเพิ่มเติม กรุณาตรวจแท็บผู้ให้บริการแล้วเชื่อมต่อใหม่",
  LOGIN_QUOTA_EXCEEDED: "บัญชี AI Login ใช้ครบโควตาแล้วชั่วคราว กรุณาลองใหม่ภายหลังหรือเลือกโมเดลอื่น",
  LOGIN_WORK_TAB_CLOSED: "แท็บ claude.ai / chatgpt.com ที่ใช้แปลถูกปิดระหว่างแปล การแปลส่วนที่เหลือหยุดแล้ว · กดแปลอีกครั้งเพื่อให้ TextPhantom เปิดแท็บใหม่ (อย่าปิดแท็บนั้นระหว่างแปล)",
  AI_CONVERSATION_CAPACITY: "ที่เก็บประวัติบทสนทนา (Conversation) เต็ม และทุกเรื่องเพิ่งใช้ภายใน 1 ชั่วโมง ลองใหม่ภายหลัง ยังไม่ได้ส่งคำขอ AI",
  REPAIR_STORE_CAPACITY: "พื้นที่ซ่อมคำแปลบนเซิร์ฟเวอร์เต็มชั่วคราว ผลแปลเดิมยังอยู่ ลองใหม่ภายหลัง",
  QUEUE_CALLER_LIMIT: "แท็บนี้มีภาพรอแปลครบ 200 ภาพแล้ว จะรับภาพใหม่เมื่องานก่อนหน้าเสร็จ",
  // Per-install quotas of a shared API (429 + Retry-After / pool shares).
  IDENTITY_RATE_LIMITED: "เบราว์เซอร์นี้ส่งคำขอแปลถี่เกินโควตาของ API ที่ใช้ร่วมกัน ระบบรอและลองใหม่ให้แล้วแต่ยังไม่ผ่าน ยังไม่ได้ส่งงานนี้ กรุณารอสักครู่แล้วแปลใหม่",
  AI_CONVERSATION_IDENTITY_CAPACITY: "เบราว์เซอร์นี้เปิดบทสนทนา (Conversation) บน API ที่ใช้ร่วมกันครบจำนวนแล้ว ยังไม่ได้ส่งคำขอ AI รอให้งานเดิมจบแล้วลองใหม่",
  REPAIR_IDENTITY_CAPACITY: "เบราว์เซอร์นี้มีงานซ่อมคำแปลค้างบน API ที่ใช้ร่วมกันครบจำนวนแล้ว ผลแปลเดิมยังอยู่ รอให้งานเดิมจบแล้วลองใหม่",
  LOGIN_TAB_BUSY: "แท็บ ChatGPT ยังตอบข้อความอื่นอยู่ กรุณารอสักครู่แล้วลองใหม่",
  LOGIN_PROVIDER_NOT_READY: "แท็บ chatgpt.com ยังไม่พร้อม (เช่น ยังโหลดไม่เสร็จหรือไม่พบช่องพิมพ์) กรุณาเปิด/รีโหลดแท็บ chatgpt.com ปิดหน้าต่างที่บังอยู่ แล้วลองใหม่",
  LOGIN_ACCOUNT_CHANGED: "บัญชีผู้ให้บริการในเบราว์เซอร์เปลี่ยนไป กรุณาเชื่อมต่อบัญชี AI Login ใหม่",
  LOGIN_ENDPOINT_TIMEOUT: "เว็บไซต์ AI ตอบไม่ทันเวลา กรุณาเริ่มรอบแปลใหม่",
  LOGIN_ENDPOINT_TRANSPORT_FAILED: "ยืนยันคำตอบจากเว็บไซต์ AI ไม่ได้ ระบบจะไม่ส่งข้อความซ้ำเอง กรุณาเริ่มรอบแปลใหม่",
  LOGIN_IMAGE_UNSUPPORTED: "การเชื่อมต่อนี้ส่งภาพหน้าไม่ได้ กรุณาปิด Send page image to AI",
  LOGIN_BROWSER_RELAY_UNAVAILABLE: "ส่วนขยายใช้แท็บเว็บไซต์ AI (claude.ai / chatgpt.com) ในเบราว์เซอร์นี้ไม่ได้ กรุณาเปิดเบราว์เซอร์ค้างไว้ เข้าสู่ระบบเว็บไซต์นั้น แล้วลองใหม่",
  LOGIN_PROVIDER_REPLY_FAILED: "Gemini ส่งข้อความแจ้งข้อผิดพลาดแทนคำแปล รอบนี้หยุดแล้ว กรุณาลองใหม่ภายหลัง",
  // 10493: the website's own server failed (5xx, overloaded). Not TextPhantom or the account.
  LOGIN_PROVIDER_TEMPORARILY_UNAVAILABLE: "เซิร์ฟเวอร์ของเว็บไซต์ AI ที่เชื่อมต่อขัดข้องชั่วคราว ไม่ใช่ปัญหาของ TextPhantom หรือบัญชีของคุณ กรุณาลองใหม่ภายหลัง",
  LOGIN_ENDPOINT_RESPONSE_INVALID: "เว็บไซต์ AI ตอบกลับในรูปแบบที่ TextPhantom อ่านไม่ได้ รอบนี้หยุดแล้ว กรุณาเริ่มรอบแปลใหม่ ถ้าเกิดซ้ำให้ส่งรหัสอ้างอิงให้ฝ่ายสนับสนุน",
  LOGIN_ENDPOINT_REJECTED: "เว็บไซต์ AI ปฏิเสธคำขอนี้ รอบนี้หยุดแล้ว กรุณาเริ่มรอบแปลใหม่",
  PAID_CENTER_UPGRADE_REQUIRED: "API และ Center ของ Paid ใช้สัญญาคำขอคนละรุ่น กรุณาอัปเดตและเริ่ม Center ใหม่ ยังไม่ได้ส่ง AI หรือจอง TP เพิ่ม",
  PAID_REQUEST_INVALID: "Center ไม่รับรูปแบบคำขอ Paid นี้ ยังไม่ได้ส่ง AI หรือจอง TP เพิ่ม กรุณาติดต่อผู้ดูแลพร้อมรหัสอ้างอิง",
  PAID_CENTER_UNAVAILABLE: "บริการ Paid ไม่ตอบสนองชั่วคราว บัญชียังไม่ถูกออกจากระบบ กรุณาลองใหม่ภายหลัง",
  PAID_MODEL_NOT_ALLOWED: "โมเดล Paid นี้ไม่ได้เปิดให้บัญชีนี้ใช้ กรุณารีเฟรชโมเดลใน AI settings",
  PAID_INSUFFICIENT_CREDITS: "เครดิตไม่พอสำหรับภาพนี้ ยังไม่ได้ส่ง AI และไม่หักเครดิต เติมเครดิตแล้วแปลใหม่ได้",
  PAID_CREDITS_RESERVED: "เครดิตที่ใช้กับโมเดลนี้ถูกจองในคำขออื่นอยู่ รอปิดยอดหรือตรวจคำขอเดิม ยังไม่ได้ส่ง AI เพิ่ม",
  PAID_DAILY_BUDGET: "บริการ Paid พักรับคำขอชั่วคราว กรุณาลองใหม่ภายหลัง",
  PAID_BUSY: "บัญชี Paid มีงานค้างอยู่ กรุณาตรวจประวัติก่อนเริ่มงานใหม่",
  PAID_THINKING_UNSUPPORTED: "โมเดล Paid ไม่รองรับระดับ Thinking ที่เลือก กรุณาตรวจ AI thinking หรือเลือก Lowest available",
  PAID_THINKING_UNVERIFIED: "ยังตรวจสอบ Thinking ของโมเดล Paid นี้ไม่ได้ กรุณาติดต่อฝ่ายสนับสนุน",
  PAID_IMAGE_UNSUPPORTED: "โมเดล Paid ยังไม่รองรับหรือยังไม่ยืนยันการรับภาพ ปิด Send page image to AI หรือเลือกโมเดลที่รับภาพได้",
  PAID_IMAGE_INVALID: "ข้อมูลภาพสำหรับ Paid ไม่ถูกต้อง รับเฉพาะภาพนิ่ง PNG/JPEG/WebP/GIF แบบ base64",
  PAID_IMAGE_TOO_LARGE: "ภาพในคำขอ Paid นี้ใหญ่เกินขอบเขต กรุณาลดขนาดภาพ",
  PAID_PRICE_REFRESHING: "กำลังอัปเดตราคาช่องทาง Paid กรุณารอสักครู่ ยังไม่ได้ส่ง AI หรือจองเครดิต",
  PAID_PRICE_CHECK_UNAVAILABLE: "ตรวจราคาช่องทาง Paid ไม่สำเร็จ ยังไม่ได้ส่ง AI เพิ่มหรือจองเครดิต กรุณาตรวจคำขอเดิมอีกครั้งภายหลัง",
  PAID_ROUTE_UNAVAILABLE: "ยังไม่มีช่องทางที่ยืนยันราคาและรองรับตัวเลือก Paid นี้ ยังไม่ได้ส่ง AI หรือจองเครดิต",
  PAID_QUOTE_REQUIRED: "กรุณาเริ่มงานแปลใหม่เพื่อตรวจราคาปัจจุบัน ราคาที่ตรวจไว้ในงานเดิมไม่อยู่ในหน่วยความจำ ยังไม่ได้ส่ง AI เพิ่มหรือจองเครดิต",
  PAID_QUOTE_INVALID: "ข้อมูลราคา Paid ไม่ถูกต้อง กรุณาตรวจราคาอีกครั้ง ยังไม่ได้ส่ง AI หรือจองเครดิต",
  PAID_QUOTE_STALE: "ราคาหรือตัวเลือก Paid ที่ตรวจไว้เปลี่ยน กรุณาเริ่มงานใหม่เพื่อตรวจราคา ยังไม่ได้ส่ง AI เพิ่มหรือจองเครดิต",
  PAID_QUOTE_PRICE_CHANGED: "ราคาช่องทาง Paid เปลี่ยนจากที่ตรวจไว้ กรุณาเริ่มงานใหม่เพื่อตรวจราคา ยังไม่ได้ส่ง AI เพิ่มหรือจองเครดิต",
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
    repair_provider_cooldown: "AI_RATE_LIMIT",
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
    local_model_not_loaded: "LOCAL_MODEL_NOT_LOADED",
    local_model_loaded_state_unverified: "LOCAL_MODEL_LOADED_STATE_UNVERIFIED",
    local_model_context_unverified: "LOCAL_MODEL_CONTEXT_UNVERIFIED",
    local_model_thinking_unsupported: "LOCAL_MODEL_THINKING_UNSUPPORTED",
    local_model_identity_mismatch: "LOCAL_MODEL_IDENTITY_MISMATCH",
    local_model_verify_timeout: "LOCAL_MODEL_VERIFY_TIMEOUT",
    local_model_verify_failed: "LOCAL_MODEL_VERIFY_FAILED",
    local_model_thinking_required: "LOCAL_MODEL_THINKING_REQUIRED",
    local_adapter_missing: "LOCAL_ADAPTER_MISSING",
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
    // Codes the API emits, mapped so the reader sees the real cause instead of UNKNOWN.
    invalid_request: "REQUEST_REJECTED",
    ai_conversation_origin_invalid: "AI_SOURCE_MAPPING_INVALID",
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
    ai_provider_stalled: "AI_STALLED",
    ai_thinking_too_long: "AI_THINKING_TOO_LONG",
    ai_output_no_progress: "AI_OUTPUT_NO_PROGRESS",
    ai_stream_ceiling: "AI_STREAM_CEILING",
    provider_http: "AI_PROVIDER_ERROR",
    unsupported_provider: "AI_PROVIDER_UNSUPPORTED",
    provider_auth_failed: "AI_KEY_INVALID",
    provider_payload_too_large: "AI_REQUEST_TOO_LARGE",
    ai_workload_budget_insufficient: "AI_WORKLOAD_BUDGET_INSUFFICIENT",
    provider_model_not_found: "AI_MODEL_NOT_FOUND",
    provider_model_access_denied: "AI_MODEL_ACCESS_DENIED",
    provider_region_unsupported: "AI_REGION_UNSUPPORTED",
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
    USER_MESSAGES[normalized.toUpperCase()] ||
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

// Center: PAID_PROVIDER_CAPACITY is OpenRouter's in-flight budget being full
// for the moment ("wait for running work, then retry"; customer message
// "temporarily full, try again later"). It fails only its own request, even
// though Center reports the upstream 402 behind it (10491).
const TRANSIENT_PAID_CAPACITY = 'paid_provider_capacity';
const isTransientPaidCapacity = error => [error, error?.tpError, error?.diagnostics, error?.structuralDetails]
  .some(value => value && typeof value === 'object' && String(value.code || '').toLowerCase() === TRANSIENT_PAID_CAPACITY);
// A proven account payment/quota failure can fence unsent work. Do not treat
// ordinary 429 throttling, timeouts, malformed output or language defects as it.
export function isProviderBillingFailure(error) {
  if (isTransientPaidCapacity(error)) return false;
  return [error, error?.tpError, error?.diagnostics, error?.structuralDetails].some(value => {
    if (!value || typeof value !== 'object') return false;
    const code = String(value.failureKind || value.code || '').toLowerCase();
    return ['billing_required', 'ai_billing_required', 'provider_quota_exhausted', 'ai_quota_exhausted', 'paid_provider_key_limit', 'paid_provider_balance', 'paid_insufficient_credits'].includes(code) ||
      Number(value.upstreamStatus) === 402 || Number(value.httpStatus || value.status) === 402;
  });
}

export function providerBillingFenceCode(provider = "", error = null) {
  if (provider !== 'paid') return 'billing_required';
  for (const value of [error, error?.tpError, error?.diagnostics, error?.structuralDetails]) {
    const code = String(value?.code || '').toLowerCase();
    if (['paid_provider_key_limit', 'paid_provider_balance', 'paid_insufficient_credits'].includes(code)) return code;
  }
  return 'paid_insufficient_credits';
}
export function providerBillingFenceError(provider = "", error = null) {
  // A queued page did not make the failed provider request. In particular, do
  // not copy that request's usage, operation ID, attempts or diagnostics here.
  const paid = provider === 'paid';
  const code = providerBillingFenceCode(provider, error);
  return Object.assign(new Error(paid && code !== 'paid_insufficient_credits' ? 'Paid service unavailable; remaining work stopped' : paid ? 'Paid credits exhausted; remaining work stopped' : 'AI provider credits exhausted or payment required; unsent work stopped'), {
    code, failureKind:'billing_required', origin:'provider', stage:'ai',
    httpStatus:code === 'paid_provider_key_limit' ? 503 : code === 'paid_provider_balance' ? 502 : 402, retryable:false, requestDispatched:false,
    providerAttempts:0, generationAttempts:0, automaticContentRetry:false, automaticTransportRetry:false,
  });
}
