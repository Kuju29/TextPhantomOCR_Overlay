import assert from 'node:assert/strict';
import { translationUrl, parseGoogleTranslation, protectNumbers, normalizeUiLanguage,
  UI_LANGUAGES, UI_LANGUAGE_KEY, uiMessage } from '../src/shared/ui-language.js';
import { protectUiText, validUiTranslation, boundedUiCache } from '../src/shared/ui-language-policy.js';
import { validTemplateTranslation, UI_TEMPLATES } from '../src/shared/ui-template.js';
import { canonicalSourceNames } from '../src/shared/constants.js';
import { UI_TEXT } from '../src/shared/ui-text.js';
import { userMessageForCode } from '../src/shared/error-contract.js';
let checks = 0;
const test = (name, fn) => { fn(); ++checks; console.log('PASS ' + name); };
test('Paid account guidance stays translatable after renaming the AI settings tab', () => {
  for (const code of ['PAID_LOGIN_REQUIRED', 'PAID_MODEL_NOT_ALLOWED']) {
    const message = userMessageForCode(code);
    assert(UI_TEXT.has(message));
    assert(message.includes('AI settings'));
    const guarded = protectUiText(message);
    assert.equal(guarded.restore(guarded.source), message);
  }
});
test('original language stays separate from image language codes', () => {
  assert.equal(UI_LANGUAGE_KEY, 'uiLanguageV1');
  assert.equal(normalizeUiLanguage('th'), 'th');
  assert.equal(normalizeUiLanguage('zh-TW'), 'zh-TW');
  assert.equal(normalizeUiLanguage('not-supported'), '');
  assert.equal(UI_LANGUAGES[0][0], '');
});
test('the requested Google endpoint safely encodes authored text', () => {
  const url = new URL(translationUrl('th', 'Copy & reload? ข้อความ\nSave'));
  assert.equal(url.origin, 'https://translate.googleapis.com');
  assert.equal(url.pathname, '/translate_a/single');
  assert.equal(url.searchParams.get('client'), 'gtx');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'th');
  assert.equal(url.searchParams.get('dt'), 't');
  assert.equal(url.searchParams.get('q'), 'Copy & reload? ข้อความ\nSave');
});
test('no endpoint can be injected through a language value', () => {
  assert.throws(() => translationUrl('th&q=private', 'Reload'));
  assert.throws(() => translationUrl('', 'Reload'));
});
test('Google multiline segments are combined in provider order', () => {
  assert.equal(parseGoogleTranslation([[['บัญชี\n', 'Account\n'], ['คำสั่งซื้อ', 'Orders']]]), 'บัญชี\nคำสั่งซื้อ');
});
test('an HTML challenge or malformed provider response cannot become UI text', () => {
  for (const value of ['<html>challenge</html>', {}, null, [[{}]], [[[null]]], [[['']]]])
    assert.throws(() => parseGoogleTranslation(value));
});
test('excessive provider output is rejected', () => {
  assert.throws(() => parseGoogleTranslation([[['x'.repeat(16001)]]]));
});
test('settings, percentages and durations retain their exact source numbers', () => {
  const guarded = protectNumbers('Set 8,192 tokens; 0.7 temperature; 100%; within 24 hours');
  assert(!guarded.source.includes('8,192'));
  assert(!guarded.source.includes('0.7'));
  assert.equal(guarded.restore(guarded.source.replace('Set ', 'ตั้ง ')), 'ตั้ง 8,192 tokens; 0.7 temperature; 100%; within 24 hours');
});
test('loss of a numeric marker fails instead of accepting an altered setting', () => {
  const guarded = protectNumbers('Within 24 hours');
  assert.throws(() => guarded.restore('ภายใน 48 ชั่วโมง'));
});
test('native dialogs preserve original copy before a translator is ready', () => {
  assert.equal(uiMessage('Refund unused credits?'), 'Refund unused credits?');
});
test('native dialogs use the current cached language without networking', () => {
  globalThis.__TP_UI_LANGUAGE = { message: (source) => source === 'Sign out?' ? 'ออกจากระบบ?' : source };
  assert.equal(uiMessage('Sign out?'), 'ออกจากระบบ?');
  assert.equal(uiMessage('unregistered runtime error'), 'unregistered runtime error');
  delete globalThis.__TP_UI_LANGUAGE;
});
test('mode, provider and currency identifiers survive inside a translated sentence', () => {
  const original = 'Paid and Trial use TextPhantom credits; Google Lens and AI use API; Stripe refunds 24 hours';
  const guarded = protectUiText(original);
  for (const term of ['Paid', 'Trial', 'TextPhantom', 'Google Lens', 'AI', 'API', 'Stripe', '24'])
    assert(!guarded.source.includes(term));
  assert.equal(guarded.restore(guarded.source), original);
});
test('ordinary lower-case paid/manual/local words are not frozen as mode names', () => {
  assert.equal(protectUiText('paid manually with local currency').source, 'paid manually with local currency');
});
test('lost, duplicated or fabricated protected values reject the whole translation', () => {
  const guarded = protectUiText('Paid within 24 hours');
  assert.throws(() => guarded.restore('ภายใน 48 ชั่วโมง'));
  assert.throws(() => guarded.restore(guarded.source + ' ZXQAQXZ'));
  assert.throws(() => guarded.restore(guarded.source + ' 48'));
});
test('protected marker identities remain unique beyond 26 values', () => {
  const original = Array.from({ length: 80 }, (_, i) => String(i + 1)).join(' ');
  const guarded = protectUiText(original);
  assert.equal(new Set(guarded.source.split(' ')).size, 80);
  assert.equal(guarded.restore(guarded.source), original);
});
test('complete UI templates permit language-specific value order', () => {
  const source = '{credits} TP added to your account.';
  assert(UI_TEMPLATES.has(source));
  assert(validTemplateTranslation(source, 'เพิ่มเครดิต TP เข้าบัญชีแล้ว {credits}'));
  const guarded = protectUiText(source);
  assert.equal(guarded.restore('เพิ่มเครดิต ZXQBQXZ เข้าบัญชีแล้ว ZXQAQXZ'), 'เพิ่มเครดิต TP เข้าบัญชีแล้ว {credits}');
});
test('template values cannot be dropped, duplicated, invented or replaced with literals', () => {
  for (const translated of ['TP เพิ่มแล้ว', '{credits} {credits} TP', '{amount} TP', '{credits} TP 499,040', '{credits} TP {secret}', '{credits} TP {not_valid}'])
    assert(!validUiTranslation('{credits} TP added.', translated));
});
test('a bounded persistent cache cannot grow without limit across languages', () => {
  const entries = Array.from({ length: 3000 }, (_, i) => ['th\0paid:main:text\0' + i, 'ก'.repeat(120)]);
  const kept = boundedUiCache(entries);
  assert(kept.length <= 1500);
  assert(kept.reduce((sum, [key, value]) => sum + key.length + value.length, 0) <= 200000);
  assert.deepEqual(kept.at(-1), entries.at(-1));
});
test('old API display labels cannot restore Ai while protocol IDs remain identical', () => {
  const sources = [{ id: 'original', name: 'Original' }, { id: 'translated', name: 'Translated' }, { id: 'ai', name: 'Ai' }, { id: 'new-protocol', name: 'New label' }];
  const named = canonicalSourceNames(sources);
  assert.deepEqual(named.map((v) => v.id), sources.map((v) => v.id));
  assert.deepEqual(named.map((v) => v.name), ['Original text', 'Lens translation', 'AI translation', 'New label']);
  assert.equal(sources[2].name, 'Ai');
});
console.log(`UI language contracts passed: ${checks} checks.`);
