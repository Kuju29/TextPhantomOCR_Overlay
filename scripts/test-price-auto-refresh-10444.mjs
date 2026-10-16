import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {fetchLiveRate} from '../src/shared/ai/pricing/live.js';
import {priceGeneration} from '../src/shared/ai/pricing/calculate.js';
import {convertThb} from '../src/shared/ai/pricing/fx.js';
import {normalizeOpenRouterPrice,resolveOpenRouterPrice} from '../src/shared/ai/pricing/openrouter.js';
import {normalizeUsageLedger,recordProviderGeneration,usageDetailedRows} from '../src/shared/ai-usage.js';

const checks=[],failures=[];
async function check(name,run){try{await run();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const base='http://localhost:7860',model='deepseek/deepseek-v4.1-flash';
// Public catalogue rates from the archived public 2026-10-08 model audit; no
// private account, provider session or generation data is present in this fixture.
const catalogue={data:[{id:model,pricing:{prompt:'0.0000003',completion:'0.0000012',input_cache_read:'0.000000006'}}]};
await check('Public OpenRouter per-token prices become exact USD/1M including cache reads',async()=>{
 const calls=[];
 const rate=await fetchLiveRate('openrouter',model,'',async(url,options)=>{calls.push({url,options});return response(catalogue);});
 assert(rate,'Public OpenRouter price must be refreshed automatically rather than remain unavailable.');
 assert.equal(rate.input,'0.3');assert.equal(rate.output,'1.2');assert.equal(rate.cached,'0.006');
 assert.equal(calls[0].url,'https://openrouter.ai/api/v1/models');
 assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
 assert.equal(calls[0].options.headers?.Authorization,undefined);
 const event={runtime:'cloud',provider:'openrouter',model,inputTokens:1000,outputTokens:200,totalTokens:1200,cachedInputTokens:400,cacheWriteInputTokens:0,usageStatus:'reported'};
 const config={liveRates:{['openrouter|'+model]:rate}};
 assert.equal(priceGeneration(event,config).usd,'0.0004224');
 assert.equal(convertThb(priceGeneration(event,config).usd,{rate:'35'}),'0.014784');
 assert.equal(priceGeneration({...event,providerCostUsd:'0.0007'},config).usd,'0.0007','Provider-reported cost remains authoritative.');
});

await check('Normal Manual popup startup refreshes and displays OpenRouter model prices without credential forwarding',async()=>{
 const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'manual',aiProvider:'openrouter',aiModel:model,aiKey:'synthetic-key'};
 const fetchReply=async(url,options)=>response(url==='https://openrouter.ai/api/v1/models'?catalogue:url.includes('frankfurter')?{base:'USD',date:'2026-10-08',rates:{THB:35}}:url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model],model_candidates:[{id:model,eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model,status:'passed'}:{});
 const popup=await popupEntryFixture({local,fetchReply});
 try{
  await popup.settle(150);assert.equal(popup.errors.length,0,popup.errors.join('\n'));
  assert.equal(popup.fields.get('ai-provider').value,'openrouter');assert.equal(popup.fields.get('ai-model').value,model);
  popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  assert(popup.calls.some(call=>call.url==='https://openrouter.ai/api/v1/models'),'Normal selected OpenRouter popup must request current public pricing automatically.');
  assert.equal(popup.fields.get('ai-price-input').value,'0.3');assert.equal(popup.fields.get('ai-price-cached').value,'0.006');assert.equal(popup.fields.get('ai-price-output').value,'1.2');
  assert.match(popup.fields.get('ai-price-status').textContent,/catalogue|catalog/i);
 }finally{popup.close();}
});

await check('Paid normal reopen preserves old display then silently replaces selected model rates from fresh account response',async()=>{
 const paidModel='tp-model';
 const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),tpDataConsentV1:{version:1,granted:true,at:1},aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-customer',paidApiBase:base,paidServiceApiBase:base,paidModel:paidModel,aiProvider:'openrouter',aiModel:model,aiKey:'synthetic-key'};
 const session={};let clock=Date.now(),held=false,pending=[];
 let account={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:paidModel,name:'Selected TP model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6',model_revision:1,policy_revision:1},price_sync:{automatic:true,status:'current',checked_at:Math.floor(clock/1000)}}],addons:{entitlements:[]}};
 const fetchReply=async(url,options)=>{
  const value=url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.endsWith('/paid/me')?structuredClone(account):url.includes('/login/providers')?{providers:[]}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model],model_candidates:[{id:model,eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model,status:'passed'}:{};
  if(held&&(url.endsWith('/meta')||url.endsWith('/paid/me')))return new Promise(resolve=>pending.push(()=>resolve(response(value))));
  return response(value);
 };
 const first=await popupEntryFixture({local,session,fetchReply,now:()=>clock});await first.settle(150);assert.equal(first.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');first.close();
 held=true;clock+=61000;
 account={...account,models:[{...account.models[0],pricing:{...account.models[0].pricing,input_tp:'4',output_tp:'9',model_revision:2},price_sync:{automatic:true,status:'current',checked_at:Math.floor(clock/1000)}}]};
 const reopened=await popupEntryFixture({local,session,fetchReply,now:()=>clock});
 try{
  await reopened.settle(150);assert.equal(reopened.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(reopened.fields.get('ai-paid-model').disabled,false,'.72 owner rule: remembered list selectable at reopen');
  const since=reopened.paints.length;
  pending.shift()();await reopened.settle(150);pending.shift()();await reopened.settle(150);
  assert.equal(reopened.fields.get('ai-paid-model-input').textContent,'≈ 4 TP');assert.equal(reopened.fields.get('ai-paid-model-output').textContent,'≈ 9 TP');
  assert.equal(reopened.fields.get('ai-paid-model').value,paidModel);assert.equal(reopened.fields.get('ai-paid-model').disabled,false);
  assert(!reopened.paints.slice(since).some(paint=>['ai-paid-model-input','ai-paid-model-output','ai-paid-account-state'].includes(paint.id)&&/Loading|Checking|Reconnecting|^—$/.test(paint.text)));
  const saved=local.paidAccountViewCacheV1.me.models.find(row=>row.id===paidModel);assert.equal(saved.pricing.input_tp,'4');assert.equal(saved.pricing.output_tp,'9');
  assert.equal(saved.price_sync?.status,'current','The safe display snapshot must preserve the fresh price sync status, not discard the server provenance.');
  assert.equal(saved.price_sync?.checked_at,Math.floor(clock/1000));
  assert.equal(saved.pricing.model_revision,2);
 }finally{reopened.close();}
});

