// 10490 E2E finding: a provider stream that only sent keep-alives was stopped
// by the API after 60 s (ai_provider_stalled), but the page then showed
// "AI แปลผลไม่ตรงรูปแบบที่ต้องใช้ · AI_OUTPUT_INVALID". The stop is recoverable
// (missing lines go to repair), yet with no line written the ready queue
// dropped the stop reason, so the page had nothing but "no usable translation".
// The real API rows -> server transport -> ready queue must keep the stop
// code with zero lines, and the page outcome must carry the typed code.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const stored = {uiLanguageV1:'th'};
globalThis.chrome = {runtime:{getManifest:()=>({version:'2026.test'})}, storage:{
  local:{get(keys, callback){callback(Array.isArray(keys) ? Object.fromEntries(keys.map(key=>[key, stored[key]]))
    : typeof keys === 'string' ? {[keys]:stored[keys]} : {...keys, ...stored});},
    set(value, callback){Object.assign(stored, value); callback?.();}},
  onChanged:{addListener(){}}}};
const {translateViaServer} = await import('../src/background/ai/transports/server.js');
const {createReadyQueue} = await import('../src/background/ai/translation-paths/ready-queue.js');
const {reserveConversationJob, finishConversationJob} = await import('../src/background/ai/translation-paths/order.js');
const {aiPageFailure} = await import('../src/background/pipeline/result-policy.js');
const {userMessageForCode} = await import('../src/shared/error-contract.js');

const encoder = new TextEncoder();
const row = (sequence, type, extra) => JSON.stringify({schema:'tp.ai.stream/1', sequence, type, ...extra}) + '\n';
let checks = 0;
const ok = (name) => { checks++; console.log('PASS ' + name); };

// ------------------------------------------------------------ ready queue keeps the stop reason
{
  const savedFetch = globalThis.fetch;
  const detail = {schema:'tp.error/1', code:'ai_provider_stalled', message:'AI provider total timeout after 60s',
    origin:'upstream_ai', stage:'provider_request', retryable:true, httpStatus:502, providerAttempts:1,
    generationAttempts:1, requestDispatched:true, streamStop:{code:'ai_provider_stalled', phase:'stalled', linesDone:0, linesTotal:4}};
  // Keep-alives only: waiting rows, the stall row, the typed 502 error.
  const body = row(1, 'progress', {phase:'waiting', keepalive:true, elapsedMs:30000}) +
    row(2, 'progress', {phase:'stalled', reason:'ai_provider_stalled'}) +
    row(3, 'error', {status:502, body:{detail}});
  const seen = [];
  const q = createReadyQueue({choose:async rows => ({units:rows, splitReason:'ready_queue_drained'}),
    dispatch:async (units, _options, plan) => {
      globalThis.fetch = async () => new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(body)); c.close();}}),
        {headers:{'content-type':'application/x-ndjson'}});
      return translateViaServer(units, {base:'https://api.test', targetLang:'th', operationId:'stall-no-lines',
        capabilities:{aiConversation:'tp.conversation/1'}, ai:{provider:'openrouter', model:'m', translation_mode:'conversation'},
        onProgress:plan.onProgress});
    }, afterRequest:async ({pages}) => { for (const page of pages) seen.push(page.streamFailure?.code); }});
  const payload = {source:'ai', lang:'th', context:{page_url:'stall-no-lines', tp_tab_session:'owner', page_index:0},
    metadata:{image_id:'page-0'}, ai:{provider:'openrouter', model:'m', translation_mode:'conversation'}};
  reserveConversationJob(payload, 1);
  let batch;
  const options = {payload, ai:payload.ai, imageId:'page-0', targetLang:'th', sourceLang:'ja', route:'server',
    sourceFingerprint:'c'.repeat(64), afterBatchResult:async data => { batch = data; }};
  let result, error;
  try { result = await q.submit([0, 1, 2, 3].map(i => ({id:`P${i}`, text:`来年の私 ${i}`})), options); }
  catch (e) { error = e; }
  finally { finishConversationJob(payload); q.close(); globalThis.fetch = savedFetch; }
  assert.equal(error, undefined, 'a stall is recoverable: the page goes on to repair, not to an error');
  assert.deepEqual(result.translations, []);
  assert.deepEqual(result.missing, ['P0', 'P1', 'P2', 'P3']);
  assert.equal(result.meta.streamFailure?.code, 'ai_provider_stalled', 'the stop reason survives with zero lines');
  assert.equal(batch.streamFailure?.code, 'ai_provider_stalled', 'the batch checkpoint sees the same reason');
  assert.deepEqual(seen, ['ai_provider_stalled']);
  ok('stalled stream with no lines: ready queue resolves missing lines AND keeps ai_provider_stalled');
}

// ------------------------------------------------------------ page outcome uses the typed code
{
  const source = await readFile(new URL('../src/background/pipeline/page-translation.js', import.meta.url), 'utf8');
  const table = source.match(/const STREAM_STOP_PAGE_CODES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert(table, 'page-translation maps stream stop codes for a page with no translated line');
  const map = Object.fromEntries([...table[1].matchAll(/(\w+): "(\w+)"/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(map, {ai_provider_stalled:'AI_STALLED', ai_thinking_too_long:'AI_THINKING_TOO_LONG',
    ai_output_no_progress:'AI_OUTPUT_NO_PROGRESS', ai_stream_ceiling:'AI_STREAM_CEILING'});
  assert.match(source, /translatedCount <= 0[\s\S]{0,600}STREAM_STOP_PAGE_CODES\[String\(outcome\?\.meta\?\.streamFailure\?\.code/,
    'the no-translation outcome reads the stream stop');
  for (const [stop, code] of Object.entries(map)) {
    assert.equal(aiPageFailure({usable:false, code}).code, code, `${stop}: page failure keeps ${code}`);
    assert.notEqual(userMessageForCode(code), userMessageForCode('AI_OUTPUT_INVALID'), `${code}: its own message`);
  }
  assert.match(userMessageForCode('AI_STALLED'), /หยุดตอบกลับ/);
  assert.equal(aiPageFailure({usable:false}).code, 'AI_OUTPUT_INVALID', 'no stop reason: unchanged');
  ok('page with no translated line after a stream stop reports AI_STALLED (etc.), not AI_OUTPUT_INVALID');
}
console.log(`${checks} checks passed`);
