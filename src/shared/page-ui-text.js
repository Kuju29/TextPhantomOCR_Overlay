// Copy TextPhantom draws into web pages (toasts, badges, panels, buttons) and
// the browser context menu. Extension pages translate their authored copy with
// shared/ui-language.js; web pages and the service worker cannot run that
// controller, so the Thai for this copy is authored here. English stays the
// source and the fallback; Thai is used only when the interface language
// selected in the popup (uiLanguageV1) is Thai. {name} values are inserted
// unchanged.
(function (root) {
  if (root.TPPageText) return;
  const KEY = "uiLanguageV1";
  const TH = Object.freeze({
    // Context menu and in-page buttons.
    "🔍 Translate this image": "🔍 แปลภาพนี้",
    "🔍 Translate all images on page": "🔍 แปลภาพทั้งหมดในหน้านี้",
    "Open TextPhantom": "เปิด TextPhantom",
    // 10495: data-use consent missing (Paid, Login, chat): the consent tab was
    // opened, nothing was sent. Same Thai as shared/privacy-content.js.
    "Allow data use first. A permission tab is open. Nothing was sent and no credits were used.":
      "ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว ยังไม่ได้ส่งคำขอและไม่หักเครดิต",
    "Data use was turned off. Account work stopped; finished translations stay.":
      "ยกเลิกการอนุญาตข้อมูลแล้ว งานที่ใช้บัญชีหยุดแล้ว ผลที่แปลเสร็จยังอยู่",
    "Open translation controls": "เปิดปุ่มควบคุมการแปล",
    "🔍 Translate all": "🔍 แปลทั้งหน้า",
    "Translate all images on this page": "แปลภาพทั้งหมดในหน้านี้",
    "⏳ Finding images": "⏳ กำลังหาภาพ",
    "Cannot start translation": "เริ่มแปลไม่ได้",
    "Translate this image": "แปลภาพนี้",
    "Translate this image (TextPhantom)": "แปลภาพนี้ (TextPhantom)",
    "translate failed": "แปลไม่สำเร็จ",
    "Show TextPhantom details": "แสดงรายละเอียด TextPhantom",
    "Hide TextPhantom details": "ซ่อนรายละเอียด TextPhantom",
    // Toasts sent by the background (shown after the "TextPhantom: " prefix).
    "checking the selected Local AI model…": "กำลังตรวจโมเดล Local AI ที่เลือก…",
    "collecting images…": "กำลังรวบรวมภาพ…",
    "processing…": "กำลังประมวลผล…",
    "loading MangaDex pages…": "กำลังโหลดหน้า MangaDex…",
    "discovering images…": "กำลังค้นหาภาพ…",
    "couldn’t read the local image file. Refresh the page and right-click to translate again.":
      "อ่านไฟล์ภาพในเครื่องไม่ได้ กรุณารีเฟรชหน้าแล้วคลิกขวาเพื่อแปลอีกครั้ง",
    "enable “Allow access to file URLs” for the extension first (chrome://extensions → TextPhantom → Details), then refresh the image page.":
      "กรุณาเปิด “Allow access to file URLs” ให้ส่วนขยายก่อน (chrome://extensions → TextPhantom → Details) แล้วรีเฟรชหน้าภาพ",
    "TextPhantom: enable \"Allow access to file URLs\" in chrome://extensions to translate local images":
      "TextPhantom: เปิด \"Allow access to file URLs\" ใน chrome://extensions เพื่อแปลภาพในเครื่อง",
    "Translation completion failed; check the image errors": "แปลไม่ครบ กรุณาตรวจข้อผิดพลาดบนภาพ",
    // Batch stages shown before any image is listed.
    "Collecting": "กำลังรวบรวมภาพ",
    "Discovering images": "กำลังค้นหาภาพ",
    "Cancelled": "ยกเลิกแล้ว",
    "Cancelled: not enough credits. Nothing was sent or charged.": "ยกเลิกแล้ว: เครดิตไม่พอ ยังไม่ได้ส่งหรือหักเครดิต",
    "No eligible images": "ไม่มีภาพที่แปลได้",
    "Starting retry pass": "กำลังเริ่มลองแปลซ้ำ",
    "Retrying {count} failed image(s) shortly": "จะลองแปลภาพที่ไม่สำเร็จ {count} ภาพอีกครั้งในไม่ช้า",
    // Image badges and short image errors.
    "No translatable text": "ไม่มีข้อความที่ต้องแปล",
    "No text": "ไม่มีข้อความ",
    "AI rate limit": "AI จำกัดการใช้งานชั่วคราว",
    "No AI key": "ยังไม่มี AI key",
    "AI model unavailable": "โมเดล AI ใช้งานไม่ได้",
    "AI output unavailable": "ไม่มีผลแปลจาก AI",
    "Text grouping failed": "จัดกลุ่มข้อความไม่สำเร็จ",
    "No text found": "ไม่พบข้อความ",
    "AI provider/key mismatch": "AI key ไม่ตรงกับ Provider",
    "AI key invalid": "AI key ใช้งานไม่ได้",
    "AI provider rate limit": "ผู้ให้บริการ AI จำกัดการใช้งานชั่วคราว",
    "Lens OCR failed": "Lens อ่านข้อความไม่สำเร็จ",
    "AI translation incomplete": "AI แปลไม่ครบ",
    "Could not place translation": "วางคำแปลบนภาพไม่ได้",
    "Request timed out": "คำขอหมดเวลา",
    "Server busy": "เซิร์ฟเวอร์ไม่ว่าง",
    // Login website server failure (10493); the API names the website.
    "DeepSeek's server is temporarily unavailable. Try again later.": "เซิร์ฟเวอร์ของ DeepSeek ขัดข้องชั่วคราว ลองใหม่ภายหลัง",
    "Claude's server is temporarily unavailable. Try again later.": "เซิร์ฟเวอร์ของ Claude ขัดข้องชั่วคราว ลองใหม่ภายหลัง",
    "ChatGPT's server is temporarily unavailable. Try again later.": "เซิร์ฟเวอร์ของ ChatGPT ขัดข้องชั่วคราว ลองใหม่ภายหลัง",
    "Gemini's server is temporarily unavailable. Try again later.": "เซิร์ฟเวอร์ของ Gemini ขัดข้องชั่วคราว ลองใหม่ภายหลัง",
    "The AI website's server is temporarily unavailable. Try again later.": "เซิร์ฟเวอร์ของเว็บไซต์ AI ขัดข้องชั่วคราว ลองใหม่ภายหลัง",
    "Failed to load replaced image": "โหลดภาพที่แปลแล้วไม่สำเร็จ",
    // Progress board.
    "TextPhantom: inserted {inserted}/{total}": "TextPhantom: แทรกแล้ว {inserted}/{total}",
    "cancelled": "ยกเลิกแล้ว",
    "processing complete · {done}/{total} pages processed": "ประมวลผลเสร็จ · {done}/{total} หน้า",
    "processing complete · {done}/{total} pages processed · {count} saved for display":
      "ประมวลผลเสร็จ · {done}/{total} หน้า · เก็บไว้รอแสดง {count} หน้า",
    "Lens reading text {done}/{total}": "Lens กำลังอ่านข้อความ {done}/{total}",
    "Lens reading text {done}/{total} · Lens queue {count}": "Lens กำลังอ่านข้อความ {done}/{total} · คิว Lens {count}",
    "Lens waiting {count} · {done}/{total}": "Lens รอ {count} · {done}/{total}",
    "Group grouping text {done}/{total}": "กำลังจัดกลุ่มข้อความ {done}/{total}",
    "Group grouping text {done}/{total} · Group queue {count}": "กำลังจัดกลุ่มข้อความ {done}/{total} · คิวจัดกลุ่ม {count}",
    "Group waiting {count} · {done}/{total}": "รอจัดกลุ่ม {count} · {done}/{total}",
    "Repair complete {done}/{total}": "ซ่อมคำแปลเสร็จ {done}/{total}",
    "Repair complete {done}/{total} · unresolved {count}": "ซ่อมคำแปลเสร็จ {done}/{total} · ยังแก้ไม่ได้ {count}",
    "Repair translated {done}/{total}": "ซ่อมคำแปลแล้ว {done}/{total}",
    "Repair translated {done}/{total} · {count} unit(s) ready when displayed":
      "ซ่อมคำแปลแล้ว {done}/{total} · {count} ส่วนพร้อมแสดงเมื่อเลื่อนถึง",
    "Repair waiting · {done}/{total} fixed": "งานซ่อมกำลังรอ · แก้แล้ว {done}/{total}",
    "Repair active · {done}/{total} fixed": "กำลังซ่อมคำแปล · แก้แล้ว {done}/{total}",
    "AI waiting for slot {count}p": "AI รอคิว {count} หน้า",
    "AI reply complete · delivering page results": "AI ตอบครบแล้ว · กำลังส่งผลให้แต่ละหน้า",
    "AI request {function}": "คำขอ AI {function}",
    "AI {function}": "AI {function}",
    // Pages of the AI request the status counts belong to.
    " (page {pages})": " (หน้า {pages})",
    " (pages {pages})": " (หน้า {pages})",
    " (1 page)": " (1 หน้า)",
    " ({count} pages)": " ({count} หน้า)",
    // The shared API limited this browser install; the work goes on by itself.
    "Server busy — waiting {seconds}s before continuing": "เซิร์ฟเวอร์มีคนใช้เยอะ — รอ {seconds} วิ แล้วทำต่อให้อัตโนมัติ",
    " · queue {count}p": " · คิว {count} หน้า",
    "queue {time}": "รอคิว {time}",
    "Insert placing {count}p": "กำลังแทรก {count} หน้า",
    "Insert placing {count}p · Insert queue {queue}": "กำลังแทรก {count} หน้า · คิวแทรก {queue}",
    "Insert waiting {count}p": "รอแทรก {count} หน้า",
    "skip {count}": "ข้าม {count}",
    "error {count}": "ผิดพลาด {count}",
    "cancel {count}": "ยกเลิก {count}",
    "AI finished in {time}": "AI เสร็จใน {time}",
    "done {time}": "เสร็จใน {time}",
    "waiting for slot": "รอคิว",
    "preparing request": "กำลังเตรียมคำขอ",
    "sending request": "กำลังส่งคำขอ",
    "waiting for response text": "รอข้อความตอบกลับ",
    "generating · receiving text": "กำลังสร้าง · รับข้อความ",
    "waiting for final usage": "รอสรุปการใช้งาน",
    "waiting response": "รอคำตอบ",
    "receiving response": "กำลังรับคำตอบ",
    "validating result": "กำลังตรวจผล",
    "connecting": "กำลังเชื่อมต่อ",
    "waiting for model": "รอโมเดล",
    "thinking": "กำลังคิด",
    "recovering context": "กำลังกู้บริบท",
    "preparing next turn": "กำลังเตรียมรอบถัดไป",
    "repair waiting for batch": "งานซ่อมรอชุดงาน",
    "preparing repair": "กำลังเตรียมซ่อมคำแปล",
    "repair waiting response": "งานซ่อมรอคำตอบ",
    "server processing": "เซิร์ฟเวอร์กำลังประมวลผล",
    "repair waiting": "งานซ่อมกำลังรอ",
    "repairing": "กำลังซ่อมคำแปล",
    "working": "กำลังทำงาน",
    "Show per-image TextPhantom progress": "แสดงความคืบหน้า TextPhantom รายภาพ",
    "Hide per-image TextPhantom progress": "ซ่อนความคืบหน้า TextPhantom รายภาพ",
    "Page": "หน้า",
    "Total": "รวม",
    "Lens": "Lens",
    "Group": "จัดกลุ่ม",
    "AI / queue": "AI / คิว",
    "Insert": "แทรก",
    "Result": "ผล",
    "✓ done": "✓ เสร็จ",
    "✕ error": "✕ ผิดพลาด",
    "skip": "ข้าม",
    "cancel": "ยกเลิก",
    "Image": "ภาพ",
    "Reading text": "กำลังอ่านข้อความ",
    "Reading text with Lens": "Lens กำลังอ่านข้อความ",
    "Waiting to group text": "รอจัดกลุ่มข้อความ",
    "Grouping text": "กำลังจัดกลุ่มข้อความ",
    "Response opened · waiting for text": "เปิดการตอบกลับแล้ว · รอข้อความ",
    "AI is generating · receiving text": "AI กำลังสร้างคำแปล · รับข้อความ",
    // Download panel.
    "Download images": "ดาวน์โหลดภาพ",
    "Download images · TextPhantom": "ดาวน์โหลดภาพ · TextPhantom",
    "Open download images": "เปิดดาวน์โหลดภาพ",
    "Minimize download images": "ย่อดาวน์โหลดภาพ",
    "Minimize download panel": "ย่อแผงดาวน์โหลด",
    "Minimize — does not cancel downloads": "ย่อ — ไม่ยกเลิกการดาวน์โหลด",
    "Existing images only. No new translation.": "เฉพาะภาพที่มีอยู่แล้ว ไม่แปลใหม่",
    "Download type": "ประเภทที่ดาวน์โหลด",
    "Translated": "ฉบับแปล",
    "Text removed": "ลบข้อความแล้ว",
    "Original": "ต้นฉบับ",
    "Requires an existing cleaned background from a Text overlay": "ต้องมีพื้นหลังที่ลบข้อความแล้วจาก Text overlay",
    "Refresh existing image list": "รีเฟรชรายการภาพที่มีอยู่",
    "Refresh": "รีเฟรช",
    "Image format": "รูปแบบภาพ",
    "Auto · current default": "อัตโนมัติ · ค่าเริ่มต้นปัจจุบัน",
    "JPEG (.jpg)": "JPEG (.jpg)",
    "Quality": "คุณภาพ",
    "Image quality": "คุณภาพภาพ",
    "Cancel": "ยกเลิก",
    "Individual images": "ภาพทีละไฟล์",
    "Current document · refresh after scrolling to load more": "หน้าปัจจุบัน · เลื่อนหน้าให้ภาพโหลดเพิ่มแล้วกดรีเฟรช",
    "Could not read image list": "อ่านรายการภาพไม่ได้",
    "Saving…": "กำลังบันทึก…",
    "Saved in this browser": "บันทึกไว้ในเบราว์เซอร์นี้แล้ว",
    "Could not save settings. Try changing the option again.": "บันทึกการตั้งค่าไม่สำเร็จ ลองเปลี่ยนตัวเลือกอีกครั้ง",
    "{count} image available": "มีภาพ {count} ภาพ",
    "{count} images available": "มีภาพ {count} ภาพ",
    "Download all · ZIP ({count})": "ดาวน์โหลดทั้งหมด · ZIP ({count})",
    "Default: Text overlays → PNG; other images keep their existing format.":
      "ค่าเริ่มต้น: ภาพแบบ Text overlay → PNG ส่วนภาพอื่นใช้รูปแบบไฟล์เดิม",
    "JPEG: transparent areas become white. Converted animations use one frame.":
      "JPEG: พื้นที่โปร่งใสจะเป็นสีขาว ภาพเคลื่อนไหวที่แปลงจะเหลือเฟรมเดียว",
    "WebP: quality controls file size. Converted animations use one frame.":
      "WebP: ค่าคุณภาพกำหนดขนาดไฟล์ ภาพเคลื่อนไหวที่แปลงจะเหลือเฟรมเดียว",
    "PNG: lossless image encoding. Converted animations use one frame.":
      "PNG: บันทึกแบบไม่เสียคุณภาพ ภาพเคลื่อนไหวที่แปลงจะเหลือเฟรมเดียว",
    "Existing Text and Image translations.": "คำแปลแบบ Text และ Image ที่มีอยู่แล้ว",
    "Overlay font size {size}% · matches v1.2 export.": "ขนาดตัวอักษรคำแปล {size}% · ตรงกับการส่งออก v1.2",
    "Existing cleaned Text-overlay backgrounds only.": "เฉพาะพื้นหลังที่ลบข้อความแล้วจาก Text overlay ที่มีอยู่",
    "No new erasing or processing.": "ไม่ลบข้อความหรือประมวลผลใหม่",
    "Original sources in this document, not translated layers.": "ไฟล์ต้นฉบับในหน้านี้ ไม่รวมชั้นคำแปล",
    "Lazy sources are read without changing the page.": "ภาพที่ยังไม่โหลดจะถูกอ่านโดยไม่เปลี่ยนหน้าเว็บ",
    "No images available for this type.": "ไม่มีภาพสำหรับประเภทนี้",
    "source format": "รูปแบบต้นฉบับ",
    "Text background": "พื้นหลังข้อความ",
    "Image translation": "ภาพแปล",
    "Text overlay": "ข้อความทับภาพ",
    "Page {number}": "หน้า {number}",
    "translated": "ฉบับแปล",
    "clean": "ลบข้อความแล้ว",
    "original": "ต้นฉบับ",
    "Download {kind} {page}": "ดาวน์โหลด{kind} {page}",
    "{count} original source unavailable · not included": "ต้นฉบับ {count} ภาพใช้ไม่ได้ · ไม่ได้รวมไว้",
    "{count} original sources unavailable · not included": "ต้นฉบับ {count} ภาพใช้ไม่ได้ · ไม่ได้รวมไว้",
    "Cancelling download": "กำลังยกเลิกการดาวน์โหลด",
    "No unfinished ZIP will be saved. Translation is not affected.": "จะไม่บันทึก ZIP ที่ยังไม่เสร็จ การแปลไม่ได้รับผลกระทบ",
    "Preparing ZIP": "กำลังเตรียม ZIP",
    "Preparing image": "กำลังเตรียมภาพ",
    "Only existing image sources are read.": "อ่านเฉพาะภาพที่มีอยู่แล้วเท่านั้น",
    "Finalizing ZIP": "กำลังปิดไฟล์ ZIP",
    "Adding to ZIP {index} / {total}": "กำลังเพิ่มลง ZIP {index} / {total}",
    "Preparing {index} / {total}": "กำลังเตรียม {index} / {total}",
    "One archive will be sent to the browser.": "จะส่งไฟล์ ZIP หนึ่งไฟล์ให้เบราว์เซอร์",
    "Page {number}: {error}": "หน้า {number}: {error}",
    "1 ZIP handed to your browser · {done} / {total} images included.": "ส่ง ZIP 1 ไฟล์ให้เบราว์เซอร์แล้ว · รวม {done} / {total} ภาพ",
    "0 / {total} images available. No ZIP was saved.": "มีภาพที่ใช้ได้ 0 / {total} ภาพ ไม่ได้บันทึก ZIP",
    "{done} / {total} file handed to your browser.": "ส่งไฟล์ {done} / {total} ไฟล์ให้เบราว์เซอร์แล้ว",
    "Finished with unavailable images": "เสร็จแล้ว แต่มีภาพที่ใช้ไม่ได้",
    "Sent to browser": "ส่งให้เบราว์เซอร์แล้ว",
    "+{count} more failures": "+ล้มเหลวอีก {count} รายการ",
    "This ZIP is incomplete. See _download-errors.txt inside.": "ZIP นี้ไม่ครบ ดูรายละเอียดใน _download-errors.txt ภายในไฟล์",
    "Check browser downloads for the saved file.": "ดูไฟล์ที่บันทึกได้ในรายการดาวน์โหลดของเบราว์เซอร์",
    "Download cancelled": "ยกเลิกการดาวน์โหลดแล้ว",
    "Download failed": "ดาวน์โหลดไม่สำเร็จ",
    "No unfinished ZIP was saved. Translation continues unchanged.": "ไม่ได้บันทึก ZIP ที่ยังไม่เสร็จ การแปลยังทำงานตามปกติ",
    "This ZIP exceeds ZIP32 limits (under 4 GiB and 65,535 entries). No archive was saved.":
      "ZIP นี้เกินขีดจำกัด ZIP32 (ต้องเล็กกว่า 4 GiB และไม่เกิน 65,535 ไฟล์) ไม่ได้บันทึกไฟล์",
    // Live AI request phase from the provider stream (progress panel).
    "Waiting for provider…": "กำลังรอผู้ให้บริการ…",
    "AI is thinking… ({seconds}s)": "AI กำลังคิด… ({seconds} วิ)",
    "AI is thinking…": "AI กำลังคิด…",
    "Translating {done}/{total} lines": "กำลังแปล {done}/{total} บรรทัด",
    "Translating {done} lines": "กำลังแปล {done} บรรทัด",
    "Translating lines": "กำลังแปลบรรทัด",
    "No response — stopping": "ไม่มีการตอบกลับ — กำลังหยุด",
    "AI thought too long — stopping": "AI คิดนานเกินไป — กำลังหยุด",
    "No new lines — stopping": "ไม่มีบรรทัดใหม่ — กำลังหยุด",
    "Safety time limit — stopping": "ถึงเพดานเวลาความปลอดภัย — กำลังหยุด",
  });
  const TEMPLATES = Object.keys(TH).filter((source) => /\{[a-z]+\}/.test(source)).map((source) => {
    const names = [];
    const pattern = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{([a-z]+)\\\}/g, (_, name) => {
      names.push(name);
      return "(.+?)";
    });
    return { source, names, regex: new RegExp("^" + pattern + "$") };
  });
  let language = "";
  const listeners = new Set();
  const fill = (text, values) => values
    ? text.replace(/\{([a-z]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
    : text;
  // Authored source (with {name} values) → selected language.
  function t(source, values) {
    const text = String(source ?? "");
    return fill(language === "th" && Object.hasOwn(TH, text) ? TH[text] : text, values);
  }
  // Finished English text from elsewhere (for example a background toast) →
  // selected language, when it is authored copy; anything else is unchanged.
  function display(value) {
    const text = String(value ?? "");
    if (language !== "th" || !text) return text;
    if (Object.hasOwn(TH, text)) return TH[text];
    const prefix = "TextPhantom: ";
    if (text.startsWith(prefix) && text.length > prefix.length) {
      const rest = display(text.slice(prefix.length));
      if (rest !== text.slice(prefix.length)) return prefix + rest;
    }
    for (const template of TEMPLATES) {
      const match = template.regex.exec(text);
      if (!match) continue;
      return fill(TH[template.source], Object.fromEntries(template.names.map((name, i) => [name, match[i + 1]])));
    }
    return text;
  }
  function set(value) {
    const next = value === "th" ? "th" : "";
    if (next === language) return;
    language = next;
    for (const listener of listeners) {
      try { listener(language); } catch { /* One surface cannot block another. */ }
    }
  }
  try {
    const storage = root.chrome?.storage || root.browser?.storage;
    storage?.local?.get?.(KEY, (values) => {
      try { if (root.chrome?.runtime?.lastError) return; } catch { return; }
      set(values?.[KEY]);
    });
    storage?.onChanged?.addListener?.((changes, area) => {
      if (area === "local" && changes?.[KEY]) set(changes[KEY].newValue);
    });
  } catch { /* An invalidated extension context keeps the English source. */ }
  root.TPPageText = Object.freeze({
    t,
    display,
    has: (source) => Object.hasOwn(TH, String(source ?? "")),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get language() { return language; },
    phrases: TH,
  });
})(globalThis);
