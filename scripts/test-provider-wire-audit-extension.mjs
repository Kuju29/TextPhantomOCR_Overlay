// npm/node: node scripts/test-provider-wire-audit-extension.mjs
// Simulates the 19th UI provider, Custom Local, through its real fetch adapter.
// This does not call a live local server or prove any model's actual cache hit.
import assert from "node:assert/strict";
import {
  localProviderContinuationStrategy,
  parseLocalAiAdapterJson,
  resolveLocalProvider,
} from "../src/shared/ai/providers/local-registry.js";

const source1 = "<<I1_P0:OLD_SOURCE_UNIQUE>>";
const answer1 = "<<I1_P0:แปลเก่า>>";
const source2 = "<<I2_P0:NEW_SOURCE_UNIQUE>>";
const answer2 = "<<I2_P0:แปลใหม่>>";
const settings = parseLocalAiAdapterJson(JSON.stringify({version:1, protocol:"openai",
  baseUrl:"http://localhost:9090/v1", includeUsage:true}));
const adapter = resolveLocalProvider(settings, "customlocal");
const requests = [];
const originalFetch = globalThis.fetch;
const sse = item => `data: ${JSON.stringify(item)}\n\n`;
globalThis.fetch = async (url, options={}) => {
  const body = JSON.parse(options.body);
  requests.push({url:String(url), body});
  const answer = requests.length === 1 ? answer1 : answer2;
  const cached = requests.length === 1 ? 0 : 11;
  return new Response(sse({choices:[{delta:{content:answer}}]}) +
    sse({choices:[{delta:{},finish_reason:"stop"}], usage:{prompt_tokens:120,
      completion_tokens:7,total_tokens:127,prompt_tokens_details:{cached_tokens:cached}}}) +
    "data: [DONE]\n\n", {headers:{"content-type":"text/event-stream"}});
};
try {
  assert.equal(localProviderContinuationStrategy("customlocal"), "message_replay");
  const first = [{role:"system",content:"WIRE_AUDIT_SYSTEM_UNIQUE"},
    {role:"user",content:source1}];
  const currentContent = adapter.buildUserContent(source2,"data:image/png;base64,aGVsbG8=");
  const second = [...first,{role:"assistant",content:answer1},
    {role:"user",content:currentContent}];
  const call1 = await adapter.generate({model:"user-picked",messages:first,outputTokens:256,
    thinkingMode:"default"},{expectedIds:["I1_P0"]});
  const call2 = await adapter.generate({model:"user-picked",messages:second,outputTokens:256,
    thinkingMode:"default"},{expectedIds:["I2_P0"]});
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.url==="http://localhost:9090/v1/chat/completions"));
  assert.deepEqual(requests[0].body.messages,first);
  assert.deepEqual(requests[1].body.messages,second);
  assert.deepEqual(requests[1].body.messages.map(m=>m.role),["system","user","assistant","user"]);
  assert.equal(requests[1].body.messages[3].content[1].image_url.url,
    "data:image/png;base64,aGVsbG8=");
  assert.ok(requests.every(r=>r.body.max_tokens===256 && r.body.stream===true));
  assert.ok(requests.every(r=>!Object.hasOwn(r.body,"store") && !Object.hasOwn(r.body,"previous_response_id")));
  assert.equal(call1.stream.data.choices[0].message.content,answer1);
  assert.equal(call2.stream.data.choices[0].message.content,answer2);
  assert.equal(adapter.usage(call2.stream.data).cachedInputTokens,11);
  assert.equal(adapter.usage(call2.stream.data).inputTokens,120);

  const before = requests.length;
  await assert.rejects(adapter.generate({model:"user-picked",messages:second,outputTokens:256,
    thinkingMode:"off"}, {expectedIds:["I2_P0"]}),
  error=>error.code==="local_model_thinking_unsupported" && error.requestDispatched===false);
  assert.equal(requests.length,before,"unknown Custom Off cannot silently send a provider-default request");
  const lowest = await adapter.generate({model:"user-picked",messages:second,outputTokens:256,
    thinkingMode:"minimum"}, {expectedIds:["I2_P0"]});
  assert.equal(requests.length,before+1,"Custom Lowest uses one provider-managed request");
  assert.deepEqual(requests.at(-1).body.messages,second,
    "Custom Lowest preserves the actual replayed history");
  assert.equal(lowest.stream.data.choices[0].message.content,answer2);
  for (const field of ["reasoning", "reasoning_effort", "think", "thinking", "store", "previous_response_id"])
    assert.equal(Object.hasOwn(requests.at(-1).body,field),false,
      `Custom Lowest cannot invent a native ${field} control`);
  assert.equal(adapter.thinkingApplied("minimum",{payload:requests.at(-1).body}),
    "provider_managed_unverified","Custom Lowest must report its lack of model-specific proof");
  console.log("PASS Custom Local 19th UI provider: three synthetic fetch calls, replay, image, usage, strict Off and truthful unverified Lowest (0 live calls)");
} finally {
  globalThis.fetch=originalFetch;
}
