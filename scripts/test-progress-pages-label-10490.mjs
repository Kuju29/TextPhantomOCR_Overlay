// 10490 E2E finding: the status read "กำลังแปล 51/98 บรรทัด · 1p/14u" — the
// line count belongs to the whole provider request (several pages in one
// Conversation turn) while "1p/14u" came from one page lane. The status now
// names the pages of that request, in English and Thai alike:
//   "Translating 51/98 lines (pages 2–5)" / "กำลังแปล 51/98 บรรทัด (หน้า 2–5)"
// and no "<n>p/<n>u" scope reaches the page (it stays in traces).
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const pageText = await read('src/shared/page-ui-text.js');
const panel = await read('src/content/progress-panel.js');
let checks = 0;
const ok = name => { checks++; console.log('PASS ' + name); };
const SCOPE = /\d+p\/\d+u|\(\d+p\b|\bturn\)/;

function render(language) {
  const node = () => ({style:{}, dataset:{}, children:[], isConnected:true, textContent:'', title:'',
    appendChild(child){this.children.push(child); return child;}, addEventListener(){}, setAttribute(){},
    contains(){return false;}, querySelectorAll(){return [];}});
  const host = {root:node(), main:node(), text:node(), toggle:node(), details:node()};
  const context = {window:null, document:{addEventListener(){}, removeEventListener(){}, createElement:node},
    setInterval:() => 1, clearInterval(){}, setTimeout, clearTimeout,
    chrome:{storage:{local:{get:(_k, done) => done({uiLanguageV1:language})}, onChanged:{addListener(){}}}}};
  context.globalThis = context;
  context.window = {__TP:{bail:false, getToastProgressHost:() => host, setToastProgressMode(){}}, addEventListener(){}};
  vm.createContext(context);
  vm.runInContext(pageText, context); vm.runInContext(panel, context);
  let sequence = 0;
  return async items => {
    context.window.__TP.updateBatchProgress({id:'pages-' + language, sequence:++sequence, startedAt:Date.now() + 10,
      total:items.length, lifecycle:'processing', terminal:0, items});
    await new Promise(resolve => setTimeout(resolve, 110));
    return host.text.textContent;
  };
}
const now = Date.now();
// One Conversation request with pages 2–5 (98 lines; each page lane keeps its
// own 14-unit count), page 1 already placed, page 6 queued for the next turn.
const request = {phase:'writing', linesDone:51, linesTotal:98, receivedAt:now - 200};
const lane = (pageIndex, ai) => ({label:`Image ${pageIndex + 1}`, pageIndex, terminal:false, inserted:false,
  progress:{overall:{state:'running'}, ai, insert:{state:'queued'}, result:{state:'pending'}}});
const writing = [1, 2, 3, 4].map(i => lane(i, {state:'running', function:'provider_stream', streamPhase:request,
  startedAt:now - 9000, conversation:true, pageCount:1, unitCount:14, turn:2}));
const items = [{...lane(0, {state:'done'}), terminal:true, inserted:true}, ...writing,
  lane(5, {state:'queued', function:'waiting_slot'})];
{
  const th = await render('th')(items), en = await render('')(items);
  assert.match(th, /กำลังแปล 51\/98 บรรทัด \(หน้า 2–5\)/, th);
  assert.match(en, /Translating 51\/98 lines \(pages 2–5\)/, en);
  assert.doesNotMatch(th, SCOPE, 'no cryptic page/unit scope: ' + th);
  assert.doesNotMatch(en, SCOPE, 'no cryptic page/unit scope: ' + en);
  assert.match(th, /คิว 1 หน้า/, 'the next turn is still counted as queued');
  ok('request-level line count names the pages of that request (Thai/English)');
}
{
  // Another request's page (different phase stamp) is not counted in this one.
  const other = lane(8, {state:'running', function:'provider_stream', conversation:true, turn:1,
    streamPhase:{phase:'thinking', phaseElapsedMs:1000, receivedAt:now - 5000}, startedAt:now - 6000});
  const text = await render('')([...writing, other]);
  assert.match(text, /Translating 51\/98 lines \(pages 2–5\)/, text);
  // A request of one page, and pages that are not consecutive.
  const single = await render('th')([lane(2, {state:'running', function:'provider_stream', conversation:true, turn:1,
    streamPhase:{phase:'thinking', phaseElapsedMs:3000, receivedAt:Date.now()}, startedAt:now})]);
  assert.match(single, /AI กำลังคิด… \(3 วิ\) \(หน้า 3\)/, single);
  const split = await render('')([1, 2, 6].map(i => lane(i, {state:'running', function:'provider_stream', conversation:true,
    turn:1, streamPhase:{phase:'waiting', receivedAt:now - 100}, startedAt:now})));
  assert.match(split, /Waiting for provider… \(pages 2–3, 7\)/, split);
  ok('only the pages of the shown request are named; single and split page lists');
}
{
  // Before the stream opens: the same page naming instead of "(3p/45u turn)".
  const sending = [0, 1, 2].map(i => lane(i, {state:'running', function:'waiting_response_text', startedAt:now,
    conversation:true, pageCount:3, unitCount:45, turn:1}));
  const th = await render('th')(sending), en = await render('')(sending);
  assert.match(en, /AI request waiting for response text \(pages 1–3\)/, en);
  assert.match(th, /คำขอ AI รอข้อความตอบกลับ \(หน้า 1–3\)/, th);
  assert.doesNotMatch(th + en, SCOPE);
  // Separate (non-Conversation) page requests running together.
  const independent = await render('')([0, 4].map(i => lane(i, {state:'running', function:'waiting_response',
    startedAt:now, unitCount:10})));
  assert.match(independent, /AI waiting response \(pages 1, 5\)/, independent);
  ok('request phases before the stream use the same page naming; no "<n>p/<n>u"');
}
{
  // Rows without a known page number fall back to a page count.
  const unnamed = await render('th')([{terminal:false, progress:{overall:{state:'running'}, ai:{state:'running',
    function:'waiting_response_text', startedAt:now, conversation:true, turn:1}, insert:{state:'queued'}, result:{state:'pending'}}}]);
  assert.match(unnamed, /\(1 หน้า\)/, unnamed);
  assert.doesNotMatch(panel, /\$\{pages\}p\/\$\{units\}u/, 'the page/unit scope string is gone from the page status');
  ok('unknown page numbers read as a page count');
}
console.log(`${checks} checks passed`);