// 10490: a popup open re-reads the OpenRouter catalogue only when the stored rate is
// older than 1 h (was 60 s); the fixture's rate is just past that.
const manualLocal=()=>({mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'manual',aiProvider:'openrouter',aiModel:model,aiKey:'synthetic-key',
 aiUsageV1:{...normalizeUsageLedger(null),pricing:{overrides:{},liveRates:{['openrouter|'+model]:{input:'0.1',output:'0.2',cached:'0.001',origin:'live_catalogue',asOf:'2026-10-08',fetchedAt:Date.now()-61*60000,url:'https://openrouter.ai/api/v1/models'}},fx:{rate:'35',manualRate:'35',date:'2026-10-08',source:'manual'}}}});
const manualReply=(url,rows=catalogue)=>response(url==='https://openrouter.ai/api/v1/models'?rows:url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model],model_candidates:[{id:model,eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model,status:'passed'}:{});
await check('Held refresh retains prior Manual price display and updates an already open rates dialog without loading flicker',async()=>{
 let finish;
 const local=manualLocal(),popup=await popupEntryFixture({local,fetchReply:(url)=>url==='https://openrouter.ai/api/v1/models'?new Promise(resolve=>finish=()=>resolve(response(catalogue))):manualReply(url)});
 try{
  await popup.settle(150);assert.equal(typeof finish,'function');popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  assert.equal(popup.fields.get('ai-price-input').value,'0.1');assert.equal(popup.fields.get('ai-price-output').value,'0.2');
  assert.doesNotMatch(popup.fields.get('ai-price-status').textContent,/Loading|Checking/);
  finish();await popup.settle(150);
  assert.equal(popup.fields.get('ai-price-input').value,'0.3');assert.equal(popup.fields.get('ai-price-cached').value,'0.006');assert.equal(popup.fields.get('ai-price-output').value,'1.2');
  assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+model].input,'0.3');
 }finally{popup.close();}
});
await check('Pending automatic price reply preserves user edits and custom rates',async()=>{
 let finish;
 const local=manualLocal();local.aiUsageV1.pricing.overrides['openrouter|'+model]={input:'7',output:'8',cached:'0.7',origin:'user'};
 const popup=await popupEntryFixture({local,fetchReply:(url)=>url==='https://openrouter.ai/api/v1/models'?new Promise(resolve=>finish=()=>resolve(response(catalogue))):manualReply(url)});
 try{
  await popup.settle(150);popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  assert.equal(popup.fields.get('ai-price-input').value,'7');popup.fields.get('ai-price-input').value='11';
  finish();await popup.settle(150);assert.equal(popup.fields.get('ai-price-input').value,'11');
  assert.equal(local.aiUsageV1.pricing.overrides['openrouter|'+model].input,'7');assert.equal(local.aiUsageV1.pricing.overrides['openrouter|'+model].output,'8');
  assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+model].input,'0.3','Public rate refresh is separate from a user override.');
 }finally{popup.close();}
});
await check('Late price reply for a changed API cannot commit or paint stale selected prices',async()=>{
 let finish;
 const local=manualLocal(),popup=await popupEntryFixture({local,fetchReply:(url)=>url==='https://openrouter.ai/api/v1/models'?new Promise(resolve=>finish=()=>resolve(response(catalogue))):manualReply(url)});
 try{
  await popup.settle(150);popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  popup.fields.get('api-url').value='http://localhost:7861';
  finish();await popup.settle(150);
  assert.equal(popup.fields.get('ai-price-input').value,'0.1');assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+model].input,'0.1');
 }finally{popup.close();}
});
await check('Actual model A→B→A events reject the first A reply even when the final selected values match',async()=>{
 const other='openai/gpt-6-luna',local=manualLocal(),pending=[];
 const rows={data:[...catalogue.data,{id:other,pricing:{prompt:'0.0000015',completion:'0.000003'}}]};
 const popup=await popupEntryFixture({local,fetchReply:(url,options)=>{
  if(url==='https://openrouter.ai/api/v1/models')return new Promise(resolve=>pending.push(()=>resolve(response(rows))));
  if(url.includes('/ai/resolve'))return response({provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model,other],model_candidates:[{id:model,eligibility:'usable'},{id:other,eligibility:'usable'}]});
  if(url.includes('/ai/probe'))return response({provider:'openrouter',model:JSON.parse(options.body).model,status:'passed'});
  return manualReply(url);
 }});
 try{
  await popup.settle(150);assert.equal(pending.length,1);
  popup.fields.get('ai-model').value=other;popup.fields.get('ai-model').dispatchEvent({type:'change'});await popup.settle(150);
  popup.fields.get('ai-model').value=model;popup.fields.get('ai-model').dispatchEvent({type:'change'});await popup.settle(150);
  assert.equal(popup.fields.get('ai-model').value,model);
  pending[0]();await popup.settle(150);
  assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+model].input,'0.1','The obsolete first A response must not commit after two actual model changes.');
  for(const finish of pending.slice(1))finish();await popup.settle(150);
  assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+model].input,'0.3','A fresh final A request may update its own prices.');
  assert.equal(local.aiUsageV1.pricing.liveRates['openrouter|'+other],undefined,'The intervening B reply cannot leak into the final A projection.');
 }finally{popup.close();}
});
await check('Absent, duplicate, malformed and nonfinite catalogue prices never become zero',async()=>{
 const fixture=value=>async()=>response(value);
 for(const data of [{data:[]},{data:[...catalogue.data,...catalogue.data]},{data:[{...catalogue.data[0],pricing:{prompt:'NaN',completion:'0.000001'}}]},{data:[{...catalogue.data[0],pricing:{prompt:'0.000001'}}]}])assert.equal(await fetchLiveRate('openrouter',model,'',fixture(data)),null);
 for(const pricing of [{prompt:'Infinity',completion:'0'}, {prompt:'0.000001',completion:'0',request:'Infinity'},{prompt:'0.000001',completion:'0',image:'garbage'},{prompt:NaN,completion:'0'}, {prompt:'0.000001',completion:false}, {prompt:'0.000001',completion:'0',overrides:[{min_prompt_tokens:-1,prompt:'0.000002'}]}])assert.equal(normalizeOpenRouterPrice(pricing),null);
 const free=normalizeOpenRouterPrice({prompt:'0',completion:'0',input_cache_read:'0'});assert.equal(free.input,'0');assert.equal(free.output,'0');assert.equal(free.cached,'0');
 const precise=normalizeOpenRouterPrice({prompt:'0.000000018',completion:'0.00000128',input_cache_write:'0.0000000416666666666667',input_cache_write_1h:'0.000000125'});
 assert.equal(precise.input,'0.018');assert.equal(precise.output,'1.28');assert.equal(precise.cacheWrite,'0.0416666666666667');assert.equal(precise.cacheWrite1h,'0.125');
});
await check('Fresh unavailable OpenRouter pricing retains prior display honestly and cannot estimate a new request at an unverified current price',async()=>{
 const local=manualLocal(),popup=await popupEntryFixture({local,fetchReply:url=>manualReply(url,{data:[]})});
 try{
  await popup.settle(150);popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  assert.equal(popup.fields.get('ai-price-input').value,'0.1');assert.match(popup.fields.get('ai-price-status').textContent,/Prior|Previous/);
  const event={runtime:'cloud',provider:'openrouter',model,inputTokens:1000,outputTokens:200,totalTokens:1200,cachedInputTokens:400,cacheWriteInputTokens:0,usageStatus:'reported'};
  assert.equal(priceGeneration(event,local.aiUsageV1.pricing).usd,null);
  assert.equal(priceGeneration({...event,providerCostUsd:'0.0007'},local.aiUsageV1.pricing).usd,'0.0007');
 }finally{popup.close();}
});
await check('Conditional OpenRouter tariffs use strict token thresholds, UTC windows/weekdays and later per-axis overrides',async()=>{
 const rate=normalizeOpenRouterPrice({prompt:'0.0000001',completion:'0.0000005',input_cache_read:'0.00000001',overrides:[{min_prompt_tokens:272000,prompt:'0.0000002',completion:'0.00000075',input_cache_read:'0.00000002'}]});
 assert.equal(resolveOpenRouterPrice(rate,{inputTokens:272000}).rate.input,'0.1');assert.equal(resolveOpenRouterPrice(rate,{inputTokens:272001}).rate.input,'0.2');assert.equal(resolveOpenRouterPrice(rate,{inputTokens:272001}).rate.cached,'0.02');
 const event={runtime:'cloud',provider:'openrouter',model,inputTokens:272001,outputTokens:200,totalTokens:272201,cachedInputTokens:400,cacheWriteInputTokens:0,usageStatus:'reported'};
 const config={liveRates:{['openrouter|'+model]:{...rate,fetchedAt:Date.now()}}};
 assert.equal(priceGeneration(event,config).usd,'0.0544782');assert.equal(priceGeneration({...event,requests:2},config).status,'unknown_per_request_tier');
 const timed=normalizeOpenRouterPrice({prompt:'0.000001',completion:'0.000002',overrides:[{utc_start:1630,utc_end:30,utc_days:['thursday'],prompt:'0.0000005'},{utc_start:1630,utc_end:30,utc_days:['thursday'],completion:'0.0000007'}]});
 const dispatch=at=>({providerRequestStartedAt:Date.parse(at),providerRequestTimeSource:'provider_transport'});
 assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-08T16:29:00Z')).rate.input,'1');assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-08T16:30:00Z')).rate.input,'0.5');assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-08T16:30:00Z')).rate.output,'0.7');
 assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-08T00:29:00Z')).rate.input,'0.5');assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-08T00:30:00Z')).rate.input,'1');assert.equal(resolveOpenRouterPrice(timed,dispatch('2026-10-09T17:00:00Z')).rate.input,'1');
 assert.equal(resolveOpenRouterPrice(timed,{}).error,'missing_price_request_time');
 const unknown=normalizeOpenRouterPrice({prompt:'0.000001',completion:'0.000002',overrides:[{future_condition:true,prompt:'0.000003'}]});assert.equal(resolveOpenRouterPrice(unknown,event).error,'unsupported_price_conditions');
});
await check('Extra image/request fees stay explicit estimates while reported costs win and historical saved rates stay fixed',async()=>{
 const rate={...normalizeOpenRouterPrice({...catalogue.data[0].pricing,request:'0.01',image:'0.02'}),fetchedAt:Date.now()};
 const event={runtime:'cloud',provider:'openrouter',model,inputTokens:1000,outputTokens:200,totalTokens:1200,cachedInputTokens:400,cacheWriteInputTokens:0,usageStatus:'reported'};
 let ledger=normalizeUsageLedger(null);ledger.pricing.liveRates['openrouter|'+model]=rate;
 const config=ledger.pricing;
 assert.equal(priceGeneration(event,config).status,'estimate_excludes_extras');assert.equal(priceGeneration(event,config).usd,'0.0004224');assert.equal(priceGeneration({...event,providerCostUsd:'0.04'},config).usd,'0.04');
 assert.equal(priceGeneration({...event,isByok:true,providerCostUsd:'0.04',upstreamInferenceCostUsd:'0.5'},config).usd,null);
 ledger=recordProviderGeneration(ledger,{...event,operationId:'before-change'},{now:Date.now(),id:()=> 'synthetic-session'});
 const saved=structuredClone(usageDetailedRows(ledger)[0].deltas[0].price);
 ledger.pricing.liveRates['openrouter|'+model]={...rate,input:'1',output:'2'};
 ledger=recordProviderGeneration(ledger,{...event,operationId:'after-change'},{now:Date.now()+1,id:()=> 'synthetic-session'});
 const rows=usageDetailedRows(ledger)[0].deltas;
 assert.deepEqual(rows.find(row=>row.price.rate.input==='0.3').price,saved,'Already priced records retain their exact original rate and amount.');
 assert(rows.some(row=>row.price.rate.input==='1'&&row.price.usd==='0.0010024'),'Future receipt uses the new saved rate.');
});

