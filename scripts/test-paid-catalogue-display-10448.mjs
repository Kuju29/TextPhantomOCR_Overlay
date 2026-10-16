import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {paidModelRates} from '../src/popup/controllers/paid-model-pricing.js';
import {accountViewScope,createPaidViewCache} from '../src/paid/view-cache.js';
const A='http://localhost:7860',B='http://localhost:7861',checks=[],failures=[];
// Synthetic 13-model account: IDs deliberately span providers. The production
// display path must depend on validated price metadata, never model names.
const ids=['anthropic/claude-opus-4.6','anthropic/claude-sonnet-4.6','anthropic/claude-haiku-4.5',
 'openai/gpt-6-luna','openai/gpt-6-sol','openai/gpt-6.1-sol','openai/gpt-6-astra',
 'qwen/qwen3.5-397b-a17b','google/gemini-3.1-pro','deepseek/deepseek-v3.2',
 'mistralai/mistral-large','x-ai/grok-4.1-fast','fixture/custom-model'];
const pricing=(input,output,basis)=>({status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:String(input),output_tp:String(output),model_revision:2,policy_revision:1,...(basis?{basis}:{})});
const unavailable={status:'unavailable',unit:'TP_PER_1000_TOKENS',input_tp:null,output_tp:null,basis:'paired_endpoint_metadata'};
const modelRows=()=>ids.map((id,index)=>({id,name:'Synthetic model '+(index+1),eligible_tp:'1250',max_output:8192,
 catalogue_pricing:pricing(index+2,index+4),pricing:unavailable,
 price_sync:{automatic:true,status:'current',checked_at:1700000000},route_price_sync:{status:'unavailable',account_policy_verified:false}}));
