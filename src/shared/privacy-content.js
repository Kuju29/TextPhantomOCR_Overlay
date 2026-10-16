/**
 * TextPhantom privacy wording (10495) — the ONE place where it is written.
 *
 * Thai and English are both authored here (never machine-translated). The
 * consent screen (shared/data-consent-dialog.js) renders SUMMARY; the user
 * guide's "Privacy & data" tab renders SUMMARY + DETAILS + PERMISSIONS. Editing
 * the wording here changes both.
 *
 * A classic script on purpose: the guide must render when guide.html is opened
 * as a plain file (no extension, no ES modules over file://). Extension modules
 * import it for its side effect and read globalThis.TPPrivacyContent.
 *
 * Language rule: Thai when uiLanguageV1 === "th", English otherwise.
 */
(function (root) {
  if (root.TPPrivacyContent) return;
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const item of Object.values(value)) freeze(item);
    }
    return value;
  };

  const CONTACT_EMAIL = 'plan291037@outlook.com';
  const LIMITED_USE = 'The use of information received from this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.';

  // ------------------------------------------------------------------ SUMMARY
  // Exactly what the consent screen shows, and Part 1 of the guide tab.
  const SUMMARY = {
    th: {
      title: 'ขออนุญาตใช้ข้อมูล',
      group1: 'ส่งทุกครั้งที่คุณสั่งแปล:',
      always1: 'ภาพที่คุณเลือกแปล → เซิร์ฟเวอร์ TextPhantom (อ่านตัวอักษรด้วย Google Lens) และ AI ที่คุณเลือก',
      always2: 'รหัสสุ่มประจำเครื่อง → ใช้จำกัดจำนวนคำขอเท่านั้น ไม่ผูกกับชื่อหรืออีเมล',
      group2: 'ต้องอนุญาตก่อน (Paid, Login และแชทกับแอดมิน):',
      paid: 'อีเมล เครดิต และประวัติการซื้อ — เพื่อใช้บัญชี Paid ของคุณ',
      login: 'การล็อกอินเว็บ Gemini หรือ DeepSeek ของคุณ (คุกกี้) — เพื่อแปลด้วยบัญชีเว็บนั้นของคุณ',
      support: 'ข้อความและไฟล์ที่คุณส่งหาแอดมิน — แอดมินจะอ่านเพื่อตอบคุณ',
      note: 'ถ้าไม่อนุญาต ยังแปลภาพได้ตามปกติ แต่จะใช้ Paid, Login และแชทไม่ได้',
      foot: 'ไม่ขายข้อมูลและไม่ใช้ทำโฆษณา',
      link: 'อ่านรายละเอียด',
      allow: 'อนุญาต',
      later: 'ไม่อนุญาต',
    },
    en: {
      title: 'Allow data use?',
      group1: 'Sent every time you translate:',
      always1: 'Images you choose to translate → the TextPhantom server (text read with Google Lens) and the AI you choose',
      always2: 'A random install ID → only to limit request rates, not linked to your name or email',
      group2: 'Needs your permission (Paid, Login and chat with the admin):',
      paid: 'Your email, credits and purchase history — to run your Paid account',
      login: 'Your Gemini or DeepSeek sign-in (cookie) — to translate with your own account on that site',
      support: 'Messages and files you send to the admin — the admin reads them to reply',
      note: "If you don't allow, image translation still works as usual, but Paid, Login and chat stay off.",
      foot: "We don't sell your data or use it for ads",
      link: 'Read the details',
      allow: 'Allow',
      later: "Don't allow",
    },
  };
  // Order of the two bullet groups on the consent screen and in the guide.
  const SUMMARY_GROUPS = [
    { heading: 'group1', items: ['always1', 'always2'] },
    { heading: 'group2', items: ['paid', 'login', 'support'] },
  ];

  // ----------------------------------------------------------------- MESSAGES
  const MESSAGES = {
    th: {
      declined: 'ยังไม่ได้ส่งข้อมูลใด ๆ กดอนุญาตเพื่อใช้ฟีเจอร์นี้',
      allowedTab: 'อนุญาตแล้ว กลับไปที่หน้าเดิมแล้วกดแปลอีกครั้ง',
      openedTab: 'กดอนุญาตในแท็บ TextPhantom ที่เปิดขึ้น แล้วลองอีกครั้ง',
      // DATA_CONSENT_REQUIRED on a web page (toast and image badge).
      pageBlocked: 'ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว ยังไม่ได้ส่งคำขอและไม่หักเครดิต',
      // A running Paid/Login job stopped because the permission was withdrawn.
      revokedStop: 'ยกเลิกการอนุญาตข้อมูลแล้ว งานที่ใช้บัญชีหยุดแล้ว ผลที่แปลเสร็จยังอยู่',
      lockedChat: 'ต้องอนุญาตข้อมูลก่อนจึงจะแชทกับแอดมินได้',
      lockedAccount: 'ต้องอนุญาตข้อมูลก่อนจึงจะเปิดบัญชีได้ คุณยังเข้าสู่ระบบอยู่',
      // The popup's locked note above the greyed account controls.
      lockedBanner: 'ยังไม่อนุญาตข้อมูลบัญชี จึงพักการแปลแบบ Paid และ Login ไว้ คุณยังเข้าสู่ระบบอยู่',
      reviewAllow: 'ดูและอนุญาต',
    },
    en: {
      declined: 'Nothing was sent. Allow to use this feature.',
      allowedTab: 'Allowed. Go back to your page and translate again.',
      openedTab: 'Allow in the TextPhantom tab that opened, then try again.',
      pageBlocked: 'Allow data use first. A permission tab is open. Nothing was sent and no credits were used.',
      revokedStop: 'Data use was turned off. Account work stopped; finished translations stay.',
      lockedChat: 'Allow data use to chat with the admin.',
      lockedAccount: 'Allow data use to open your account. You are still signed in.',
      lockedBanner: 'Account data is not allowed, so Paid and Login translation is paused.',
      reviewAllow: 'Review and allow',
    },
  };

  // ---------------------------------------------------------- DIAGNOSTICS
  // Tools › Advanced switch and its confirmation (default focus: cancel).
  const DIAGNOSTICS = {
    th: {
      title: 'เปิดส่ง log วินิจฉัย?',
      body: 'ใช้เฉพาะตอนที่ผู้พัฒนาขอให้ช่วยตรวจปัญหาเท่านั้น ไม่แนะนำให้เปิดทิ้งไว้ เมื่อเปิด ส่วนขยายจะส่งบันทึกข้อผิดพลาดและเวลาทำงานไปที่เซิร์ฟเวอร์ API เพิ่ม ซึ่งอาจทำให้ทำงานช้าลง (ไม่มีรหัสผ่าน โทเค็น คุกกี้ หรืออีเมลเต็ม)',
      cancel: 'ยกเลิก',
      confirm: 'เปิด',
    },
    en: {
      title: 'Turn on diagnostic logs?',
      body: 'Only turn this on when the developer asks you to help investigate a problem. Not recommended to leave on. It sends extra error and timing logs to the API server, which may slow things down (no passwords, tokens, cookies or full email addresses).',
      cancel: 'Cancel',
      confirm: 'Turn on',
    },
  };

  // ---------------------------------------------------------- GUIDE LABELS
  const GUIDE = {
    th: {
      tabGuide: 'คู่มือการใช้งาน',
      tabPrivacy: 'Privacy & data',
      heading: 'ความเป็นส่วนตัวและข้อมูล',
      lead: 'หน้านี้บอกว่า TextPhantom ส่งข้อมูลอะไร ไปที่ไหน และเมื่อไหร่ เขียนให้อ่านเข้าใจได้แม้ไม่เคยใช้ส่วนขยายมาก่อน',
      language: 'ภาษาของหน้านี้',
      partSummary: 'สรุปสั้น ๆ',
      partSummaryLead: 'ข้อความเดียวกับหน้าจอขออนุญาตที่ส่วนขยายแสดง',
      partDetails: 'รายละเอียด',
      partPermissions: 'สิทธิ์ที่ส่วนขยายขอ',
      partPermissionsLead: 'เบราว์เซอร์แสดงสิทธิ์เหล่านี้ตอนติดตั้ง ตารางนี้อธิบายว่าแต่ละสิทธิ์ใช้ทำอะไร',
      permissionsLive: 'รายการจากส่วนขยายที่ติดตั้งอยู่ในเบราว์เซอร์นี้',
      permissionsStatic: 'รายการของทุกเบราว์เซอร์ (เปิดหน้านี้นอกส่วนขยาย)',
      colPermission: 'สิทธิ์',
      colKind: 'ประเภท',
      colWhy: 'ใช้ทำอะไร',
      colBrowsers: 'เบราว์เซอร์',
      kindApi: 'สิทธิ์ของส่วนขยาย',
      kindHost: 'เว็บไซต์',
      kindOptional: 'ขอทีหลัง (เมื่อใช้)',
      kindData: 'ข้อมูลที่ประกาศ (Firefox/Thunderbird)',
      kindDataRequired: 'จำเป็น',
      kindDataOptional: 'ต้องอนุญาตก่อน',
      partChoice: 'การอนุญาตของคุณ',
      status: 'สถานะ',
      allowed: 'อนุญาตแล้ว',
      notAllowed: 'ยังไม่อนุญาต',
      allow: 'อนุญาต',
      revoke: 'ยกเลิกการอนุญาต',
      revokeNote: 'ยกเลิกแล้ว งานที่ใช้บัญชีจะหยุดทันที ผลที่แปลเสร็จแล้วยังอยู่ และคุณยังเข้าสู่ระบบอยู่',
      choiceOutside: 'เปิดหน้านี้จากปุ่มคู่มือในหน้าต่าง TextPhantom เพื่อดูและเปลี่ยนการอนุญาต',
      table: { who: 'ผู้รับ', what: 'ได้รับอะไร', when: 'เมื่อไหร่' },
      callouts: {
        consent: { title: 'หัวข้อของหน้าจอ', always: 'สิ่งที่ส่งทุกครั้งที่สั่งแปล (ไม่ต้องอนุญาต)', permission: 'สิ่งที่ส่งหลังจากคุณอนุญาตเท่านั้น', note: 'ถ้าไม่อนุญาต การแปลภาพยังทำงานตามปกติ', details: '“อ่านรายละเอียด” เปิดหน้านี้', later: '“ไม่อนุญาต” ไม่ส่งอะไรเลย', allow: '“อนุญาต” เปิดใช้ Paid, Login และแชท (Firefox จะถามซ้ำในหน้าต่างของเบราว์เซอร์)' },
        locked: { note: 'แถบแจ้งว่ายังไม่อนุญาต กด “ดูและอนุญาต” (Review and allow) เพื่อเปิดหน้าจอขออนุญาต', buy: 'ปุ่มของบัญชีเป็นสีเทา กดแล้วจะขออนุญาตก่อน อนุญาตแล้วทำงานต่อทันที', model: 'ตัวเลือกของบัญชีเป็นสีเทาเช่นกัน', signout: '“Sign out” ใช้ได้เสมอ ออกจากระบบในเครื่องนี้โดยไม่ส่งคำขอ' },
        diagnostics: { switch: 'สวิตช์ log วินิจฉัย (ปิดเป็นค่าเริ่มต้น)', hint: 'คำอธิบายที่ขึ้นเมื่อชี้เมาส์ที่ชื่อสวิตช์ (บนจอสัมผัสให้แตะที่ชื่อ)' },
        diagnosticsConfirm: { body: 'คำเตือนก่อนเปิด', cancel: '“ยกเลิก” สวิตช์ยังปิดอยู่ (ปุ่มที่เลือกไว้ก่อน)', confirm: '“เปิด” เริ่มส่ง log' },
      },
      paidSectionTitle: 'หน้าจอขออนุญาตใช้ข้อมูล',
      shotConsent: 'หน้าจอขออนุญาตใช้ข้อมูล',
      shotLocked: 'หน้าต่าง TextPhantom เมื่อยังไม่อนุญาต: ปุ่มของบัญชีเป็นสีเทา เหลือ Sign out ที่ใช้ได้',
      shotDiagnostics: 'สวิตช์ log วินิจฉัยใน Tools › Advanced',
      shotDiagnosticsConfirm: 'หน้าต่างยืนยันก่อนเปิดส่ง log วินิจฉัย',
    },
    en: {
      tabGuide: 'คู่มือการใช้งาน',
      tabPrivacy: 'Privacy & data',
      heading: 'Privacy & data',
      lead: 'What TextPhantom sends, where it goes and when. Written for people who have never used an extension before.',
      language: 'Language of this page',
      partSummary: 'In short',
      partSummaryLead: 'The same text as the permission screen in the extension.',
      partDetails: 'Details',
      partPermissions: 'Permissions the extension asks for',
      partPermissionsLead: 'Your browser lists these when you install. This table says what each one is used for.',
      permissionsLive: 'List from the extension installed in this browser',
      permissionsStatic: 'List for every browser (this page is open outside the extension)',
      colPermission: 'Permission',
      colKind: 'Type',
      colWhy: 'Used for',
      colBrowsers: 'Browsers',
      kindApi: 'Extension permission',
      kindHost: 'Websites',
      kindOptional: 'Asked later (when used)',
      kindData: 'Declared data (Firefox/Thunderbird)',
      kindDataRequired: 'required',
      kindDataOptional: 'needs your permission',
      partChoice: 'Your choice',
      status: 'Status',
      allowed: 'Allowed',
      notAllowed: 'Not allowed',
      allow: 'Allow',
      revoke: 'Revoke',
      revokeNote: 'Revoking stops account requests at once. Finished translations stay and you stay signed in.',
      choiceOutside: 'Open this page from the guide button in the TextPhantom window to see or change your choice.',
      table: { who: 'Who', what: 'What they get', when: 'When' },
      callouts: {
        consent: { title: 'The title of the screen', always: 'What is sent every time you translate (no permission needed)', permission: 'What is sent only after you allow', note: 'If you don’t allow, image translation works as usual', details: '“Read the details” opens this page', later: '“Don’t allow” sends nothing', allow: '“Allow” turns on Paid, Login and chat (Firefox asks again in its own browser prompt)' },
        locked: { note: 'The notice that data use is not allowed. “Review and allow” opens the permission screen', buy: 'Account buttons are grey. Clicking one asks first; after Allow it goes on at once', model: 'Account choices are grey too', signout: '“Sign out” always works: it signs you out on this device without sending a request' },
        diagnostics: { switch: 'The diagnostic logs switch (off by default)', hint: 'The explanation that appears when you hover the switch name (tap the name on a touch screen)' },
        diagnosticsConfirm: { body: 'The warning before it turns on', cancel: '“Cancel” keeps the switch off (selected first)', confirm: '“Turn on” starts sending logs' },
      },
      paidSectionTitle: 'The data-use permission screen',
      shotConsent: 'The data-use permission screen',
      shotLocked: 'The TextPhantom window before you allow: account buttons are grey; Sign out still works',
      shotDiagnostics: 'The diagnostic logs switch in Tools › Advanced',
      shotDiagnosticsConfirm: 'The confirmation before diagnostic logs turn on',
    },
  };

  // ------------------------------------------------------------------ DETAILS
  // One card per item. `paragraphs` and `bullets` are plain text; `table` rows
  // are [who, what, when]; `shots` name screenshots from guide-data.js.
  const DETAILS = {
    th: [
      { id: 'translate', title: 'เมื่อคุณสั่งแปล', bullets: [
        'ภาพที่คุณเลือกแปลและที่อยู่ของหน้าเว็บนั้น ส่งไปที่เซิร์ฟเวอร์ TextPhantom API ที่ตั้งไว้ในส่วนขยาย (Tools › Advanced › Custom API URL) ถ้าไม่ได้ตั้ง ใช้เซิร์ฟเวอร์สาธารณะของ TextPhantom บน Hugging Face',
        'เซิร์ฟเวอร์ส่งภาพต่อให้ Google Lens เพื่ออ่านตัวอักษรในภาพ',
        'ถ้าเลือกแปลด้วย AI ข้อความที่อ่านได้ (และภาพหน้า ถ้าเปิด “Send page image to AI”) ส่งไปที่ AI ที่คุณเลือกเอง: ใช้ API key ของคุณ, โมเดลบนคอมพิวเตอร์ของคุณ (Local), บัญชีเว็บ AI ของคุณเอง (Login) หรือ Paid',
        'ผลแปลที่เก็บไว้ใช้ซ้ำ (แคช) อยู่ในเครื่องของคุณ',
      ] },
      { id: 'install-id', title: 'รหัสสุ่มประจำเครื่อง', paragraphs: [
        'ส่วนขยายสร้างรหัสสุ่มหนึ่งรหัสต่อโปรไฟล์เบราว์เซอร์ และแนบไปกับคำขอแปล เพื่อให้เซิร์ฟเวอร์จำกัดจำนวนคำขอต่อเครื่องได้ รหัสนี้ไม่ได้สร้างจากข้อมูลของคุณ และไม่ผูกกับชื่อหรืออีเมล',
      ] },
      { id: 'menu-language', title: 'ภาษาของเมนู', paragraphs: [
        'ถ้าคุณเลือกภาษาหน้าจอที่ไม่ใช่ภาษาอังกฤษ ข้อความบนเมนูของส่วนขยายจะถูกแปลด้วย Google Translate โดยส่งเฉพาะข้อความของเมนู ไม่ส่งภาพ อีเมล หรือข้อมูลบัญชี ข้อความที่เขียนไว้เป็นภาษาไทยแล้ว (เช่นหน้านี้และหน้าจอขออนุญาต) ไม่ถูกส่งไปแปล',
      ] },
      { id: 'paid', title: 'Paid (เครดิต TP)', bullets: [
        'เมื่อคุณเข้าสู่ระบบ Paid อีเมล ยอดเครดิต และประวัติการซื้อของคุณเก็บไว้ที่บริการบัญชีของ TextPhantom',
        'การจ่ายเงินทำบนหน้าเว็บของ Stripe รายละเอียดบัตรไม่ผ่านส่วนขยายเลย',
        'ส่งเฉพาะหลังจากคุณกดอนุญาต',
      ] },
      { id: 'login', title: 'Login (บัญชี AI ของคุณ)', bullets: [
        'Gemini และ DeepSeek: คุกกี้การล็อกอินของเว็บนั้นส่งไปที่ TextPhantom API ที่คุณใช้เท่านั้น และใช้เฉพาะกับคำขอแปลของคุณเอง',
        'ส่วนขยายไม่เคยถามหรือเก็บรหัสผ่านของคุณ',
        'Claude และ ChatGPT: คำขอส่งจากเบราว์เซอร์ของคุณไปที่เว็บนั้นโดยตรง บัญชี TextPhantom ของคุณใช้ยืนยันว่าเป็นคุณ',
        'ส่งเฉพาะหลังจากคุณกดอนุญาต',
      ] },
      { id: 'chat', title: 'แชทกับแอดมิน', bullets: [
        'ข้อความและไฟล์ที่คุณส่งเก็บไว้ที่บริการบัญชีของ TextPhantom',
        'แอดมินอ่านเพื่อตอบคุณ',
        'ส่งเฉพาะหลังจากคุณกดอนุญาต ก่อนอนุญาต ปุ่ม “Contact admin” เป็นสีเทาและไม่มีปุ่มแชทบนหน้าเว็บ',
      ] },
      { id: 'when-asked', title: 'เมื่อไหร่ที่ขออนุญาต และถ้าไม่อนุญาต', shots: ['privacy-consent-th', 'privacy-locked'], bullets: [
        'ส่วนขยายขออนุญาตเมื่อคุณเลือก AI service เป็น Paid, เมื่อเริ่มเข้าสู่ระบบด้วยอีเมล, เมื่อกดปุ่มของบัญชีที่เป็นสีเทา และเมื่อสั่งแปลบนหน้าเว็บด้วย Paid หรือ Login (เปิดแท็บ TextPhantom ให้กดอนุญาต)',
        'คนที่เข้าสู่ระบบไว้ก่อนเวอร์ชันนี้จะเห็นหน้าจอนี้หนึ่งครั้งตอนเปิดหน้าต่าง TextPhantom',
        'ถ้าไม่อนุญาต: การแปลภาพยังทำงานตามปกติ คุณยังเข้าสู่ระบบอยู่ แต่ปุ่มของ Paid, Login และแชทเป็นสีเทาและไม่ส่งอะไรออกไป กด “Sign out” ได้ตามปกติ (ออกจากระบบในเครื่องนี้โดยไม่ส่งคำขอ)',
        'อนุญาตได้ทุกเมื่อ: กดปุ่มที่เป็นสีเทา หรือกดอนุญาตที่หัวข้อ “การอนุญาตของคุณ” ด้านล่าง',
      ] },
      { id: 'diagnostics', title: 'log วินิจฉัย', shots: ['privacy-diagnostics', 'privacy-diagnostics-confirm-th'], bullets: [
        'ปิดเป็นค่าเริ่มต้น สวิตช์อยู่ที่ Tools › Advanced ใต้ช่อง “Custom API URL”: “Send diagnostic logs to the API server” ชี้เมาส์ที่ชื่อสวิตช์เพื่อดูคำอธิบาย',
        'เมื่อเปิด บันทึกข้อผิดพลาดและเวลาทำงานจะส่งไปที่เซิร์ฟเวอร์ API',
        'ไม่มีรหัสผ่าน โทเค็น คุกกี้ หรืออีเมลเต็มใน log',
      ] },
      { id: 'device', title: 'อยู่ในเครื่องของคุณเท่านั้น', bullets: [
        'การตั้งค่าทั้งหมด',
        'API key ที่คุณใส่ (ส่งไปพร้อมคำขอแปลของคุณเอง เพื่อให้เซิร์ฟเวอร์ API เรียก AI ที่คุณเลือกได้ ไม่ได้เก็บไว้ที่เซิร์ฟเวอร์)',
        'ผลแปลที่เก็บไว้ใช้ซ้ำ',
      ] },
      { id: 'recipients', title: 'ใครได้รับอะไร', table: [
        ['เซิร์ฟเวอร์ TextPhantom API', 'ภาพที่คุณสั่งแปล ที่อยู่หน้าเว็บ ข้อความที่อ่านได้ รหัสสุ่มประจำเครื่อง และ log วินิจฉัย (ถ้าคุณเปิด)', 'ทุกครั้งที่สั่งแปล'],
        ['Google Lens (ผ่านเซิร์ฟเวอร์)', 'ภาพ เพื่ออ่านตัวอักษร', 'ทุกครั้งที่สั่งแปล'],
        ['AI ที่คุณเลือก', 'ข้อความที่อ่านได้ (และภาพหน้า ถ้าเปิด)', 'เมื่อแปลด้วย AI'],
        ['บริการบัญชี TextPhantom', 'อีเมล เครดิต ประวัติการซื้อ ข้อความและไฟล์ในแชท', 'เมื่อใช้ Paid, Login หรือแชท หลังจากคุณอนุญาต'],
        ['Stripe', 'ข้อมูลการจ่ายเงินที่คุณกรอกบนหน้า Stripe', 'เมื่อคุณซื้อเครดิต'],
        ['Google Translate', 'ข้อความบนเมนูของส่วนขยาย', 'เมื่อคุณเลือกภาษาหน้าจอที่ไม่ใช่ภาษาอังกฤษ'],
      ] },
      { id: 'dont', title: 'สิ่งที่เราไม่ทำ', bullets: [
        'ไม่ขายข้อมูล',
        'ไม่ใช้ข้อมูลทำโฆษณา',
        'ไม่ติดตามประวัติการท่องเว็บ',
        'ไม่มีคนอ่านข้อมูลของคุณ ยกเว้นแอดมินอ่านแชทที่คุณส่ง และ log วินิจฉัยที่คุณเปิดเอง',
        'การใช้ข้อมูลที่ได้จากส่วนขยายนี้เป็นไปตามนโยบายข้อมูลผู้ใช้ของ Chrome Web Store รวมถึงข้อกำหนด Limited Use:',
      ], quote: LIMITED_USE },
      { id: 'contact', title: 'ติดต่อและขอลบข้อมูล', paragraphs: [
        'ส่งอีเมลมาที่ ' + CONTACT_EMAIL,
        'ข้อมูลที่ส่งไปแล้วไม่ถูกลบเองอัตโนมัติ (การยกเลิกการอนุญาตหยุดการส่งใหม่ ไม่ได้ลบข้อมูลเก่า) ขอให้ลบได้ที่อีเมลนี้',
      ] },
    ],
    en: [
      { id: 'translate', title: 'When you translate', bullets: [
        'The images you choose to translate and the address of that page go to the TextPhantom API server set in the extension (Tools › Advanced › Custom API URL). If you have not set one, the public TextPhantom server on Hugging Face is used.',
        'The server passes the image to Google Lens to read the text in it.',
        'If you translate with AI, the recognised text (and the page image, if “Send page image to AI” is on) goes to the AI you choose: your own API key, a model on your own computer (Local), your own AI website account (Login), or Paid.',
        'Translations kept for reuse (the cache) stay on your device.',
      ] },
      { id: 'install-id', title: 'Install ID', paragraphs: [
        'The extension creates one random ID per browser profile and attaches it to translation requests, so the server can limit how many requests one device makes. It is not made from your data and is not linked to your name or email.',
      ] },
      { id: 'menu-language', title: 'Menu language', paragraphs: [
        'If you choose a menu language other than English, the extension’s menu text is translated with Google Translate. Only the menu text is sent — no images, email or account data. Text that is already written in Thai (such as this page and the permission screen) is not sent for translation.',
      ] },
      { id: 'paid', title: 'Paid (TP credits)', bullets: [
        'When you sign in to Paid, your email, credit balance and purchase history are kept by the TextPhantom account service.',
        'You pay on Stripe’s page. Card details never pass through the extension.',
        'Sent only after you allow.',
      ] },
      { id: 'login', title: 'Login (your own AI account)', bullets: [
        'Gemini and DeepSeek: that website’s sign-in cookie goes only to the TextPhantom API you use, and only for your own translation requests.',
        'The extension never asks for or stores your password.',
        'Claude and ChatGPT: requests go from your browser to that website directly; your TextPhantom account verifies that it is you.',
        'Sent only after you allow.',
      ] },
      { id: 'chat', title: 'Chat with the admin', bullets: [
        'Messages and files you send are kept by the TextPhantom account service.',
        'The admin reads them to reply to you.',
        'Sent only after you allow. Before that, “Contact admin” is grey and no chat button appears on web pages.',
      ] },
      { id: 'when-asked', title: 'When we ask, and what happens if you don’t allow', shots: ['privacy-consent-en', 'privacy-locked'], bullets: [
        'The extension asks when you choose Paid as the AI service, when you start signing in with your email, when you click a grey account button, and when you translate on a web page with Paid or Login (a TextPhantom tab opens so you can allow).',
        'If you signed in before this version, you see the screen once when you open the TextPhantom window.',
        'If you don’t allow: image translation works as usual and you stay signed in, but the Paid, Login and chat buttons are grey and nothing is sent. “Sign out” still works (it signs you out on this device without sending a request).',
        'You can allow at any time: click a grey button, or use “Allow” under “Your choice” below.',
      ] },
      { id: 'diagnostics', title: 'Diagnostic logs', shots: ['privacy-diagnostics', 'privacy-diagnostics-confirm-en'], bullets: [
        'Off by default. The switch is in Tools › Advanced, under “Custom API URL”: “Send diagnostic logs to the API server”. Hover its name to see the explanation.',
        'When it is on, error and timing logs go to the API server.',
        'Logs never contain passwords, tokens, cookies or full email addresses.',
      ] },
      { id: 'device', title: 'On your device only', bullets: [
        'All your settings.',
        'The API keys you enter (a key is sent only with your own translation requests, so the API server can call the AI you chose; the server does not keep it).',
        'Translations kept for reuse.',
      ] },
      { id: 'recipients', title: 'Who receives what', table: [
        ['TextPhantom API server', 'Images you translate, the page address, the recognised text, the install ID, and diagnostic logs (if you turned them on)', 'Every time you translate'],
        ['Google Lens (through the server)', 'The image, to read the text', 'Every time you translate'],
        ['The AI you choose', 'The recognised text (and the page image, if on)', 'When you translate with AI'],
        ['TextPhantom account service', 'Email, credits, purchase history, chat messages and files', 'When you use Paid, Login or chat, after you allow'],
        ['Stripe', 'The payment details you type on Stripe’s page', 'When you buy credits'],
        ['Google Translate', 'The extension’s menu text', 'When you choose a menu language other than English'],
      ] },
      { id: 'dont', title: 'What we don’t do', bullets: [
        'We don’t sell your data.',
        'We don’t use it for ads.',
        'We don’t track your browsing.',
        'No person reads your data, except the admin reading chat messages you send and diagnostic logs you turned on.',
        'Chrome Web Store Limited Use:',
      ], quote: LIMITED_USE },
      { id: 'contact', title: 'Contact and deletion', paragraphs: [
        'Email ' + CONTACT_EMAIL,
        'Data already sent is not deleted automatically (revoking stops new sending; it does not erase what was sent). Ask for deletion at that address.',
      ] },
    ],
  };

  // -------------------------------------------------------------- PERMISSIONS
  // Every permission, host permission, optional permission and declared data
  // type in the five built manifests (platform/base.json + platform/*.json).
  // scripts/test-privacy-guide-10495.mjs fails if one lacks Thai or English.
  const PERMISSIONS = {
    th: {
      contextMenus: 'เพิ่มเมนูคลิกขวา “แปลภาพนี้” และ “แปลภาพทั้งหมดในหน้านี้”',
      menus: 'เพิ่มเมนูคลิกขวา “แปลภาพนี้” และ “แปลภาพทั้งหมดในหน้านี้”',
      storage: 'เก็บการตั้งค่า ผลแปลที่แคชไว้ และสถานะการเข้าสู่ระบบไว้ในเครื่องของคุณ',
      activeTab: 'ทำงานกับแท็บที่คุณกำลังดู เมื่อคุณกดเมนูหรือปุ่มของ TextPhantom',
      declarativeNetRequestWithHostAccess: 'ตั้ง header (Referer/Origin) ชั่วคราวตอนส่วนขยายโหลดภาพจากเว็บที่ไม่ให้โหลดภาพตรง ๆ ใช้กับภาพนั้นภาพเดียวแล้วลบทิ้ง',
      alarms: 'ปลุกส่วนขยายเป็นระยะระหว่างรอการเข้าสู่ระบบ Login และหลังคุณส่งข้อความหาแอดมิน (เพื่อดูคำตอบ)',
      scripting: 'ใส่สคริปต์ของ TextPhantom ลงในหน้าที่ต้องใช้ (ปุ่มแชท, แท็บเว็บ AI ของ Login, อีเมลใน Thunderbird) และอ่านภาพจากหน้าที่คุณสั่งแปล',
      webNavigation: 'รู้ว่าหน้าเข้าสู่ระบบของผู้ให้บริการ AI ส่งกลับมาแล้ว (Login) และตรวจว่าแท็บเว็บ AI ยังเป็นหน้าเดิม',
      tabs: 'หาแท็บและหน้าต่างอีเมลที่คุณสั่งแปลใน Thunderbird',
      messagesRead: 'อ่านภาพในอีเมลที่คุณเปิดอยู่ เมื่อคุณสั่งแปลใน Thunderbird',
      sensitiveDataUpload: 'ส่งภาพจากอีเมลที่คุณสั่งแปลไปยังบริการแปลที่คุณใช้ (Google Lens, เซิร์ฟเวอร์ API ที่ตั้งไว้ หรือผู้ให้บริการ AI ของคุณ) ใน Thunderbird ไม่มีการส่งจนกว่าคุณจะสั่งแปล',
      '<all_urls>': 'แสดงปุ่มแปลและผลแปลบนทุกเว็บ อ่านภาพจากเว็บที่คุณสั่งแปล และติดต่อเซิร์ฟเวอร์ API ที่ตั้งไว้ เนื้อหาของหน้าไม่ถูกส่งไปไหนจนกว่าคุณจะสั่งแปล',
      cookies: 'ขอเฉพาะตอนคุณเชื่อม Login กับ Gemini หรือ DeepSeek เพื่ออ่านคุกกี้การล็อกอินของเว็บนั้น',
      websiteContent: 'ภาพและข้อความบนหน้าที่คุณสั่งแปล',
      browsingActivity: 'ที่อยู่ของหน้าที่คุณสั่งแปล',
      authenticationInfo: 'คุกกี้การล็อกอินของ Gemini หรือ DeepSeek (Login) — หลังจากคุณอนุญาต',
      personallyIdentifyingInfo: 'อีเมลของบัญชี Paid — หลังจากคุณอนุญาต',
      financialAndPaymentInfo: 'เครดิตและประวัติการซื้อ — หลังจากคุณอนุญาต',
      personalCommunications: 'ข้อความและไฟล์ในแชทกับแอดมิน — หลังจากคุณอนุญาต',
      technicalAndInteraction: 'log วินิจฉัย — เฉพาะเมื่อคุณเปิดสวิตช์เอง',
    },
    en: {
      contextMenus: 'Adds the right-click items “Translate this image” and “Translate all images on page”.',
      menus: 'Adds the right-click items “Translate this image” and “Translate all images on page”.',
      storage: 'Keeps your settings, cached translations and sign-in state on your device.',
      activeTab: 'Works with the tab you are looking at when you use a TextPhantom menu item or button.',
      declarativeNetRequestWithHostAccess: 'Sets a temporary Referer/Origin header when the extension loads an image from a site that blocks direct image loading. It applies to that one image and is removed afterwards.',
      alarms: 'Wakes the extension now and then while a Login sign-in is pending, and after you message the admin (to check for a reply).',
      scripting: 'Adds TextPhantom scripts where they are needed (the chat button, Login AI website tabs, emails in Thunderbird) and reads images from the page you translate.',
      webNavigation: 'Notices when an AI provider’s sign-in page returns (Login) and checks that an AI website tab is still the same page.',
      tabs: 'Finds the email tabs and windows you translate in Thunderbird.',
      messagesRead: 'Reads the images in the email you have open when you translate in Thunderbird.',
      sensitiveDataUpload: 'Sends the images of an email you translate in Thunderbird to the translation services you use (Google Lens, the API server you set, or your AI provider). Nothing is sent until you translate.',
      '<all_urls>': 'Shows the translate buttons and translations on any website, reads images from the site you translate, and contacts the API server you set. Page content is not sent anywhere until you translate.',
      cookies: 'Asked only when you connect Login to Gemini or DeepSeek, to read that website’s sign-in cookie.',
      websiteContent: 'Images and text on the page you translate.',
      browsingActivity: 'The address of the page you translate.',
      authenticationInfo: 'The Gemini or DeepSeek sign-in cookie (Login) — after you allow.',
      personallyIdentifyingInfo: 'Your Paid account email — after you allow.',
      financialAndPaymentInfo: 'Credits and purchase history — after you allow.',
      personalCommunications: 'Messages and files in your chat with the admin — after you allow.',
      technicalAndInteraction: 'Diagnostic logs — only when you turn the switch on.',
    },
  };

  // The static list for a page opened outside the extension, and the source the
  // permission test checks against the five built manifests.
  const MANIFEST_PERMISSIONS = {
    chromium: { browsers: ['Chrome', 'Edge', 'Opera'],
      permissions: ['contextMenus', 'storage', 'activeTab', 'declarativeNetRequestWithHostAccess', 'alarms', 'scripting', 'webNavigation'],
      host: ['<all_urls>'], optional: ['cookies'], dataRequired: [], dataOptional: [] },
    firefox: { browsers: ['Firefox'],
      permissions: ['menus', 'storage', 'activeTab', 'declarativeNetRequestWithHostAccess', 'alarms', 'scripting', 'webNavigation'],
      host: ['<all_urls>'], optional: ['cookies'],
      dataRequired: ['websiteContent', 'browsingActivity'],
      dataOptional: ['authenticationInfo', 'personallyIdentifyingInfo', 'financialAndPaymentInfo', 'personalCommunications', 'technicalAndInteraction'] },
    thunderbird: { browsers: ['Thunderbird'],
      permissions: ['menus', 'storage', 'activeTab', 'tabs', 'messagesRead', 'sensitiveDataUpload', 'scripting', 'alarms'],
      host: ['<all_urls>'], optional: ['cookies'],
      dataRequired: ['websiteContent', 'browsingActivity'],
      dataOptional: ['authenticationInfo', 'personallyIdentifyingInfo', 'financialAndPaymentInfo', 'personalCommunications', 'technicalAndInteraction'] },
  };

  /** Rows for the permission table from a real manifest (null → static union). */
  function permissionRows(manifest) {
    const rows = [], seen = new Set();
    const add = (name, kind, browsers = []) => {
      const key = kind + '\n' + name;
      if (seen.has(key)) { const row = rows.find(r => r.key === key); for (const b of browsers) if (!row.browsers.includes(b)) row.browsers.push(b); return; }
      seen.add(key); rows.push({ key, name, kind, browsers: [...browsers] });
    };
    const fromManifest = (m, browsers) => {
      for (const name of m.permissions || []) add(name, 'api', browsers);
      for (const name of m.host_permissions || []) add(name, 'host', browsers);
      for (const name of m.optional_permissions || []) add(name, 'optional', browsers);
      for (const name of m.optional_host_permissions || []) add(name, 'optional', browsers);
      const declared = m.browser_specific_settings?.gecko?.data_collection_permissions || {};
      for (const name of declared.required || []) add(name, 'dataRequired', browsers);
      for (const name of declared.optional || []) add(name, 'dataOptional', browsers);
    };
    if (manifest) fromManifest(manifest, []);
    else for (const build of Object.values(MANIFEST_PERMISSIONS)) fromManifest({
      permissions: build.permissions, host_permissions: build.host, optional_permissions: build.optional,
      browser_specific_settings: { gecko: { data_collection_permissions: { required: build.dataRequired, optional: build.dataOptional } } },
    }, build.browsers);
    return rows;
  }

  const normalize = (value) => (value === 'th' ? 'th' : 'en');
  const pick = (table) => (language) => table[normalize(language)];
  root.TPPrivacyContent = freeze({
    CONTACT_EMAIL, LIMITED_USE, SUMMARY, SUMMARY_GROUPS, MESSAGES, DIAGNOSTICS, GUIDE, DETAILS,
    PERMISSIONS, MANIFEST_PERMISSIONS,
    language: normalize,
    summary: pick(SUMMARY), messages: pick(MESSAGES), diagnostics: pick(DIAGNOSTICS),
    guide: pick(GUIDE), details: pick(DETAILS), permissions: pick(PERMISSIONS),
    permissionRows,
    GUIDE_PRIVACY_PATH: 'guide/guide.html#privacy',
  });
})(globalThis);
