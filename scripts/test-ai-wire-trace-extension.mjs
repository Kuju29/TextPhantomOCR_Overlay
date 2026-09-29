import assert from "node:assert/strict";
import { AI_WIRE_TRACE_SCHEMA, aiWireTraceEnabled, createAiWireRecorder,
  redactAiWireValue } from "../src/background/ai/wire-trace.js";

assert.equal(AI_WIRE_TRACE_SCHEMA, "tp.ai-wire-trace/1");
assert.equal(aiWireTraceEnabled({ aiWireTrace: true }), true);
assert.equal(aiWireTraceEnabled({ aiWireTrace: false }), false);
assert.deepEqual(redactAiWireValue({ Authorization: "Bearer x", apiKey: "x", prompt: "keep" }),
  { Authorization: "<redacted>", apiKey: "<redacted>", prompt: "keep" });
assert.deepEqual(redactAiWireValue({previous_response_id:'resp_private',response_id:'resp_private',input:'OCR stays'}),
  {previous_response_id:'<redacted>',response_id:'<redacted>',input:'OCR stays'});

const calls = [];
const recorder = createAiWireRecorder({ enabled: true, operationId: "op-1", traceId: "trace-1",
  identity: { engine: "runsextension", route: "direct-local", imageId: "image-1" },
  apiBase: "http://127.0.0.1:7860", relay: {
    path: "/v2/engine/runsextension/ai/local-wire-trace", token: "capability", maxEventBytes: 200000,
  }, fetchImpl: async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return { ok: true, status: 202 };
  } });
await recorder("units", [{ id: "g0", text: "原文" }]);
await recorder("providerRequest", { url: "http://127.0.0.1:11434/api/chat?key=secret",
  headers: { Authorization: "Bearer secret" }, body: { model: "qwen", messages: [{ content: "<<TP_P0:原文>>" }] } });
await recorder("providerResponse", { raw: '{"message":{"content":"<<TP_P0:ไทย>>"}}' });
await recorder("contractSelection", { selectedContract: "tp.translation.schema-object/1" });
await recorder("contractApplied", { selectedContract: "tp.translation.schema-object/1" });
await recorder("failure", { stage: "target_language_validation", code: "wrong_language_output" });
assert.equal(await recorder.flush(1000), true);
assert.deepEqual(calls.map((call) => call.payload.stage),
  ["trace_started", "units", "providerRequest", "providerResponse", "contractSelection", "contractApplied", "failure"]);
assert.ok(calls.every((call) => call.init.headers["X-TP-AI-Wire-Capability"] === "capability"));
assert.ok(calls.every((call) => call.payload.identity.executionKey));
const request = calls[2].payload.value;
assert.equal(request.headers.Authorization, "<redacted>");
assert.match(request.url, /key=%3Credacted%3E/);
assert.equal(request.body.messages[0].content, "<<TP_P0:原文>>");
assert.equal(calls[2].init.headers["X-TP-Trace-Id"], "trace-1");
assert.equal(calls[2].init.headers["X-TP-Image-Id"], "image-1");
assert.equal(calls[3].payload.value.raw, '<omitted-provider-body>');

for (const provider of ['ollama', 'jan', 'customlocal']) {
  const relayed=[];
  const recorder=createAiWireRecorder({enabled:true,operationId:`op-${provider}`,
    identity:{route:'direct-local',provider},apiBase:'http://api',
    relay:{path:'/relay',token:'capability'},fetchImpl:async(_url,init)=>{
      relayed.push(JSON.parse(init.body));return {ok:true,status:202};
    }});
  const privateThought=`private ${provider} hidden reasoning`; const visible='<<TP_P0:visible translation>>';
  const body=JSON.stringify({choices:[{message:{reasoning_content:privateThought,content:visible}}],
    message:{thinking:privateThought,content:visible}});
  await recorder('providerResponse',{mode:'stream',status:200,
    chunks:['data: {"delta":{"reasoning_content":"private ',
      `${provider} hidden reasoning"}}\n\n`,body],raw:body,reconstructedEnvelope:body,
    bodyReadComplete:true,providerTerminalComplete:true});
  await recorder('providerAssembled',{source:'decoded_stream_content',text:visible,complete:true});
  await recorder('providerResponse',{mode:'body',status:200,raw:body,
    bodyReadComplete:true,providerTerminalComplete:true});
  await recorder('providerAssembled',{source:'non_stream_http_body',text:body,complete:true});
  assert.equal(await recorder.flush(1000),true);
  const responseEvents=relayed.filter(event=>event.stage==='providerResponse').map(event=>event.value);
  assert.equal(responseEvents.length,2);
  for(const event of responseEvents){
    assert.equal(event.status,200);
    assert.equal(event.raw,'<omitted-provider-body>');
    if(event.chunks){assert.deepEqual(event.chunks,[]);assert.equal(event.chunkCount,3);}
  }
  assert.equal(relayed.find(event=>event.stage==='providerAssembled').value.text,visible);
  assert.equal(relayed.filter(event=>event.stage==='providerAssembled').at(-1).value.text,
    '<omitted-provider-body>');
  assert.ok(!JSON.stringify(relayed).includes(privateThought),
    `${provider} hidden reasoning must never reach the relay`);
  assert.ok(!JSON.stringify(relayed).includes('private '+provider),
    `${provider} split chunks must never reach the relay`);
}

