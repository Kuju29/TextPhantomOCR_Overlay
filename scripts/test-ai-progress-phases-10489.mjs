// 10489: the bottom-right status shows what the provider stream is doing
// ("waiting at provider", "AI is thinking… (xx s)", "Translating 12/93 lines",
// "No response — stopping") instead of looking stuck, updated ≤ 2×/s.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const stored = {uiLanguageV1:'th'};
globalThis.chrome = {runtime:{getManifest:()=>({version:'2026.test'})}, storage:{
  local:{get(keys, callback){callback(Array.isArray(keys) ? Object.fromEntries(keys.map(key=>[key, stored[key]]))
    : typeof keys === 'string' ? {[keys]:stored[keys]} : {...keys, ...stored});},
    set(value, callback){Object.assign(stored, value); callback?.();}},
  onChanged:{addListener(){}}}};
const {readAiStream, translateViaServer} = await import('../src/background/ai/transports/server.js');
const {createPhaseThrottle, normalizeStreamPhase, PHASE_UI_INTERVAL_MS, STREAM_PHASE_HEADER, closedLineCount,
  createLocalPhaseTracker} = await import('../src/shared/ai/stream-phase.js');
const {readProviderResponse} = await import('../src/shared/ai/providers/local-transport-runtime.js');
const {createReadyQueue} = await import('../src/background/ai/translation-paths/ready-queue.js');
const {reserveConversationJob, finishConversationJob} = await import('../src/background/ai/translation-paths/order.js');
const {mergeProgressDetail, createImageProgress, publicImageProgress} = await import('../src/background/progress/image-progress-store.js');
const {userMessageForCode} = await import('../src/shared/error-contract.js');
const {createStreamRecords} = await import('../src/background/ai/translation-paths/stream-records.js');

let checks = 0;
const ok = (name) => { checks++; console.log('PASS ' + name); };
const encoder = new TextEncoder();
const row = (sequence, type, extra) => JSON.stringify({schema:'tp.ai.stream/1', sequence, type, ...extra}) + '\n';

// ------------------------------------------------------------ envelope
{
  const seen = [], deltas = [];
  const body = row(1, 'progress', {phase:'waiting', keepalive:true, elapsedMs:900}) +
    row(2, 'progress', {phase:'thinking', phaseElapsedMs:4200, elapsedMs:5100, thinkingLimitMs:136000, linesTotal:93}) +
    row(3, 'delta', {text:'<<TP_P0:a>>'}) +
    row(4, 'progress', {phase:'writing', linesDone:12, linesTotal:93, text:'leak'}) +
    row(5, 'result', {body:{ok:true}});
  const terminal = await readAiStream(new Response(body), text => deltas.push(text), phase => seen.push(phase));
  assert.deepEqual(terminal, {status:200, body:{ok:true}});
  assert.deepEqual(seen.map(p => p.phase), ['waiting', 'thinking', 'writing']);
  assert.equal(seen[0].keepalive, true);
  assert.equal(seen[1].phaseElapsedMs, 4200);
  assert.equal(seen[2].linesDone, 12); assert.equal(seen[2].linesTotal, 93);
  assert.equal('text' in seen[2], false, 'phase rows never carry model text');
  assert.deepEqual(deltas, ['<<TP_P0:a>>']);
  await assert.rejects(readAiStream(new Response(row(1, 'progress', {phase:'dreaming'}))), {code:'invalid_ai_stream'});
  await assert.rejects(readAiStream(new Response(row(1, 'unknown', {}))), {code:'invalid_ai_stream'});
  assert.equal(normalizeStreamPhase({phase:'writing', linesDone:120, linesTotal:93}).linesDone, 93, 'done never exceeds total');
  ok('progress rows are read from the stream envelope; malformed rows still rejected');
}

