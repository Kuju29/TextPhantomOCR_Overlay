import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {idempotencyKeyForPayload} from "../src/background/jobs/idempotency.js";
import {priceGeneration} from "../src/shared/ai/pricing/calculate.js";
import {money,multiplyMoney} from "../src/shared/ai/pricing/money.js";
import {recordProviderGeneration,usageToday,usageDetailedRows,normalizeUsageLedger} from "../src/shared/ai-usage.js";
import {getCachedDataUri,setCachedDataUri} from "../src/background/mangadex.js";
import {createLensDirectPath} from "../src/background/pipeline/lens-direct.js";
import {createOllamaAdapter,ollamaVisionCapability} from "../src/shared/ai/providers/local-ollama.js";
globalThis.crypto ||= webcrypto;
const base={mode:"lens_text",source:"ai",lang:"th",src:"https://fixture.invalid/page",
  imageDataUri:"data:image/png;base64,"+"a".repeat(16000),layout:{relayout_translated:true},
  context:{page_url:"https://fixture.invalid/chapter",series_key:"series",page_index:3},
  metadata:{page_index:3,pipeline:[{stage:"scan",at:"one"}]},
  ai:{provider:"openrouter",model:"fixture",base_url:"https://openrouter.ai/api/v1",
    prompt:"CUSTOM",thinking:"minimum",memory_mode:"off",send_image:false,style_examples:true}};
const original=await idempotencyKeyForPayload(base);
for(const change of [{thinking:"high"},{memory_mode:"full"},{send_image:true},{style_examples:false},
  {base_url:"https://other.invalid"},{prompt:"CHANGED"},{model:"other"},
  {source_context:[{text:"new context"}]},{local_adapter:{protocol:"ollama"}}])
  assert.notEqual(await idempotencyKeyForPayload({...base,ai:{...base.ai,...change}}),original);
assert.notEqual(await idempotencyKeyForPayload({...base,imageDataUri:base.imageDataUri.slice(0,8000)+"b"+base.imageDataUri.slice(8001)}),original);
assert.notEqual(await idempotencyKeyForPayload({...base,layout:{relayout_translated:false}}),original);
assert.notEqual(await idempotencyKeyForPayload({...base,context:{...base.context,page_index:4}}),original);
assert.equal(await idempotencyKeyForPayload({...base,metadata:{...base.metadata,pipeline:[{stage:"scan",at:"two"}],image_id:"new"},
  context:{...base.context,timestamp:"new",tp_trace:"trace",tp_tab_session:"session"},
  ai:{...base.ai,api_key:"PRIVATE_TEST_KEY",model_capabilities:{limits:{contextTokens:1}},workload:{estimatedInput:1}}}),original);

const at=Date.parse("2026-10-06T12:00:00Z");
const usage={runtime:"cloud",provider:"openai",model:"gpt-6-luna",inputTokens:1000,outputTokens:200,totalTokens:1200,
  cachedInputTokens:400,cacheWriteInputTokens:100,usageStatus:"reported",timestamp:at};