const nativeCalls=[];
const nativeRecorder=createAiWireRecorder({enabled:true,operationId:'op-lmstudio',
  identity:{route:'direct-local',provider:'lmstudio'},apiBase:'http://api',
  relay:{path:'/relay',token:'capability'},fetchImpl:async(_url,init)=>{
    nativeCalls.push(JSON.parse(init.body));return {ok:true,status:202};
  }});
const privateReasoning='private model reasoning phrase';
const nativeEvent='event: reasoning.delta\ndata: '+JSON.stringify({type:'reasoning.delta',content:privateReasoning})+'\n\n'+
  'event: chat.end\ndata: {"type":"chat.end","result":{"response_id":"resp_private_terminal","output":[{"type":"reasoning","content":"private final reasoning"},{"type":"message","content":"OCR stays"}]}}\n\n';
await nativeRecorder('providerRequest',{body:{input:'OCR stays',previous_response_id:'resp_private_previous'}});
await nativeRecorder('providerResponse',{mode:'stream',chunks:[nativeEvent],raw:nativeEvent,
  reconstructedEnvelope:'{"response_id":"resp_private_terminal","output":"OCR stays"}'});
await nativeRecorder('providerAssembled',{text:'{"response_id":"resp_private_terminal","output":"OCR stays"}',
  source:'non_stream_http_body'});
await nativeRecorder('providerAssembled',{text:'<<I1_P0:translated text>>',
  source:'decoded_stream_content'});
await nativeRecorder('providerResponse',{mode:'stream',chunks:[
  'event: reasoning.delta\ndata: {"content":"private frag',
  'mented reasoning"}\n\nevent: chat.end\ndata: {"result":{"response_id":"resp_pri',
  'vate_split","output":[]}}\n\n'],bodyReadComplete:false});
assert.equal(await nativeRecorder.flush(1000),true);
assert.equal(nativeCalls.find(event=>event.stage==='providerRequest').value.body.previous_response_id,'<redacted>');
const nativeResponse=nativeCalls.find(event=>event.stage==='providerResponse').value;
assert.ok(!JSON.stringify(nativeResponse).includes('resp_private_'));
assert.equal(nativeResponse.chunkCount,1);
assert.deepEqual(nativeResponse.chunks,[]);
assert.equal(nativeResponse.reconstructedEnvelope,'<omitted-native-provider-envelope>');
assert.equal(nativeCalls.find(event=>event.stage==='providerRequest').value.body.input,'OCR stays',
  'request OCR remains intact while provider response bodies are omitted');
assert.ok(!JSON.stringify(nativeCalls).includes('resp_private_'),
  'no provider cursor may reach any relay stage, including split SSE and non-stream envelopes');
assert.ok(!JSON.stringify(nativeCalls).includes(privateReasoning)&&
  !JSON.stringify(nativeCalls).includes('private final reasoning')&&
  !JSON.stringify(nativeCalls).includes('private fragmented reasoning'),
  'provider reasoning text must not reach the relay in complete, incomplete or non-stream native responses');
assert.equal(nativeCalls.filter(event=>event.stage==='providerAssembled').at(-1).value.text,'<<I1_P0:translated text>>',
  'decoded translated content remains available without relaying reasoning.delta');

const timeoutRecorder = createAiWireRecorder({ enabled: true, operationId: "op-timeout", traceId: "trace-timeout",
  identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 250 },
  fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }) });