// ------------------------------------------------------------ throttle
{
  let clock = 0; const timers = []; const out = [];
  const throttle = createPhaseThrottle(value => out.push([clock, value.phase]), {
    now: () => clock, setTimer: (fn, ms) => { timers.push({fn, at: clock + ms}); return timers.length; },
    clearTimer: id => { timers[id - 1].fn = null; }});
  const run = until => { for (const timer of timers) if (timer.fn && timer.at <= until) { clock = timer.at; const fn = timer.fn; timer.fn = null; fn(); } clock = until; };
  throttle.push({phase:'waiting'});
  for (let t = 50; t <= 2000; t += 50) { run(t); throttle.push({phase:t < 1000 ? 'thinking' : 'writing'}); }
  run(3000);
  for (let i = 1; i < out.length; i++) assert(out[i][0] - out[i - 1][0] >= PHASE_UI_INTERVAL_MS, 'at most one update per 500 ms');
  assert(out.length <= Math.ceil(2500 / PHASE_UI_INTERVAL_MS) + 1, 'pushes over 2 s plus one trailing window');
  assert.equal(out.at(-1)[1], 'writing', 'the newest phase is never lost');
  throttle.push({phase:'writing'}); throttle.final({phase:'stalled'});
  assert.equal(out.at(-1)[1], 'stalled', 'a stop is shown at once');
  throttle.push({phase:'writing'}); throttle.close(); run(5000);
  assert.equal(out.at(-1)[1], 'stalled', 'close() drops a pending update after the terminal event');
  ok(`UI throttle: ${out.length} updates for 41 phase rows over 2 s, trailing flush, immediate stop`);
}

// ------------------------------------------------------------ server transport
{
  const savedFetch = globalThis.fetch;
  try {
    let captured;
    const events = [];
    const body = row(1, 'progress', {phase:'waiting', keepalive:true}) +
      Array.from({length:30}, (_, i) => row(i + 2, 'progress', {phase:'thinking', phaseElapsedMs:i * 100})).join('') +
      row(32, 'delta', {text:'<<TP_P0:translated>>'}) +
      row(33, 'progress', {phase:'writing', linesDone:1, linesTotal:1}) +
      row(34, 'result', {body:{schema:'tp.ai.result/1', translations:[{id:'P0', text:'translated'}], missing:[],
        meta:{generationAttempts:1, usage:{inputTokens:3, outputTokens:2, totalTokens:5}}}});
    globalThis.fetch = async (_url, init) => { captured = init;
      return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(body)); c.close();}}),
        {headers:{'content-type':'application/x-ndjson'}}); };
    const answer = await translateViaServer([{id:'P0', text:'source'}], {base:'https://api.test', targetLang:'th',
      operationId:'phases-1', capabilities:{aiConversation:'tp.conversation/1'},
      ai:{provider:'openrouter', model:'m', translation_mode:'conversation'}, onProgress:event => events.push(event)});
    assert.equal(answer.translations[0].text, 'translated');
    assert.equal(captured.headers[STREAM_PHASE_HEADER], '1', 'the client asks for phase rows');
    assert.equal(captured.headers.Accept, 'application/x-ndjson');
    const phases = events.filter(e => e.state === 'provider_phase');
    assert(phases.length >= 1 && phases.length <= 2, `31 rows inside one window → ≤ 2 UI updates (got ${phases.length})`);
    assert.equal(phases[0].phase.phase, 'waiting');
    assert.equal(events.some(e => e.state === 'receiving_content'), false, 'phase rows replace the generic receiving label');
    assert(events.some(e => e.state === 'translation_delta'), 'content still streams to the page');
    ok('server transport: phase header, throttled provider_phase events, content unchanged');
  } finally { globalThis.fetch = savedFetch; }
}

// ------------------------------------------------------------ progress store
{
  const now = Date.now();
  let progress = createImageProgress(now);
  progress = mergeProgressDetail(progress, {phase:'http_wait'}, now);
  progress = mergeProgressDetail(progress, {providerPhase:normalizeStreamPhase({phase:'thinking', phaseElapsedMs:3000}, now)}, now + 1);
  let ai = publicImageProgress(progress, now + 2).ai;
  assert.equal(ai.state, 'running'); assert.equal(ai.function, 'provider_stream');
  assert.equal(ai.streamPhase.phase, 'thinking'); assert.equal(ai.streamPhase.phaseElapsedMs, 3000);
  assert.equal(ai.detail, 'AI is thinking…');
  progress = mergeProgressDetail(progress, {providerPhase:{phase:'writing', linesDone:12, linesTotal:93, receivedAt:now}}, now + 3);
  ai = publicImageProgress(progress).ai;
  assert.deepEqual([ai.streamPhase.linesDone, ai.streamPhase.linesTotal], [12, 93]);
  progress = mergeProgressDetail(progress, {phase:'validating'}, now + 4);
  assert.equal(publicImageProgress(progress).ai.function, 'validating_result', 'a later AI step replaces the live phase');
  progress = mergeProgressDetail(progress, {providerPhase:{phase:'bogus'}}, now + 5);
  assert.equal(publicImageProgress(progress).ai.function, 'validating_result', 'unknown phases are ignored');
  ok('progress store keeps a bounded live phase on the AI lane');
}

