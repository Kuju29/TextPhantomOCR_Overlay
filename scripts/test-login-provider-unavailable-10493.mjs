// 10493 owner report: Login DeepSeek failed on the website's side, but the image
// read "เกิดข้อผิดพลาดที่ระบบยังไม่มีคำอธิบาย" (unknown cause) because the Login
// codes had no public message. A website server failure now reads as the
// website's temporary outage (not TextPhantom, not the account); an unreadable
// website reply says so instead of "unknown cause". The API's English message
// names the website and is shown in Thai on web pages.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {makeTpError, publicTpError, userMessageForCode} from '../src/shared/error-contract.js';

let checks = 0;
const ok = name => { checks++; console.log('PASS ' + name); };
const UNKNOWN = userMessageForCode('definitely_not_a_code');

const temporary = makeTpError({code: 'login_provider_temporarily_unavailable', origin: 'upstream_ai',
  stage: 'login_provider', httpStatus: 503, upstreamStatus: 503});
assert.notEqual(temporary.userMessage, UNKNOWN);
assert.match(temporary.userMessage, /ขัดข้องชั่วคราว/);
assert.match(temporary.userMessage, /ไม่ใช่ปัญหาของ TextPhantom/);
assert.match(temporary.userMessage, /ลองใหม่ภายหลัง/);
assert.equal(temporary.code, 'login_provider_temporarily_unavailable', 'machine code is kept for retry/trace');
ok('website server failure has a provider-temporary public message');

// The sibling pages of the same run carry the same code (nothing re-sent).
const sibling = publicTpError({code: 'login_provider_temporarily_unavailable', origin: 'upstream_ai',
  stage: 'login_run_stopped', httpStatus: 503,
  message: "An earlier page of this run failed: DeepSeek's server is temporarily unavailable. Try again later."});
assert.equal(sibling.userMessage, temporary.userMessage);
ok('sibling pages show the same provider-temporary message');

for (const code of ['login_endpoint_response_invalid', 'login_endpoint_rejected']) {
  const message = userMessageForCode(code);
  assert.notEqual(message, UNKNOWN, code + ' must not read as unknown cause');
  assert.match(message, /เว็บไซต์ AI/);
}
assert.match(userMessageForCode('login_endpoint_response_invalid'), /อ่านไม่ได้/);
assert.doesNotMatch(userMessageForCode('login_endpoint_response_invalid'), /ขัดข้องชั่วคราว/,
  'an unreadable reply is not claimed to be a server outage');
ok('unreadable and rejected website replies have their own messages');

// Web pages show the API's English message in the selected language.
const pageText = await readFile(new URL('../src/shared/page-ui-text.js', import.meta.url), 'utf8');
function pageLanguage(language) {
  const context = {chrome: {storage: {local: {get: (_k, done) => done({uiLanguageV1: language})}, onChanged: {addListener() {}}}}};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(pageText, context);
  return context.TPPageText;
}
const th = pageLanguage('th'), en = pageLanguage('en');
for (const site of ['DeepSeek', 'Claude', 'ChatGPT', 'Gemini']) {
  const english = `${site}'s server is temporarily unavailable. Try again later.`;
  assert.equal(en.display(english), english);
  assert.equal(th.display(english), `เซิร์ฟเวอร์ของ ${site} ขัดข้องชั่วคราว ลองใหม่ภายหลัง`);
}
assert.equal(th.display("DeepSeek's server is temporarily unavailable. Try again later."),
  'เซิร์ฟเวอร์ของ DeepSeek ขัดข้องชั่วคราว ลองใหม่ภายหลัง');
ok('English "<site>\'s server is temporarily unavailable." names the website in Thai');

// The extension's connect flow explains the same failure.
const background = await readFile(new URL('../src/background/login/endpoint/login_endpoint_background.js', import.meta.url), 'utf8');
assert.match(background, /login_provider_temporarily_unavailable:'The provider\\'s server is temporarily unavailable\./);
ok('Login connect flow has a message for the website server failure');

console.log(JSON.stringify({passed: true, checks}));
