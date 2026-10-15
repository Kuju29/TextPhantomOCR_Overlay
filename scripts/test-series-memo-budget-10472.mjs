// .72 owner design for Series memory (TP_MEMO):
// - Economy budget: one request carries at most 900 characters of memos.
// - Conversation: previous chapters only (sent once with the first prompt).
// - Independent / single translations: previous chapters + this chapter so far.
// - Too many memos: first, last and evenly spaced ones are kept, in story
//   order (not only the newest pages).
// - Single translations (no page index) accumulate after the last page;
//   an identical memo is not stored twice.
import assert from 'node:assert/strict';
import {mergeChapterSummaries, priorChapterState, sampleSnippets, SERIES_MEMORY_BUDGET} from '../src/background/chapter-summary-store.js';
import {seriesSummaryInstruction} from '../src/shared/ai/series-summary.js';

let checks = 0;
const ch1 = 'https://reader.test/series/ch-1', ch2 = 'https://reader.test/series/ch-2';
const memo = (page, text) => ({text, pageIndex: page, sourceIds: ['g1']});
const len = s => [...s].length;

// Sampling keeps first, last and evenly spaced items, in order, within budget.
const texts = Array.from({length: 10}, (_, i) => `page${i}-` + 'x'.repeat(90));
const picked = sampleSnippets(texts, 300);
assert.equal(picked[0], texts[0]); assert.equal(picked.at(-1), texts[9]);
assert.ok(picked.length >= 2 && picked.length < 10);
assert.deepEqual(picked, texts.filter(t => picked.includes(t)), 'story order kept');
assert.ok(picked.join('\n').length <= 300);
assert.deepEqual(sampleSnippets(texts.slice(0, 2), 900), texts.slice(0, 2), 'fits: all kept');
checks += 5;

// Chapter 1 translated with 12 long memos; chapter 2 starts.
let state = {};
for (let i = 0; i < 12; i++) state = mergeChapterSummaries(state, ch1, [memo(i, `ch1 p${i}: ` + 'ก'.repeat(150))]);
state = mergeChapterSummaries(state, ch2, [memo(0, 'ch2 p0: เรนเจอร์ (ไม่ทราบชื่อ) พบ Aiko'), memo(1, 'ch2 p1: Aiko ขอบคุณ')]);

const conversation = priorChapterState(state, ch2).summary;
assert.ok(len(conversation) <= SERIES_MEMORY_BUDGET, 'Conversation within 900');
assert.ok(conversation.includes('ch1 p0:') && conversation.includes('ch1 p11:'), 'first and last page of chapter 1');
assert.ok(!conversation.includes('ch2 '), 'Conversation never repeats its own chapter');
checks += 3;

const independent = priorChapterState(state, ch2, {includeCurrent: true}).summary;
assert.ok(len(independent) <= SERIES_MEMORY_BUDGET, 'Independent within 900');
assert.ok(independent.includes('ch2 p0:') && independent.includes('ch2 p1:'), 'this chapter so far');
assert.ok(independent.includes('ch1 p0:'), 'previous chapter still present');
assert.ok(independent.indexOf('ch1 ') < independent.indexOf('ch2 '), 'story order');
checks += 4;

// Chapter 1 itself (first chapter): nothing to send to Conversation.
assert.equal(priorChapterState(state, ch1).summary, '');
checks += 1;

// Single translations: no page index -> appended in order; duplicates ignored.
let single = mergeChapterSummaries({}, ch1, [{text: 'one', pageIndex: null, sourceIds: ['g1']}]);
single = mergeChapterSummaries(single, ch1, [{text: 'two', sourceIds: ['g1']}]);
single = mergeChapterSummaries(single, ch1, [{text: 'two', sourceIds: ['g2']}]);
assert.equal(priorChapterState(single, ch1, {includeCurrent: true}).summary, 'one\ntwo');
checks += 1;

// The instruction asks for names (or "unknown"), explicit gender only, several items allowed.
const th = seriesSummaryInstruction('th');
for (const phrase of ['ไม่ทราบชื่อ', 'ห้ามเดาชื่อ', 'เพศเฉพาะเมื่อข้อความบอกชัด', 'หลายตัวละครหลายเหตุการณ์', 'บรรทัดเดียว'])
  assert.ok(th.includes(phrase), phrase);
assert.match(seriesSummaryInstruction('en'), /never guess a name/);
checks += 2;
console.log(`PASS ${checks} Series memo checks: 900-character budget, sampled first/last/evenly, Conversation previous chapters only, Independent/single accumulate`);
