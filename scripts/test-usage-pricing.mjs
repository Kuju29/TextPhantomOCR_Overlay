import assert from "node:assert/strict";
import {perMillion,sumMoney,multiplyMoney} from "../src/shared/ai/pricing/money.js";
import {priceGeneration} from "../src/shared/ai/pricing/calculate.js";
import {bangkokDate,convertThb,refreshUsdThb} from "../src/shared/ai/pricing/fx.js";
import {fetchLiveRate} from "../src/shared/ai/pricing/live.js";
import {recordProviderGeneration,resetActiveUsage,usageToday,usageDetailedRows,usageHistoryRows,
  normalizeUsageLedger} from "../src/shared/ai-usage.js";

assert.equal(perMillion(1000,"1.50"),"0.0015");
assert.equal(sumMoney("0.1","0.02","0.003"),"0.123");
assert.equal(multiplyMoney("0.0015","34.50"),"0.05175");
assert.equal(bangkokDate(Date.parse("2026-09-24T18:00:00Z")),"2026-09-25");
const gemini={runtime:"cloud",provider:"gemini",model:"gemini-3.5-flash",inputTokens:1000,
  cachedInputTokens:400,outputTokens:200,totalTokens:1200,usageStatus:"reported"};
const price=priceGeneration(gemini);
assert.equal(price.usd,"0.00276"); // 600 × 1.50 + 400 × 0.15 + 200 × 9 per million
assert.equal(price.savingsUsd,"0.00054");
assert.equal(convertThb(price.usd,{rate:"35"}),"0.0966");
assert.equal(priceGeneration({...gemini,cachedInputTokens:null}).status,"upper_bound_cache_unreported");
assert.equal(priceGeneration({...gemini,provider:"unsupported"}).usd,null);
assert.equal(priceGeneration({...gemini,provider:"together",model:"openai/gpt-oss-20b",cachedInputTokens:null}).usd,"0.00009");
assert.equal(priceGeneration({...gemini,totalTokens:null}).status,"missing_usage");
assert.equal(priceGeneration({...gemini,provider:"manual",model:"custom"},
  {overrides:{"manual|custom":{input:"invalid",output:"2"}}}).status,"invalid_rate");
assert.equal(priceGeneration({...gemini,provider:"openrouter",providerCostUsd:"0.001234567"}).usd,"0.001234567");
assert.equal(priceGeneration({...gemini,runtime:"local"}).usd,"0");
const claude=priceGeneration({...gemini,provider:"anthropic",model:"claude-sonnet-5",
  cacheWriteInputTokens:100,cacheWrite1hInputTokens:100});
assert.equal(claude.parts.cacheWriteUsd,"0.0004");

const dayAt=Date.parse("2026-09-24T18:00:00Z"), id=()=>"sid";
let ledger=recordProviderGeneration(null,{...gemini,operationId:"op1",imageCount:1},{now:dayAt,id});
assert.equal(usageToday(ledger,dayAt).requests,1);
assert.equal(usageToday(ledger,dayAt).usd,"0.00276");
const beforeReset=ledger.days["2026-09-25"].usd;
ledger=resetActiveUsage(ledger,{now:dayAt+20,id:()=>"sid2"});
assert.equal(usageToday(ledger,dayAt).usd,beforeReset,"daily total survives active session reset");
ledger=recordProviderGeneration(ledger,{...gemini,operationId:"op1"},{now:dayAt+30,id});
assert.equal(usageToday(ledger,dayAt).requests,1,"replayed receipt cannot double the daily bill");
ledger=recordProviderGeneration(ledger,{...gemini,operationId:"op2",cachedInputTokens:null},
  {now:dayAt+40,id});
assert.equal(usageToday(ledger,dayAt).requests,2);
assert.equal(usageToday(ledger,dayAt).usd,"0.00606");
assert.equal(usageToday(ledger,dayAt).cacheUnknownRequests,1);
ledger=recordProviderGeneration(ledger,{...gemini,operationId:"op1",providerCostUsd:"0.001"},
  {now:dayAt+50,id});
assert.equal(usageToday(ledger,dayAt).requests,2,"late provider cost never adds another request");
assert.equal(usageToday(ledger,dayAt).usd,"0.0043","reported charge replaces only its old estimate");
assert.equal(usageToday(ledger,dayAt).reportedUsd,"0.001");
const detail=usageDetailedRows(ledger);
assert.equal(detail.flatMap(x=>x.deltas).length,2);
assert.ok(!("deltas" in usageHistoryRows(ledger)[0]),"public History has no raw request identifiers");
assert.ok(!("operationId" in detail[0].deltas[0]),"request view has no raw operation IDs");
assert.equal(usageToday(normalizeUsageLedger(ledger),dayAt).requests,2);
assert.equal(usageToday(ledger,dayAt+24*60*60*1000).requests,0);

const fx=await refreshUsdThb({}, {now:dayAt,fetcher:async()=>({ok:true,json:async()=>({base:"USD",date:"2026-09-24",rates:{THB:34.62}})})});
assert.equal(fx.rate,"34.62");
const feather=await fetchLiveRate("featherless","owner/model","",async()=>({ok:true,json:async()=>({id:"owner/model",pricing:{prompt:"0.0000001",completion:"0.0000002",image:"0",request:"0"}})}));
assert.equal(feather.input,"0.1");assert.equal(feather.output,"0.2");
const hf=await fetchLiveRate("huggingface","owner/model","groq",async()=>({ok:true,json:async()=>({id:"owner/model",providers:[
  {provider:"groq",status:"live",pricing:{input:0.4,output:0.8}},
  {provider:"other",status:"live",pricing:{input:9,output:9}}]})}));
assert.equal(hf.input,"0.4","HF rate must follow the observed upstream route");
assert.equal(await fetchLiveRate("huggingface","owner/model",""),null,"ambiguous routes remain unpriced");
console.log("PASS exact provider price, cache savings, Thai day, reset, dedupe and live route validation");