await check('Actual usage receipts cannot borrow completion or shared operation clocks for time-dependent prices',async()=>{
 const start=Date.parse('2026-10-08T16:29:59Z'),completion=Date.parse('2026-10-08T16:30:01Z');
 const timed={...normalizeOpenRouterPrice({prompt:'0.000001',completion:'0.000002',overrides:[{utc_start:1630,utc_end:30,prompt:'0.0000005',completion:'0.0000007'}]}),fetchedAt:Date.now()};
 const event={runtime:'cloud',provider:'openrouter',model,inputTokens:1000,outputTokens:200,totalTokens:1200,cachedInputTokens:0,cacheWriteInputTokens:0,usageStatus:'reported',startedAt:start};
 let ledger=normalizeUsageLedger(null);ledger.pricing.liveRates['openrouter|'+model]=timed;
 ledger=recordProviderGeneration(ledger,{...event,operationId:'crossing-clock'},{now:completion,id:()=> 'synthetic-clock-session'});
 let delta=usageDetailedRows(ledger)[0].deltas[0];
 assert.equal(delta.timestamp,completion);
 assert.equal(delta.price.usd,null,'The receipt completion clock cannot select the cheaper post-boundary rate.');
 assert.equal(delta.price.status,'missing_price_request_time');
 const individualProof={providerRequestStartedAt:start,providerRequestTimeSource:'provider_transport'};
 const config=ledger.pricing;
 assert.equal(priceGeneration({...event,timestamp:completion,...individualProof},config).usd,'0.0014','Explicit individual provider dispatch evidence selects the pre-boundary tariff.');
 for(const unproven of [{timestamp:completion},{timestamp:completion,...individualProof,providerRequestTimeSource:'batch_start'},{timestamp:completion,...individualProof,providerRequestStartedAt:'1791476999000'},{timestamp:completion,...individualProof,providerRequestStartedAt:0},{timestamp:completion,...individualProof,providerRequestStartedAt:Infinity}]){
  assert.equal(priceGeneration({...event,...unproven},config).usd,null,'Only a positive safe integer provider dispatch clock with its exact provenance qualifies.');
 }
 assert.equal(priceGeneration({...event,timestamp:completion,...individualProof,requests:2},config).status,'unknown_per_request_tier');
 ledger=recordProviderGeneration(ledger,{...event,...individualProof,operationId:'queued-clock'},{now:completion+60000,id:()=> 'synthetic-clock-session'});
 ledger=recordProviderGeneration(ledger,{...event,...individualProof,operationId:'multiple-clock',generationUsage:[{...event,receiptId:'synthetic-clock-turn-one'},{...event,receiptId:'synthetic-clock-turn-two'}]},{now:completion+120000,id:()=> 'synthetic-clock-session'});
 let rows=usageDetailedRows(ledger).flatMap(row=>row.deltas);
 assert.equal(rows.length,4);
 assert(rows.every(row=>row.price.usd===null&&row.price.status==='missing_price_request_time'),'Queued and split provider turns cannot inherit a shared frontend start clock; normal receipts carry no proven provider clock.');
 ledger=normalizeUsageLedger(JSON.parse(JSON.stringify(ledger)));
 assert(usageDetailedRows(ledger).flatMap(row=>row.deltas).every(row=>row.price.usd===null),'Persisted unpriced receipts remain unpriced.');
 ledger=recordProviderGeneration(ledger,{...event,operationId:'crossing-clock',providerCostUsd:'0.00321'},{now:completion+180000,id:()=> 'synthetic-clock-session'});
 rows=usageDetailedRows(ledger).flatMap(row=>row.deltas);
 assert.equal(rows.length,4,'Late reported cost enriches its existing receipt without duplication.');
 delta=rows.find(row=>row.price.status==='reported');assert.equal(delta?.price.usd,'0.00321','Actual reported cost wins even without request-time evidence.');
 assert.equal(rows.filter(row=>row.price.usd===null).length,3);
});

console.log(JSON.stringify({passed:failures.length===0,count:checks.length,checks,failures,scope:'Production pricing helpers plus unmodified popup.js complete import graph; synthetic provider/account responses; no live generation or charge'}));
if(failures.length)process.exitCode=1;
