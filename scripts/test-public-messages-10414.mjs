import assert from 'node:assert/strict';
import { userMessageForCode, publicTpError } from '../src/shared/error-contract.js';
import { UI_TEXT } from '../src/shared/ui-text.js';
import { readFileSync } from 'node:fs';

const codes = [
  'PAID_PROVIDER_CAPACITY', 'PAID_PROVIDER_KEY_LIMIT', 'PAID_PROVIDER_ROUTE',
  'PAID_PROVIDER_AUTH', 'PAID_PROVIDER_BALANCE', 'PAID_PROVIDER_FORBIDDEN',
  'PAID_PROVIDER_REQUEST', 'PAID_PROVIDER_FAILED', 'PAID_PENDING_CALLS',
  'PAID_PRICE_UNVERIFIED', 'PAID_RECONCILIATION_REQUIRED', 'PAID_LEDGER_UNAVAILABLE',
  'PAID_RATE_LIMITED', 'PAID_AI_NOT_CONFIGURED', 'PAID_PAUSED',
  'PAID_CENTER_UNAVAILABLE', 'PAID_DAILY_BUDGET', 'PAID_THINKING_UNVERIFIED',
];
for (const code of codes) {
  const message = userMessageForCode(code);
  assert.ok(message.length > 5, `${code} needs a customer explanation`);
  assert.ok(UI_TEXT.has(message), `${code} needs an authored translation source`);
  assert.ok(!/(?:Control Center|OpenRouter|TP_CENTER_|gateway\.key|ตั้งค่า\s*>|ตรวจ.*log)/i.test(message), code);
  const error = publicTpError({ code, message: 'PRIVATE-OPERATOR-STEP' });
  assert.equal(error.code, code);
  assert.equal(error.userMessage, message);
  assert.ok(!JSON.stringify(error).includes('PRIVATE-OPERATOR-STEP'));
}
// .69: the Center refuses an image the balance cannot cover before any AI call (log: credit-confirm).
assert.match(userMessageForCode('PAID_INSUFFICIENT_CREDITS'), /เครดิตไม่พอสำหรับภาพนี้.*ยังไม่ได้ส่ง AI.*ไม่หักเครดิต/);
assert.ok(!userMessageForCode('PAID_INSUFFICIENT_CREDITS').includes('วงเงินจอง'));
assert.match(userMessageForCode('PAID_MODEL_NOT_ALLOWED'), /โมเดล/);
const texts = [
  'Refunds are temporarily unavailable. Contact support.',
  'Payments are not available yet. Your existing credits and orders remain available.',
  // 10488: the per-state AI think hint (loading) replaced the single 'Thinking is unverified' hint.
  'AI think options appear after the selected model is checked. Translation waits for them; your saved choice is kept.',
];
for (const text of texts) assert.ok(UI_TEXT.has(text), `authored translation source: ${text}`);
const popup = readFileSync(new URL('../src/popup/controllers/popup-ui-controller.js', import.meta.url), 'utf8');
assert.ok(popup.includes(texts[2]));
assert.ok(!popup.includes('Refresh OpenRouter in Center.'));
for (const file of ['../src/popup/controllers/paid-service-controller.js',
  '../src/background/ai-profile-resolver.js', '../src/paid/account.js', '../src/paid/inline.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.ok(!/(?:TP_CENTER_URL|Center → Service controls|Settings → Paid AI|Update the.*Control Center)/.test(source), file);
}
console.log(`Customer public messages passed: ${codes.length} Paid codes, own-credit/model actions, authored translation sources and Thinking hint.`);