const precise="0.000011151222364306957";
assert.equal(money(precise),precise);
assert.equal(multiplyMoney(precise,"35"),"0.000390292782750743495");
assert.equal(priceGeneration({...usage,providerCostUsd:precise}).usd,precise);
assert.equal(priceGeneration(usage).usd,"0.0001665");
assert.equal(priceGeneration({...usage,cacheWriteInputTokens:null}).status,"missing_cache_write_usage");
assert.equal(priceGeneration({...usage,cacheWriteInputTokens:null,cacheWrite1hInputTokens:50}).status,"missing_cache_write_total");
assert.equal(priceGeneration({...usage,provider:"anthropic",model:"claude-sonnet-5-5"}).status,"missing_cache_write_duration");
assert.equal(priceGeneration({...usage,provider:"anthropic",model:"claude-sonnet-5-5",cacheWrite1hInputTokens:0}).usd,"0.00333");
assert.equal(priceGeneration({...usage,cacheWrite1hInputTokens:200}).status,"inconsistent_cache_duration");
assert.equal(priceGeneration({...usage,provider:"huggingface",model:"gpt-6-luna"}).usd,null);
assert.equal(priceGeneration({...usage,provider:"openrouter",model:"openai/gpt-6-luna"}).usd,null);
for(const model of ["gemini-3.6-flash","gemini-3.7-flash","gemini-3.8-flash"]){
  const u={...usage,provider:"gemini",model,cacheWriteInputTokens:0};
  assert.equal(priceGeneration(u).usd,"0.00123");
  assert.equal(priceGeneration({...u,timestamp:Date.parse("2027-01-03T12:00:00Z")}).usd,"0.00246");
  assert.equal(priceGeneration({...u,timestamp:Date.parse("2026-12-31T12:00:00Z")}).status,"upper_bound_tariff_calendar_unverified");
}
let ledger=null;
for(const cost of ["0.1","0.2"])
  ledger=recordProviderGeneration(ledger,{...usage,provider:"openrouter",receiptId:"one",operationId:"same",providerCostUsd:cost},{now:at,id:()=>"session"});
const row=usageDetailedRows(normalizeUsageLedger(ledger))[0];
assert.equal(row.requests,1);assert.equal(row.deltas[0].price.status,"cost_conflict");
assert.equal(row.priceTotals.pricedRequests,0);assert.equal(row.priceTotals.unpricedRequests,1);
assert.equal(usageToday(ledger,at).reportedUsd,"0");

setCachedDataUri("oversize","a".repeat(33*1024*1024));
assert.equal(getCachedDataUri("oversize"),"");
for(let i=0;i<5;i++)setCachedDataUri("bounded-"+i,"a".repeat(8*1024*1024));
assert.equal(getCachedDataUri("bounded-0"),"");
assert.equal(getCachedDataUri("bounded-4").length,8*1024*1024);
let fetches=0,grant;
const gate=new Promise(r=>grant=r),controller=new AbortController();
const direct=createLensDirectPath({fetchFromUrl:async()=>{fetches++;throw Error("unexpected fetch");},
  runStage:async(_key,work)=>{await gate;controller.signal.throwIfAborted();return work();},
  markPhase(){},trace(){},traceLayout(){},getTrace(){return "";},log:{warn(){}}});
const pending=direct("http://fixture",{...base,render:{lensDocument:true}},{signal:controller.signal});
await new Promise(r=>setTimeout(r,10));assert.equal(fetches,0,"Waiting Lens jobs must not fetch/decode source buffers");
controller.abort();grant();await assert.rejects(pending,{name:"AbortError"});
assert.equal(fetches,0);
for(const [capabilities,supported] of [[['completion','vision'],true],[['completion'],false],
  [undefined,null],[['completion',42],null],[[],false]])
  assert.equal(ollamaVisionCapability({capabilities}).supported,supported);
const originalFetch=globalThis.fetch,discovery=[];
globalThis.fetch=async(url,options={})=>{
  discovery.push({url:String(url),body:options.body ? JSON.parse(options.body) : null});
  const data=String(url).endsWith('/api/tags') ? {models:[{name:'qa-vision'},{name:'qa-text'}]} :
    String(url).endsWith('/api/ps') ? {models:[]} :
    {capabilities:JSON.parse(options.body).model==='qa-vision' ? ['completion','vision'] : ['completion']};
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
};
try {
  const adapter=createOllamaAdapter({baseUrl:'http://localhost:11434'});
  const result=await adapter.listModels({model:'qa-vision'});
  assert.equal(result.capability.models['qa-vision'].vision.supported,true);
  assert.equal(result.capability.models['qa-text'].vision.supported,false);
  assert.ok(discovery.every(r=>/\/api\/(tags|ps|show)$/.test(r.url)),
    'Image capability discovery cannot generate or load an Ollama model');
} finally {globalThis.fetch=originalFetch;}
console.log("PASS 10416 semantic retries, decimal billing, cache-write uncertainty, native tariffs, receipt conflicts and image memory guards");