// ------------------------------------------------------------ page status
{
  const pageText = await readFile(new URL('../src/shared/page-ui-text.js', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/content/progress-panel.js', import.meta.url), 'utf8');
  const render = (language) => {
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
    return async (streamPhase, unitCount = 93) => {
      const start = Date.now();
      context.window.__TP.updateBatchProgress({id:'b-' + language, sequence:++sequence, startedAt:start + 10, total:1,
        lifecycle:'processing', terminal:0, items:[{label:'Image 1', terminal:false, progress:{overall:{state:'running'},
          ai:{state:'running', function:'provider_stream', streamPhase, startedAt:start, conversation:true, pageCount:1, unitCount, turn:1},
          insert:{state:'queued'}, result:{state:'pending'}}}]});
      await new Promise(resolve => setTimeout(resolve, 110));
      return host.text.textContent;
    };
  };
  const th = render('th'), en = render('');
  const now = Date.now();
  assert.match(await th({phase:'waiting', receivedAt:now}), /กำลังรอผู้ให้บริการ… \(หน้า 1\)/);
  assert.match(await th({phase:'thinking', phaseElapsedMs:41_000, receivedAt:Date.now() - 2_000}), /AI กำลังคิด… \(43 วิ\)/,
    'the thinking timer keeps counting between updates');
  assert.match(await th({phase:'writing', linesDone:12, linesTotal:93, receivedAt:now}), /กำลังแปล 12\/93 บรรทัด/);
  assert.match(await th({phase:'writing', linesDone:7, linesTotal:null, receivedAt:now}, 40), /กำลังแปล 7\/40 บรรทัด/,
    'without an API total the request unit count is used');
  assert.match(await th({phase:'stalled', receivedAt:now}), /ไม่มีการตอบกลับ — กำลังหยุด/);
  assert.match(await th({phase:'stopping', reason:'ai_thinking_too_long', receivedAt:now}), /AI คิดนานเกินไป — กำลังหยุด/);
  assert.match(await th({phase:'stopping', reason:'ai_output_no_progress', receivedAt:now}), /ไม่มีบรรทัดใหม่ — กำลังหยุด/);
  assert.match(await en({phase:'thinking', phaseElapsedMs:5_000, receivedAt:Date.now()}), /AI is thinking… \(5s\) \(page 1\)/);
  assert.match(await en({phase:'writing', linesDone:12, linesTotal:93, receivedAt:now}), /Translating 12\/93 lines/);
  assert.match(await en({phase:'waiting', receivedAt:now}), /Waiting for provider…/);
  ok('progress panel renders every phase in Thai and English');
}

// ------------------------------------------------------------ stops
{
  const queue = await readFile(new URL('../src/background/ai/translation-paths/ready-queue.js', import.meta.url), 'utf8');
  const recoverable = queue.match(/\/(invalid_model_output\|[^/]+)\/i\.test\(String\(error\.code/)[1];
  for (const code of ['ai_provider_stalled', 'ai_output_no_progress', 'ai_stream_ceiling'])
    assert(new RegExp(recoverable, 'i').test(code), `${code}: completed lines are kept`);
  const units = [0, 1, 2, 3].map(i => ({id:'P' + i, text:'s'}));
  const stream = createStreamRecords(units);
  stream.push('<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>\n<<TP_P2:ซ้ำซ้ำซ้ำ');
  stream.finish();
  assert.deepEqual([...stream.accepted.keys()], ['P0', 'P1'], 'a stop mid-line keeps only closed lines');
  for (const [code, text] of [['ai_provider_stalled', /หยุดตอบกลับ/], ['ai_thinking_too_long', /คิดนานเกินงบเวลา/],
    ['ai_output_no_progress', /บรรทัดที่เสร็จแล้วยังถูกเก็บไว้/], ['ai_stream_ceiling', /เพดานความปลอดภัย/]])
    assert.match(userMessageForCode(code), text, code);
  ok('stop codes: completed lines salvaged on writing-phase stops; Thai user messages');
}

// ------------------------------------------------------------ partial lines kept, end to end
// The NDJSON rows below are what the API sends for a writing-phase stop
// (asserted field by field in test-ai-progress-phases-10489.py,
// WritingStopEndToEndTests): two closed records, a stop row, then a typed
// error carrying requestDispatched/generationAttempts. The real server
// transport turns them into deltas + a thrown error; the real ready queue
// must keep the two finished lines and send only the rest to repair.
{
  const savedFetch = globalThis.fetch;
  const stopDetail = code => ({schema:'tp.error/1', code, message:'stopped', origin:'upstream_ai',
    stage:'provider_request', retryable:false, httpStatus:502, providerAttempts:1, generationAttempts:1,
    requestDispatched:true, streamStop:{code, phase:'writing', linesDone:2, linesTotal:4}});
  const run = async (code, withLines) => {
    let deltaIds = [];
    const q = createReadyQueue({choose:async rows => ({units:rows, splitReason:'ready_queue_drained'}),
      dispatch:async (units, _options, plan) => {
        deltaIds = units.map(u => u.id);
        let sequence = 0;
        const body = row(++sequence, 'progress', {phase:'thinking', phaseElapsedMs:900}) +
          (withLines ? row(++sequence, 'delta', {text:`<<${units[0].id}:หนึ่ง>>\n<<${units[1].id}:สอง>>\n<<${units[2].id}:ซ้ำซ้ำ`}) +
            row(++sequence, 'progress', {phase:'writing', linesDone:2, linesTotal:4}) : '') +
          row(++sequence, 'progress', {phase:'stopping', reason:code, linesDone:withLines ? 2 : null}) +
          row(++sequence, 'error', {status:502, body:{detail:stopDetail(code)}});
        globalThis.fetch = async () => new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(body)); c.close();}}),
          {headers:{'content-type':'application/x-ndjson'}});
        return translateViaServer(units, {base:'https://api.test', targetLang:'th', operationId:`stop-${code}-${withLines}`,
          capabilities:{aiConversation:'tp.conversation/1'}, ai:{provider:'openrouter', model:'m', translation_mode:'conversation'},
          onProgress:plan.onProgress});
      }});
    const payload = {source:'ai', lang:'th', context:{page_url:`stop-${code}-${withLines}`, tp_tab_session:'owner', page_index:0},
      metadata:{image_id:'page-0'}, ai:{provider:'openrouter', model:'m', translation_mode:'conversation'}};
    reserveConversationJob(payload, 1);
    const options = {payload, ai:payload.ai, imageId:'page-0', targetLang:'th', sourceLang:'en', route:'server',
      sourceFingerprint:'b'.repeat(64)};
    try {
      return {result:await q.submit([0, 1, 2, 3].map(i => ({id:`P${i}`, text:`source ${i}`})), options), deltaIds};
    } catch (error) { return {error, deltaIds}; }
    finally { finishConversationJob(payload); q.close(); }
  };
  try {
    for (const code of ['ai_output_no_progress', 'ai_provider_stalled', 'ai_stream_ceiling']) {
      const {result, error} = await run(code, true);
      assert.equal(error, undefined, `${code}: ${error?.message}`);
      assert.deepEqual(result.translations.map(t => [t.id, t.text]), [['P0', 'หนึ่ง'], ['P1', 'สอง']],
        `${code}: the two closed lines are kept, the open one is not`);
      assert.deepEqual(result.missing, ['P2', 'P3'], `${code}: the rest goes to repair`);
      assert.equal(result.meta.streamFailure.code, code);
    }
    const thinking = await run('ai_thinking_too_long', false);
    assert.equal(thinking.error?.code, 'ai_thinking_too_long', 'nothing was written: the stop is the result');
    assert.equal(thinking.error?.requestDispatched, true);
  } finally { globalThis.fetch = savedFetch; }
  ok('writing-phase stop: API rows → server transport → ready queue keeps closed lines, repairs the rest');
}