const savedFor=id=>({mode:'lens_text',sources:'ai',lang:'th',customApiUrl:A,apiUrlDefault:A,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-a',paidApiBase:A,paidServiceApiBase:A,paidModel:id,tpDataConsentV1:{version:1,granted:true}}); // 10495: this user allowed account data
// .90 owner: no periodic catalogue polling. A visible popup re-reads the account
// and catalogue on change signals (X-TP-Changes prices/account token), usage,
// open and return to view; a fixed 10-minute timer never does (test-price-periodic-popup-10444).
let changeSeq=0;
const pricesChanged=popup=>popup.writeLocal({tpChangeTokensV1:{scope:'f'.repeat(32),tokens:{b:'aaaaaa',account:'bbbbb'+(++changeSeq),prices:'ccccc'+changeSeq},changed:['prices'],seq:changeSeq,at:Date.now()}});
async function check(name,fn){try{await fn();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
function environment(id=ids[0]){
 let status=503,code='PAID_ROUTE_UNAVAILABLE',holdQuotes=false,holdMe=false,clock=Date.now(),rows=modelRows(),tariff='base';
 const local=savedFor(id),session={},held=[],heldAccounts=[],requests=[];
 const quote=()=>({quote_token:'opaque-not-cached',pricing:{...pricing(80,90,'paired_endpoint_metadata'),tariff_basis:tariff},route:{basis:'paired_endpoint_metadata',checked_at:1700000001,revision:3}});
 const response=(value,status=200)=>Response.json(value,{status});
 const reply=async(url,options={})=>{
  const parsed=new URL(url),path=parsed.pathname;assert([A,B].includes(parsed.origin),'Synthetic local API only');requests.push({path,base:parsed.origin,body:options.body?JSON.parse(options.body):null});
  if(path==='/meta')return response({ok:true,paid:{available:true,configured:true}});
  if(path==='/health')return response({ok:true});
  if(path==='/paid/me'){
   const data={email:(parsed.origin===A?'a':'b')+'@example.test',credits:{available:parsed.origin===A?'1250':'2500',held:'0'},price_quote_available:true,models:structuredClone(rows),addons:{entitlements:[]}};
   return holdMe?new Promise(resolve=>heldAccounts.push(()=>resolve(response(data)))):response(data);
  }
  if(path==='/paid/price-quote'){
   const result=status===200?quote():{error:{code,message:'Synthetic selected route unavailable'}};
   const next=()=>response(result,status);
   return holdQuotes?new Promise(resolve=>held.push(()=>resolve(next()))):next();
  }
  return response(path==='/paid/auth/status'?{available:true,registration_enabled:true}:{});
 };
 return {local,session,requests,held,heldAccounts,set status(v){status=v;},set code(v){code=v;},set rows(v){rows=v;},set tariff(v){tariff=v;},set hold(v){holdQuotes=v;},set holdMe(v){holdMe=v;},advance(){clock+=601000;},open:()=>popupEntryFixture({local,session,fetchReply:reply,now:()=>clock,manualTimers:true})};
}
await check('Every selected model in a 13-model actual popup keeps catalogue rates and a clear route-unavailable reason after503',async()=>{
 for(const [index,id]of ids.entries()){
  const env=environment(id),popup=await env.open();
  try{
   await popup.settle(180);assert.equal(popup.errors.length,0,popup.errors.join('\n'));
   assert.equal(popup.fields.get('ai-paid-model').options.length,13);assert.equal(popup.fields.get('ai-paid-model').value,id);
   assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ '+(index+2)+' TP',id);
   assert.equal(popup.fields.get('ai-paid-model-output').textContent,'≈ '+(index+4)+' TP',id);
   assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/catalogue/i);assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/route|options/i);
   assert.match(popup.fields.get('ai-paid-status').textContent,/Refresh|Contact support|different model/i);
   assert(!/opaque-not-cached/.test(JSON.stringify(env.local)),'No quote capability in storage');
   assert.equal(popup.calls.filter(call=>call.url.includes('/ai/translate')||call.url.includes('/chat/completions')).length,0);
  }finally{popup.close();}
 }
});
await check('Fresh catalogue displays before a held selected quote; successful paired response updates only its own estimate',async()=>{
 const env=environment();env.hold=true;env.status=200;const popup=await env.open();
 try{
  await popup.settle(180);assert(env.held.length);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/catalogue/i);
  env.hold=false;for(const done of env.held.splice(0))done();await popup.settle(200);
  assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 80 TP');assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/paired route/i);
  const options=popup.fields.get('ai-paid-model-options').children;assert.equal(options.length,13);assert.match(options[1].textContent,/≈ 3/);
 }finally{popup.close();}
});
await check('Quiet cached reopen preserves catalogue estimates before held fresh verification and cannot label a live paired quote',async()=>{
 const env=environment(),first=await env.open();await first.settle(180);first.close();env.holdMe=true;env.advance();const popup=await env.open();
 try{
  await popup.settle(180);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(popup.fields.get('ai-paid-model').disabled,false,'.72: the remembered list is selectable at once; verification continues in the background');
  assert.doesNotMatch(popup.fields.get('ai-paid-model-price-status').textContent,/Current paired/);
  assert(!popup.paints.some(row=>['ai-paid-account-state','ai-paid-model-input'].includes(row.id)&&/Checking|Loading|^—/.test(row.text)));
 }finally{popup.close();for(const done of env.heldAccounts.splice(0))done();}
});
await check('Selected option failure retains catalogue while fresh model refresh changes prices and removed model selection is reconciled',async()=>{
 const env=environment();env.code='PAID_MODEL_PARAMETER_UNSUPPORTED';const popup=await env.open();
 try{
  await popup.settle(180);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
  const rows=modelRows().slice(1);rows[0].catalogue_pricing=pricing(23,45);env.rows=rows;env.advance();pricesChanged(popup);await popup.settle(200);
  assert.equal(popup.fields.get('ai-paid-model').options.length,12);assert.equal(popup.fields.get('ai-paid-model').value,ids[1]);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 23 TP');
  assert.match(popup.fields.get('ai-paid-status').textContent,/options|model|support/i);
 }finally{popup.close();}
});
await check('Late quote cannot restore a signed-out or replacement API/account display',async()=>{
 for(const action of ['signout','api-change']){
  const env=environment();env.hold=true;env.status=200;const popup=await env.open();
  try{
   await popup.settle(180);assert(env.held.length);
   const oldQuotes=env.held.splice(0);
   if(action==='signout')popup.fields.get('ai-paid-logout').click();
   else popup.writeLocal({customApiUrl:B,apiUrlDefault:B,paidApiBase:B,paidSessionToken:'synthetic-b',paidModel:ids[1]});
   await popup.settle(180);const before=popup.fields.get('ai-paid-model-input').textContent;
   for(const done of oldQuotes)done();await popup.settle(180);
   assert.notEqual(popup.fields.get('ai-paid-model-input').textContent,'≈ 80 TP',action);
   if(action==='signout')assert.equal(env.local.paidSessionToken,'');
   else assert.equal(popup.fields.get('ai-paid-model-input').textContent,before,'Old API quote cannot repaint replacement owner');
  }finally{popup.close();}
 }
});
// 10491: a saved failure is display only and is asked again once per popup open/visible (no timer).
await check('Permanent quote failures are asked again once on reopen, never by a timer; explicit refresh and changed metadata retry',async()=>{
 const env=environment(),first=await env.open();await first.settle(180);first.close();
 const count=()=>env.requests.filter(x=>x.path==='/paid/price-quote').length;
 assert.equal(count(),1);env.advance();const popup=await env.open();
 try{
  await popup.settle(180);assert.equal(count(),2,'Reopen asks the saved failure again once');
  env.advance();popup.runDueTimers();await popup.settle(180);assert.equal(count(),2,'No timer replays the quote');
  popup.fields.get('ai-paid-refresh').click();await popup.settle(180);assert.equal(count(),3,'Explicit refresh retries');
  const rows=modelRows();rows[0].catalogue_pricing.model_revision++;env.rows=rows;env.advance();pricesChanged(popup);await popup.settle(180);assert.equal(count(),4,'A prices change signal re-reads the catalogue and asks the failed quote again');
 }finally{popup.close();}
});
await check('Model change while a selected quote is pending queues its own fresh quote and rejects the previous model response',async()=>{
 const env=environment();env.status=200;env.hold=true;const popup=await env.open();
 try{
  await popup.settle(180);assert.equal(popup.fields.get('ai-paid-model').disabled,false,'Fresh account can select model before quote returns');
  const first=env.held.splice(0);assert(first.length);
  const model=popup.fields.get('ai-paid-model');model.value=ids[1];model.dispatchEvent({type:'change',preventDefault(){}});await popup.settle(180);
  for(const done of first)done();await popup.settle(180);
  assert.equal(model.value,ids[1]);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 3 TP');
  assert(env.requests.some(x=>x.path==='/paid/price-quote'&&x.body.model===ids[1]),'Replacement model receives its own fresh quote');
  env.hold=false;for(const done of env.held.splice(0))done();await popup.settle(180);
  assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 80 TP');assert.equal(model.value,ids[1]);
 }finally{popup.close();}
});
await check('Selected option changes invalidate a permanent failure, while temporary price refresh errors recover on the next catalogue read',async()=>{
 const env=environment(),popup=await env.open();
 try{
  await popup.settle(180);const count=()=>env.requests.filter(x=>x.path==='/paid/price-quote').length;
  assert.equal(count(),1);const image=popup.fields.get('ai-page-image');image.checked=true;image.dispatchEvent({type:'change',preventDefault(){}});await popup.settle(200);
  assert.equal(count(),2);assert(env.requests.filter(x=>x.path==='/paid/price-quote').at(-1).body.image);
  env.code='PAID_PRICE_REFRESHING';popup.fields.get('ai-paid-refresh').click();await popup.settle(200);assert.equal(count(),3);
  assert.match(popup.fields.get('ai-paid-status').textContent,/updating.*Refresh/i);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
  env.status=200;env.advance();pricesChanged(popup);await popup.settle(200);assert.equal(count(),4);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 80 TP');
 }finally{popup.close();}
});
await check('Catalogue cached during a pending quote survives close and is display-only on the next unchanged open',async()=>{
 const env=environment();env.hold=true;env.status=200;const first=await env.open();await first.settle(180);
 assert.equal(first.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');first.close();env.holdMe=true;env.advance();const popup=await env.open();
 try{
  await popup.settle(180);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(popup.fields.get('ai-paid-model').disabled,false,'.72: the remembered list is selectable at once; verification continues in the background');
  assert.doesNotMatch(popup.fields.get('ai-paid-model-price-status').textContent,/Current paired/);
  for(const done of env.held.splice(0))done();await popup.settle(150);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP','Closed popup reply cannot mutate reopened display');
 }finally{popup.close();for(const done of env.heldAccounts.splice(0))done();}
});
await check('Conditional paired estimate is labeled honestly; malformed or absent rates never become zero and cache stores safe display metadata only',async()=>{
 const env=environment();env.status=200;env.tariff='conditional_ceiling';const popup=await env.open();
 try{await popup.settle(180);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≤ 80 TP');assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/tier ceiling.*reported usage/);}finally{popup.close();}
 const catalog=pricing(2,4);
 for(const bad of [null,{},pricing('NaN',4),pricing('-1',4),{...catalog,unit:'USD_PER_MILLION_TOKENS'}]){
  assert.equal(paidModelRates({pricing:bad}),null);
  assert.deepEqual(paidModelRates({pricing:bad,catalogue_pricing:catalog}),{input:'2',output:'4'});
 }
 let storage={};const cache=createPaidViewCache({read:async()=>storage,write:async patch=>Object.assign(storage,patch)}),scope=await accountViewScope(A,'synthetic');
 const row={id:ids[0],catalogue_pricing:{...catalog,quote_token:'FORBIDDEN',bank_account:'FORBIDDEN'},pricing:{...catalog,tariff_basis:'conditional_ceiling',quote_token:'FORBIDDEN'},route_quote_failure:{code:'PAID_ROUTE_UNAVAILABLE',context:'a'.repeat(64),secret:'FORBIDDEN'},route_price_sync:{status:'current',quote_token:'FORBIDDEN'}};
 await cache.remember(scope,'me',{credits:{available:'10'},models:[row]});const restored=(await cache.restore(scope,'me')).models[0];
 assert.equal(restored.catalogue_pricing.model_revision,2);assert.equal(restored.pricing.tariff_basis,'conditional_ceiling');assert.equal(restored.route_price_sync,undefined);assert(!JSON.stringify(storage).includes('FORBIDDEN'));
 assert.deepEqual(restored.route_quote_failure,{code:'PAID_ROUTE_UNAVAILABLE',context:'a'.repeat(64)});
});
await check('Changing model clears the previous model route error immediately while the replacement account read is pending',async()=>{
 const env=environment(),popup=await env.open();
 try{
  await popup.settle(180);assert.match(popup.fields.get('ai-paid-status').textContent,/No priced route/);
  env.holdMe=true;const model=popup.fields.get('ai-paid-model');model.value=ids[1];model.dispatchEvent({type:'change',preventDefault(){}});await popup.settle(180);
  assert.equal(model.value,ids[1]);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 3 TP');assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/checking the selected route/);
  assert.doesNotMatch(popup.fields.get('ai-paid-status').textContent,/No priced route|unavailable|different model/i,'Unverified replacement model cannot inherit a failed previous quote');
 }finally{popup.close();for(const done of env.heldAccounts.splice(0))done();}
});
await check('Normal boot preserves a valid saved Paid high/image/examples profile and quotes those exact options before the first account render',async()=>{
 const env=environment();env.status=200;
 const rows=modelRows();rows[0].model_capabilities={reasoning:{supported:true,control:'levels',supported_efforts:['low','high'],can_disable:true,mandatory:false},vision:{supported:true}};env.rows=rows;
 const key=JSON.stringify([A,ids[0]]),profile={thinking:'high',pageImage:'always',memoryMode:'full',translationMode:'conversation',styleExamples:true,styleExamplesPreferenceVersion:1,conversationReset:'seed-owner'};
 env.local.paidAiProfilesV1={version:1,entries:{[key]:{profile:structuredClone(profile),prompts:{th:{text:'SAVED_SYNTHETIC_STYLE',mode:'replace'}}}}};
 const popup=await env.open();
 try{
  await popup.settle(200);const first=env.requests.find(x=>x.path==='/paid/price-quote');assert(first);
  assert.equal(first.body.thinking,'high','Initial quote must use saved profile intent');assert.equal(first.body.image,true);
  assert.deepEqual(env.local.paidAiProfilesV1.entries[key].profile,profile);assert.equal(env.local.paidAiProfilesV1.entries[key].prompts.th.text,'SAVED_SYNTHETIC_STYLE');
  assert.equal(popup.fields.get('ai-thinking').value,'high');assert.equal(popup.fields.get('ai-page-image').checked,true);assert.equal(popup.fields.get('ai-style-examples').checked,true);
 }finally{popup.close();}
 env.holdMe=true;env.advance();const reopened=await env.open();
 try{await reopened.settle(180);assert.deepEqual(env.local.paidAiProfilesV1.entries[key].profile,profile);assert.equal(reopened.fields.get('ai-thinking').value,'high');assert.equal(reopened.fields.get('ai-page-image').checked,true);assert.equal(reopened.fields.get('ai-style-examples').checked,true);}
 finally{reopened.close();for(const done of env.heldAccounts.splice(0))done();}
});
await check('Actual400 thinking, image and output unsupported errors keep catalogue rates, explain the action and do not repeat unchanged; changed profile or limits retries',async()=>{
 for(const [code,reason]of [['PAID_THINKING_UNSUPPORTED',/thinking level.*Lowest available/i],['PAID_IMAGE_UNSUPPORTED',/Page images.*Turn off/i],['PAID_OUTPUT_UNSUPPORTED',/answer size.*different model/i]]){
  const env=environment();env.status=400;env.code=code;
  const rows=modelRows();rows[0].model_capabilities={reasoning:{supported:true,control:'levels',supported_efforts:['low','high'],can_disable:true,mandatory:false}};env.rows=rows;
  env.local.paidAiProfilesV1={version:1,entries:{[JSON.stringify([A,ids[0]])]:{profile:{thinking:'high',pageImage:'always',styleExamples:false,styleExamplesPreferenceVersion:1},prompts:{}}}};
  const first=await env.open();await first.settle(180);
  assert.equal(first.fields.get('ai-paid-model-input').textContent,'≈ 2 TP',code);assert.match(first.fields.get('ai-paid-status').textContent,reason,code);
  const count=()=>env.requests.filter(x=>x.path==='/paid/price-quote').length;assert.equal(count(),1);first.close();env.advance();const popup=await env.open();
  try{
   await popup.settle(180);assert.equal(count(),2,'Reopen asks '+code+' again once');assert.match(popup.fields.get('ai-paid-status').textContent,reason);
   if(code==='PAID_THINKING_UNSUPPORTED'){const thinking=popup.fields.get('ai-thinking');thinking.value='minimum';thinking.dispatchEvent({type:'change',preventDefault(){}});}
   else if(code==='PAID_IMAGE_UNSUPPORTED'){const image=popup.fields.get('ai-page-image');image.checked=false;image.dispatchEvent({type:'change',preventDefault(){}});}
   else{rows[0].max_output=4096;env.rows=rows;env.advance();pricesChanged(popup);}
   await popup.settle(200);assert.equal(count(),3,'Changed owned context retries '+code+' '+JSON.stringify({profiles:Object.values(env.local.paidAiProfilesV1.entries).map(x=>({thinking:x.profile.thinking,image:x.profile.pageImage})),thinking:popup.fields.get('ai-thinking').value}));assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
   const sent=env.requests.filter(x=>x.path==='/paid/price-quote').at(-1).body;
   if(code==='PAID_THINKING_UNSUPPORTED')assert.equal(sent.thinking,'minimum');
   else if(code==='PAID_IMAGE_UNSUPPORTED')assert.equal(sent.image,false);
   else assert.equal(sent.max_tokens,4096);
  }finally{popup.close();}
 }
});
await check('Thinking verification and temporary price refresh errors remain retryable and never become permanent cached failures',async()=>{
 for(const code of ['PAID_THINKING_UNVERIFIED','PAID_PRICE_REFRESHING']){
  const env=environment();env.status=400;env.code=code;const first=await env.open();await first.settle(180);
  assert.equal(first.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.match(first.fields.get('ai-paid-status').textContent,code==='PAID_THINKING_UNVERIFIED'?/thinking options.*verified.*Refresh/i:/updating.*Refresh/i);first.close();
  const count=()=>env.requests.filter(x=>x.path==='/paid/price-quote').length;env.advance();const popup=await env.open();
  try{await popup.settle(180);assert.equal(count(),2);assert(!JSON.stringify(env.local.paidAccountViewCacheV1?.me).includes('route_quote_failure'));env.advance();pricesChanged(popup);await popup.settle(180);assert.equal(count(),3);}
  finally{popup.close();}
 }
});
await check('An edit while the first quote is held survives later Manual-profile initialization and is used by the replacement quote',async()=>{
 const env=environment();env.status=200;env.hold=true;
 // 10488: only a model with a proven AI think control is quoted with a thinking choice.
 const rows=modelRows();rows[0].model_capabilities={reasoning:{supported:true,control:'levels',supported_efforts:['low','high'],can_disable:true,mandatory:false}};env.rows=rows;
 const key=JSON.stringify([A,ids[0]]);env.local.paidAiProfilesV1={version:1,entries:{[key]:{profile:{thinking:'high',pageImage:'always',styleExamples:true,styleExamplesPreferenceVersion:1},prompts:{th:{text:'EXACT EARLY STYLE',mode:'replace'}}}}};
 const popup=await env.open();
 try{
  await popup.settle(180);assert(env.held.length);assert.equal(popup.fields.get('ai-thinking').value,'high');
  const thinking=popup.fields.get('ai-thinking');thinking.value='low';thinking.dispatchEvent({type:'change',preventDefault(){}});await popup.settle(180);
  env.hold=false;for(const done of env.held.splice(0))done();await popup.settle(220);
  assert.equal(env.local.paidAiProfilesV1.entries[key].profile.thinking,'low');assert.equal(popup.fields.get('ai-thinking').value,'low');
  assert.equal(env.requests.filter(x=>x.path==='/paid/price-quote').at(-1).body.thinking,'low');
  assert.equal(env.local.paidAiProfilesV1.entries[key].profile.styleExamples,true);assert.equal(env.local.paidAiProfilesV1.entries[key].prompts.th.text,'EXACT EARLY STYLE');
 }finally{popup.close();}
});
await check('Login scoped high/image/examples/style choices survive normal boot and invalid Manual-profile recovery without cross-model seeding',async()=>{
 const provider='login_gemini',model='synthetic-web-model',accountId='b'.repeat(32),sessionId='lgs_'+'a'.repeat(48),key=JSON.stringify([A,provider,accountId,model]);
 for(const invalidManual of [false,true]){
  const local={...savedFor(ids[0]),paidTranslationSource:'login',loginProvider:provider,loginModel:model,aiProvider:'openrouter',aiModel:'synthetic-manual',aiKey:'synthetic-key'};
  if(invalidManual)Object.assign(local,{aiProfileStorageVersion:2,aiProfilesV1:{version:99}});
  const profile={thinking:'high',pageImage:'always',memoryMode:'full',translationMode:'conversation',styleExamples:true,styleExamplesPreferenceVersion:1,conversationReset:'login-owner'};
  local.loginAiProfilesV1={version:1,entries:{[key]:{profile:structuredClone(profile),prompts:{th:{text:'EXACT LOGIN STYLE',mode:'replace'}}}}};
  const session={loginSessionId:sessionId,loginAccountId:accountId},caps={reasoning:{supported:true,control:'levels',supported_efforts:['low','high'],mandatory:false,can_disable:true},vision:{supported:true}};
  const popup=await popupEntryFixture({local,session,manualTimers:true,fetchReply:url=>{
   const path=new URL(url).pathname;
   return Response.json(path==='/meta'?{ok:true,paid:{available:true,configured:true}}:path==='/paid/me'?{email:'synthetic@example.test',credits:{available:'1250',held:'0'},models:modelRows(),addons:{entitlements:[{code:'ai_login',status:'active'}]}}:path==='/login/providers'?{providers:[{id:provider,name:'Gemini',available:true,supported:true,sign_in_available:true,translation_supported:true,support_status:'supported',session:{id:sessionId,account_id:accountId,provider,transport:'web_endpoint'}}]}:path.endsWith('/models')?{models:[{id:model,name:'Synthetic web model',model_capabilities:caps}]}:path==='/health'?{ok:true}:{});
  }});
  try{
   await popup.settle(220);assert.equal(popup.fields.get('ai-login-model').value,model);
   assert.deepEqual(local.loginAiProfilesV1.entries[key].profile,profile);assert.equal(local.loginAiProfilesV1.entries[key].prompts.th.text,'EXACT LOGIN STYLE');
   assert.equal(popup.fields.get('ai-style-examples').checked,true);assert.equal(popup.fields.get('ai-page-image').checked,true);assert.equal(popup.fields.get('ai-thinking').value,'high');
   assert.equal(popup.calls.filter(x=>x.url.endsWith('/paid/price-quote')).length,0,'Login never starts TP quote or generation while hydrating');
  }finally{popup.close();}
 }
});
await check('Model cooldown keeps other choices usable, avoids quoting the paused model and recovers on a fresh account read',async()=>{
 const env=environment();const rows=modelRows();rows[0].availability={available:false,reason:'PAID_MODEL_PAUSED'};env.rows=rows;
 const popup=await env.open();
 try{
  await popup.settle(180);assert.match(popup.fields.get('ai-paid-model-price-status').textContent,/temporarily paused/i);
  assert.equal(popup.fields.get('ai-paid-model-options').children[0].disabled,true);
  assert.equal(popup.fields.get('ai-paid-model-options').children[1].disabled,false);
  assert.equal(env.requests.filter(x=>x.path==='/paid/price-quote').length,0);
  env.rows=modelRows();env.status=200;popup.fields.get('ai-paid-refresh').click();await popup.settle(180);
  assert.equal(popup.fields.get('ai-paid-model-options').children[0].disabled,false);
  assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 80 TP');
 }finally{popup.close();}
});
console.log(JSON.stringify({scope:'Actual production popup entry/import graph, synthetic13-model account+typed HTTP replies; no live provider, reservation, charge or browser pixels',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