const timeoutStarted = performance.now();
await timeoutRecorder("units", []);
await timeoutRecorder("providerRequest", { body: "queued behind trace start" });
await timeoutRecorder("providerResponse", { raw: "never relayed" });
assert.ok(performance.now() - timeoutStarted < 80,
  "diagnostic calls must be nonblocking even while the first relay hangs");
assert.equal(await timeoutRecorder.flush(600), false);

let stalledBodyCalls = 0;
const stalledBodyRecorder = createAiWireRecorder({ enabled: true, operationId: "op-body", traceId: "trace-body",
  identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 250 },
  fetchImpl: (_url, init) => {
    stalledBodyCalls += 1;
    return Promise.resolve({ ok: false, status: 500, text: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }) });
  } });
await stalledBodyRecorder("units", []);
assert.equal(await stalledBodyRecorder.flush(600), false,
  "a stalled relay error body must trip the bounded circuit breaker");
assert.equal(stalledBodyCalls, 1, "the circuit breaker stops later trace stages after failure");

const persistedStages = [];
let releaseTerminal;
const terminalGate = new Promise((resolve) => { releaseTerminal = resolve; });
const generationRecorder = createAiWireRecorder({ enabled: true, operationId: "op-generations",
  traceId: "trace-generations", identity: { route: "direct-local" }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 1000 },
  fetchImpl: async (_url, init) => {
    const stage = JSON.parse(init.body).stage;
    if (stage === "terminal") await terminalGate;
    persistedStages.push(stage);
    return { ok: true, status: 202 };
  } });
await generationRecorder("failure", { code: "intermediate" });
assert.equal(await generationRecorder.flush(1000), true);
assert.deepEqual(persistedStages, ["trace_started", "failure"]);
await generationRecorder("terminal", { state: "failed" });
let ownerFlushDone = false;
const ownerFlush = generationRecorder.flush(1000).then((value) => {
  ownerFlushDone = true; return value;
});
await Promise.resolve();
assert.equal(ownerFlushDone, false,
  "a later terminal must have a fresh drain generation after an earlier failure flush");
releaseTerminal();
assert.equal(await ownerFlush, true);
assert.deepEqual(persistedStages, ["trace_started", "failure", "terminal"]);

let relayInFlight = 0, relayPeak = 0;
const concurrentStages = new Map();
const concurrentRecorders = Array.from({ length: 12 }, (_, index) => createAiWireRecorder({
  enabled: true, operationId: `op-concurrent-${index}`, traceId: `trace-concurrent-${index}`,
  identity: { route: "direct-local", imageId: `image-${index}` }, apiBase: "http://api",
  relay: { path: "/relay", token: "x", timeoutMs: 250 },
  fetchImpl: async (_url, init) => {
    relayInFlight += 1; relayPeak = Math.max(relayPeak, relayInFlight);
    assert.ok(relayInFlight <= 4, "AI wire relays must be globally bounded across recorders");
    const payload = JSON.parse(init.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const key = payload.identity.operationId;
    concurrentStages.set(key, [...(concurrentStages.get(key) || []), payload.stage]);
    relayInFlight -= 1;
    return { ok: true, status: 202 };
  },
}));
for (const [index, item] of concurrentRecorders.entries()) {
  await item("units", [{ id: `P${index}`, text: "source" }]);
  await item("terminal", { state: "succeeded" });
}
assert.deepEqual(await Promise.all(concurrentRecorders.map((item) => item.flush(1000))),
  Array(12).fill(true), "bounded relay traffic must still persist terminal events");
assert.equal(relayPeak, 4);
for (let index = 0; index < concurrentRecorders.length; index += 1)
  assert.deepEqual(concurrentStages.get(`op-concurrent-${index}`), ["trace_started", "units", "terminal"]);

let invoked = false;
assert.equal(createAiWireRecorder({ enabled: false, fetchImpl: async () => { invoked = true; } }), null);
const cloud = createAiWireRecorder({ enabled: true, identity: { route: "server" },
  relay: { path: "/relay", token: "x" }, apiBase: "http://api", fetchImpl: async () => { invoked = true; } });
await cloud("units", []);
assert.equal(invoked, false, "cloud trace remains owned by its Python provider route");

console.log("Extension Direct Local AI wire relay tests passed");