// ------------------------------------------------------------ browser-direct Local AI
{
  // Same counting rule as the API (LineCompletionDetector.closed_count).
  assert.equal(closedLineCount('<<TP_P0:a>>\n<<TP_P1:b', ['P0', 'P1', 'P2']), 1);
  assert.equal(closedLineCount('<<TP_P0:a>>\n<<TP_P1:b>>\n<<TP_P9:z>>', ['P0', 'P1', 'P2']), 2, 'unknown ids never count');
  assert.equal(closedLineCount('{"P0": "a", "P1": "b', ['P0', 'P1', 'P2']), 1);
  assert.equal(closedLineCount('<<I2_P0:a>>\n<<I2_P1:>>'), 1, 'an empty record is not a line');

  let clock = 0; const shown = []; const timers = [];
  const tracker = createLocalPhaseTracker(value => shown.push(value), {now:() => clock,
    setTimer:(fn, ms) => { timers.push({fn, at:clock + ms}); return timers.length; }, clearTimer:id => { timers[id - 1].fn = null; }});
  const run = until => { for (const t of timers) if (t.fn && t.at <= until) { clock = t.at; const fn = t.fn; t.fn = null; fn(); } clock = until; };
  assert.equal(tracker.observe('connecting'), false, 'connecting keeps its own label');
  clock = 100; assert.equal(tracker.observe('waiting_for_model'), true);
  clock = 700; tracker.observe('thinking');
  run(3700); tracker.observe('thinking');
  clock = 5000; tracker.observe('first_response', {linesDone:0, linesTotal:6});
  run(5600); tracker.observe('generating', {linesDone:4, linesTotal:6});
  run(7000);
  assert.deepEqual(shown.map(v => v.phase), ['waiting', 'thinking', 'thinking', 'writing', 'writing']);
  for (let i = 1; i < shown.length; i++) assert(shown[i].receivedAt - shown[i - 1].receivedAt >= PHASE_UI_INTERVAL_MS);
  assert.equal(shown[2].phaseElapsedMs, 3000, 'thinking time counts from the first reasoning frame');
  assert.deepEqual([shown.at(-1).linesDone, shown.at(-1).linesTotal], [4, 6]);
  assert.equal(tracker.observe('waiting_for_terminal'), false);
  tracker.observe('generating', {linesDone:5}); run(9000);
  assert.equal(shown.at(-1).phase, 'writing');
  assert.equal(tracker.observe('completed'), false, 'completion keeps the existing Local label');

  // The real reader reports closed lines against the request's IDs.
  const adapter = {streamMode:'fixture', drainGraceMs:0, isStreamingResponse:() => true, emptyEnvelope:() => ({}),
    mergeEnvelope(){}, finalizeEnvelope:(_e, content) => ({content}), usage:() => ({}), finishReason:() => 'stop',
    terminalCompleted:({terminal}) => terminal, shouldDrainAfterCompletion:() => false,
    normalizeLine(line) {
      if (!line) return {kind:'empty'};
      if (line === '[DONE]') return {kind:'terminal'};
      const item = JSON.parse(line);
      return {kind:'item', item, reasoning:item.r || '', content:item.c || ''};
    }};
  const frames = [{r:'plan'}, {c:'<<TP_P0:หนึ่ง>>\n<<TP_P1:'}, {c:'สอง>>\n'}].map(f => JSON.stringify(f) + '\n').join('') + '[DONE]\n';
  const events = [];
  const realNow = performance.now.bind(performance); let fake = 0;
  performance.now = () => (fake += 400);  // every frame is past the reader's 350 ms status throttle
  try {
    await readProviderResponse(new Response(frames), adapter, {expectedIds:['P0', 'P1', 'P2'], onProgress:e => events.push(e)});
  } finally { performance.now = realNow; }
  assert.deepEqual(events.map(e => e.state), ['thinking', 'first_response', 'generating']);
  assert.deepEqual(events.slice(1).map(e => [e.linesDone, e.linesTotal]), [[1, 3], [2, 3]]);
  ok('browser-direct Local AI: same line rule, report-only waiting/thinking/writing phases, ≤ 2 updates/s');
}

console.log(`PASS ${checks} groups: provider stream phases in the in-page status`);
