import assert from 'node:assert/strict';
const savedChrome=globalThis.chrome, savedFetch=globalThis.fetch;
const stored={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.test'})},storage:{local:{
  get(keys,callback){callback(Array.isArray(keys)?Object.fromEntries(keys.map(key=>[key,stored[key]])):{...keys,...stored});},
  set(value,callback){Object.assign(stored,value);callback?.();},
}}};
const {readAiStream,translateViaServer} = await import('../src/background/ai/transports/server.js');
const encoder = new TextEncoder();
const event = (sequence,type,extra) => JSON.stringify({schema:'tp.ai.stream/1',sequence,type,...extra})+'\n';
let controller;
const stream = new ReadableStream({start(c){controller=c;}});
const deltas=[];
const pending=readAiStream(new Response(stream),text=>deltas.push(text));
const bytes=encoder.encode(event(1,'delta',{text:'<<I1_P0:สวัสดี>>'}));
// Deliberately split UTF-8 characters and the NDJSON record across network reads.
for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
await new Promise(resolve=>setTimeout(resolve,0));
assert.deepEqual(deltas,['<<I1_P0:สวัสดี>>']);
let resolved=false; pending.then(()=>resolved=true);
await Promise.resolve(); assert.equal(resolved,false,'delta must not terminate generation');
controller.enqueue(encoder.encode(event(2,'result',{body:{schema:'tp.ai.result/1',meta:{usage:{cachedInputTokens:17}}}})));
assert.equal((await pending).body.meta.usage.cachedInputTokens,17);

const error=await readAiStream(new Response(event(1,'error',{status:502,body:{detail:{code:'provider_error',usage:{outputTokens:9}}}})));
assert.equal(error.status,502);assert.equal(error.body.detail.usage.outputTokens,9);
for (const raw of [event(1,'delta',{text:'partial'}), event(2,'result',{body:{}}), '{broken}\n', event(1,'unknown',{})]) {
  await assert.rejects(readAiStream(new Response(raw)), {code:'invalid_ai_stream'});
}
console.log('PASS: early delta, fragmented UTF8, terminal usage, typed error, 4 malformed/truncated protocols');

try {
  const config={base:'https://api.test',targetLang:'th',capabilities:{aiConversation:'tp.conversation/1'},
    ai:{provider:'openrouter',model:'model-test',translation_mode:'conversation'}};
  let calls=0, captured, unsupportedBodyCancelled=false;
  const body={schema:'tp.ai.result/1',translations:[{id:'P0',text:'translated'}],missing:[],meta:{generationAttempts:1,usage:{inputTokens:3,outputTokens:2,totalTokens:5}}};
  globalThis.fetch=async (_url,init)=>{calls++;captured=init;
    const source=calls===1?new ReadableStream({start(controller){controller.enqueue(encoder.encode(JSON.stringify(body)));},cancel(){unsupportedBodyCancelled=true;}}):JSON.stringify(body);
    return new Response(source,{headers:{'content-type':'application/json'}});};
  await assert.rejects(translateViaServer([{id:'P0',text:'source'}],{...config,operationId:'unsupported-stream'}),
    error=>error.code==='ai_stream_unsupported' && error.retryable===false && error.generationAttempts===null && error.requestDispatched===undefined);
  assert.equal(calls,1,'unsupported stream must never retry');
  assert.equal(unsupportedBodyCancelled,true,'unsupported response body must be released');
  assert.equal(captured.headers.Accept,'application/x-ndjson');
  const independent=await translateViaServer([{id:'P0',text:'source'}],{...config,operationId:'independent-json',ai:{...config.ai,translation_mode:'independent'}});
  assert.equal(independent.translations[0].text,'translated');assert.equal(captured.headers.Accept,undefined);
  const repair=await translateViaServer([{id:'P0',text:'source'}],{...config,operationId:'repair-json',repairClaim:{runId:'run',taskId:'task',token:'token'}});
  assert.equal(repair.translations[0].text,'translated');assert.equal(captured.headers.Accept,undefined);
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({detail:{code:'invalid_request',requestDispatched:false,generationAttempts:0}}),{status:400,headers:{'content-type':'application/json'}});};
  await assert.rejects(translateViaServer([{id:'P0',text:'source'}],{...config,operationId:'precontent-error'}),error=>error.code==='invalid_request' && error.status===400);
  assert.equal(calls,4);
  console.log('PASS: opted-in full JSON rejected without retry; independent/repair JSON retained; precontent HTTP error retained');
} finally {globalThis.chrome=savedChrome;globalThis.fetch=savedFetch;}
