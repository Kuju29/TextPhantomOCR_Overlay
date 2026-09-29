import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {initialProfile} from '../src/shared/ai/workload/model.js';
import {planConversationBatch} from '../src/shared/ai/workload/conversation-batch-planner.js';
import {priceGeneration} from '../src/shared/ai/pricing/calculate.js';
import {selectRate} from '../src/shared/ai/pricing/providers.js';
const native=spawnSync('python',['-c',String.raw`
import json,sys
sys.path.insert(0,'api')
from unittest.mock import patch
import httpx
from backend.ai.providers import cloud_openai as c
from backend.ai.providers.openai_limits import documented_limits
from backend.ai.provider_contract import ProbeRequest,ProbeResponse
models=['gpt-4.1','gpt-4.1-2025-04-14','gpt-4.1-mini','gpt-4.1-mini-2025-04-14','gpt-4.1-nano','gpt-4.1-nano-2025-04-14']
for x in ['', 'gpt-4o','gpt-4.1-mini-2099-01-01','ft:gpt-4.1-mini:someone','deepseek-flash']:
 assert not documented_limits(x),x
with patch.object(c.httpx,'get',lambda *a,**k:httpx.Response(200,json={'data':[{'id':m,'context_window':7} for m in models]},request=httpx.Request('GET','https://fixture/models'))):
 listed=c.ADAPTER.list_models(api_key='fixture',base_url=c.DEFAULT_BASE_URL)
assert set(listed.models)==set(models)
for m in models:
 assert listed.capabilities[m]['limits']['contextTokens']==1047576
 assert listed.capabilities[m]['limits']['maxOutputTokens']==32768
 assert listed.capabilities[m]['reasoning']['supported'] is False
print(json.dumps(listed.capabilities,default=dict))
`],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
assert.equal(native.status,0,native.stderr);const caps=JSON.parse(native.stdout)['gpt-4.1-mini'];
const rows=Array.from({length:160},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'Hello there, good morning.'}));
const plan=limits=>planConversationBatch({rows,pageSizes:Array(16).fill(10),conversationState:{},
 profileSnapshot:initialProfile(),capabilities:caps,
 context:{provider:'openai',contract:'compact_records',limits,reasoningSupported:false,reasoningActive:false},
 estimateFixedInput:()=>1500,sourceContext:[],contract:'compact_records'});
const unknown=plan({}),known=plan(caps.limits);
assert.ok(known.units.length>unknown.units.length);assert.ok(known.estimate.fitsHard);
assert.ok(known.estimate.target<=8192,'documented context does not remove application answer ceiling');
assert.equal(known.units.length%10,0,'complete ready pages are retained');
console.log(JSON.stringify({test:'native-capability-to-planner',unknownUnits:unknown.units.length,documentedUnits:known.units.length,
 unknownTarget:unknown.estimate.target,documentedTarget:known.estimate.target,hardFit:known.estimate.fitsHard}));
const at=Date.parse('2026-09-28T13:00:00Z');
const sample={runtime:'cloud',provider:'openai',model:'gpt-4.1-mini-2025-04-14',inputTokens:13179,outputTokens:789,totalTokens:13968,cachedInputTokens:12288,timestamp:at};
assert.equal(priceGeneration(sample).usd,'0.0028476');
assert.equal(priceGeneration({...sample,providerCostUsd:'0.0028'}).usd,'0.0028','provider receipt outranks estimate');
assert.equal(priceGeneration({...sample,model:'unconfirmed-future'}).status,'unpriced');
assert.equal(priceGeneration({...sample,outputTokens:null,totalTokens:null}).status,'missing_usage');
assert.equal(selectRate('huggingface','moonshotai/Kimi-K3',{},'unknown'),null,'no cross-provider price borrowing');
const hf={...sample,provider:'huggingface',requestedModel:'moonshotai/Kimi-K3',model:'kimi-k3',upstreamProvider:'baseten',inputTokens:1000,outputTokens:100,totalTokens:1100,cachedInputTokens:800};
assert.equal(priceGeneration(hf).usd,'0.00234');
const changedLive={liveRates:{'huggingface|moonshotai/kimi-k3|baseten':{input:'4',output:'15',fetchedAt:Date.now()}}};
assert.equal(priceGeneration(hf,changedLive).status,'missing_cache_rate','new live price cannot borrow old discounted rate');
const claude={...sample,provider:'anthropic',model:'claude-sonnet-4-6',inputTokens:1000,outputTokens:100,totalTokens:1100,cachedInputTokens:500,cacheWriteInputTokens:200,cacheWrite5mInputTokens:200,cacheWrite1hInputTokens:0};
assert.equal(priceGeneration(claude).usd,'0.0033');
assert.equal(priceGeneration({...claude,cacheWrite5mInputTokens:0,cacheWrite1hInputTokens:200}).usd,'0.00375');
assert.equal(priceGeneration({...sample,cachedInputTokens:null}).status,'upper_bound_cache_unreported');
console.log('PASS exact 6 native model limits -> JS packing; standard native/snapshot/HF-upstream pricing, cache reads/writes/1h, authoritative provider cost, unknown models and stale cache rate protected');
