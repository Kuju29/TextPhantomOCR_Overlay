/** Production popup entry/HTTP contract; synthetic data, no live accounts. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
const base='http://localhost:7860',provider='login_deepseek',model='deepseek-chat',checks=[];
const me={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:'tp-model',name:'Saved TP model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6'}}],addons:{entitlements:[{code:'ai_login',status:'active'}]}};
const auth={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider,transport:'web_endpoint'};
const account={...me,packages:[{id:'pkg_'+'c'.repeat(32),version:1,name:'Synthetic package',price_satang:2900,credits:'250000',months:6}],purchase:{ready:true},history:Object.fromEntries(['orders','payments','usage','lots','refunds','ledger'].map(kind=>[kind,{items:[],total:0,offset:0,limit:25}])),addons:{products:[],orders:[],entitlements:me.addons.entitlements}};
const field=(h,id)=>h.fields.get(id),reply=(data,status=200)=>Response.json(data,{status});
let selected='',apiFixturePath='';
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
 if(args[i]==='--api-fixture'){assert(args[i+1]&&!args[i+1].startsWith('--'),'--api-fixture requires a file path');apiFixturePath=args[++i];}
 else if(args[i]==='--case'){assert(args[i+1],'--case requires a case name');selected=args[++i];}
 else if(!args[i].startsWith('--')&&!selected)selected=args[i];
 else throw Error('Unknown test argument: '+args[i]);
}
const run=async(name,fn)=>{if(selected&&selected!==name)return;await fn();checks.push(name);};
function harness(source='tp'){
 let phase='healthy',clock=Date.now(),models=me.models,credits=me.credits,inventory;const session={};
 const local={mode:'lens_text',sources:'ai',lang:'th',uiLanguageV1:'en',customApiUrl:base,apiDefaultsFetchedAt:clock,aiServiceMode:'paid',paidTranslationSource:source,paidSessionToken:'synthetic-owner',paidApiBase:base,paidServiceApiBase:base,paidModel:'tp-model',loginProvider:provider,loginModel:model,tpDataConsentV1:{version:1,granted:true,at:1}}; // 10495: this user allowed account data
 const fetchReply=async url=>{
  assert.equal(new URL(url).origin,base,'Fixture must not request a live service');const path=new URL(url).pathname;
  if(path==='/meta')return reply(phase==='metadata-failure'?{error:{message:'Synthetic metadata unavailable'}}:{ok:true,paid:{configured:true}},phase==='metadata-failure'?503:200);
  if(path==='/health')return reply({ok:true});
  if(path==='/paid/me'){
   if(phase==='me-invalid')return new Response('invalid',{status:200});
   if(phase==='me-incomplete')return reply({});
   if(phase==='me-balance-invalid')return reply({...me,credits:{available:'NaN',held:'0'}});
   if(phase==='me-balance-missing')return reply({...me,credits:{held:'0'}});
   if(phase==='me-balance-unsafe')return reply({...me,credits:{available:Number.MAX_SAFE_INTEGER+1,held:'0'}});
   if(phase==='me-held-invalid')return reply({...me,credits:{available:'1250',held:'Infinity'}});
   if(phase==='me-eligible-invalid')return reply({...me,models:[{...me.models[0],eligible_tp:'Infinity'}]});
   if(phase==='me-model-invalid')return reply({...me,models:[{}]});
   if(phase==='me-failure')return reply({error:{message:'Synthetic balance unavailable'}},503);
   if(phase==='revoked')return reply({error:{message:'Synthetic expired account'}},401);
   const inventoryFields=inventory?{model_inventory:{...inventory,status:phase==='inventory-unavailable'?'unavailable':inventory.status}}:{};
   return reply(phase==='removed-model'||phase==='inventory-unavailable'?{...me,...inventoryFields,credits,models:[]}:phase==='revoked-addon'?{...me,...inventoryFields,credits,models,addons:{entitlements:[]}}:{...me,...inventoryFields,credits,models});
  }
  if(path==='/login/providers')return phase==='providers-failure'?reply({error:{message:'Synthetic provider unavailable'}},503):reply({providers:[{id:provider,name:'DeepSeek',available:true,supported:true,translation_supported:true,session:phase==='absent-provider'?null:auth}]});
  if(path==='/login/providers/'+provider+'/models')return phase==='models-invalid'?reply({models:{}}):phase==='models-invalid-row'?reply({models:[null]}):phase==='models-removed'?reply({models:[]}):reply({models:[{id:model,name:'Saved DeepSeek model'}]});
  if(path==='/paid/account'){
   if(phase==='account-failure')return reply({error:{message:'Synthetic account details unavailable'}},503);
   if(phase==='account-missing-models'){const {models,...missing}=account;return reply(missing);}
   return reply(phase==='account-invalid'?{...account,credits:{available:'NaN',held:'0'}}:phase==='account-invalid-models'?{...account,models:[null]}:account);
  }
  if(path==='/paid/auth/status')return reply({available:true});
  return reply({});
 };
 return{local,session,get phase(){return phase;},set phase(v){phase=v;},set models(v){models=v;},set credits(v){credits=v;},set inventory(v){inventory=v;},get clock(){return clock;},
  async boot({cold=false,apiSnapshot,fetchOverride}={}){const h=await popupEntryFixture({local:cold?{...local,paidAccountViewCacheV1:null}:local,session,fetchReply:fetchOverride||fetchReply,now:()=>clock,manualTimers:true,apiSnapshot});await h.settle(180);return h;},
  async seed(){const h=await this.boot();assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(h.errors.length,0);h.close();},
  async recover(h){phase='healthy';clock+=11000;h.runDueTimers();await h.settle(160);},
 };
}
await run('metadata failure stays visible beside previous values',async()=>{
 const s=harness();await s.seed();s.phase='metadata-failure';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(field(h,'ai-paid-model-name').textContent,'Saved TP model');assert.equal(field(h,'ai-paid-model').disabled,true);
  const visible=field(h,'ai-paid-status').style.display!=='none'?field(h,'ai-paid-status').textContent:'';
  const notice=field(h,'ai-paid-unavailable').style.display!=='none'?field(h,'ai-paid-connection-message').textContent:'';
  assert.match(visible+' '+notice,/could not|unavailable|paused/i,'Current metadata failure must not be hidden behind previous success');
  assert(!h.calls.some(row=>row.url.endsWith('/paid/me')),'Cached health/account cannot authorize a request without live metadata');
  await s.recover(h);assert.equal(field(h,'ai-paid-model').disabled,false);assert.equal(field(h,'ai-paid-unavailable').style.display,'none');assert.equal(field(h,'ai-paid-status').textContent,'');
 }finally{h.close();}
});
await run('full bounded catalog retains late selected model on cached reopen',async()=>{
 const s=harness();s.models=Array.from({length:150},(_,i)=>({...me.models[0],id:'arbitrary-vendor/native-'+i,name:'Generic model '+i}));s.local.paidModel='arbitrary-vendor/native-149';
 await s.seed();const h=await s.boot({fetchOverride:()=>new Promise(()=>{})});try{
  assert.equal(field(h,'ai-paid-model').options.length,150,'Snapshot must not truncate a larger verified inventory at100');assert.equal(field(h,'ai-paid-model').value,'arbitrary-vendor/native-149');assert.equal(field(h,'ai-paid-model-name').textContent,'Generic model 149');assert.equal(field(h,'ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(field(h,'ai-paid-model').disabled,false,'.72 owner rule: a complete saved inventory is selectable while fresh reads are held (re-validated afterwards)');
 }finally{h.close();}
 s.models=Array.from({length:5001},(_,i)=>({...me.models[0],id:'arbitrary-vendor/native-'+i,name:'Generic model '+i}));const rejected=await s.boot();try{
  assert.equal(field(rejected,'ai-paid-model').options.length,150);assert.equal(field(rejected,'ai-paid-model-name').textContent,'Generic model 149');assert.equal(field(rejected,'ai-paid-model').disabled,true);assert.match(field(rejected,'ai-paid-status').textContent,/last loaded|paused/i);
 }finally{rejected.close();}
});
await run('invalid Login models retain values and show current warning',async()=>{
 for(const phase of ['models-invalid','models-invalid-row']){const s=harness('login');await s.seed();s.phase=phase;const h=await s.boot();try{
  assert.equal(h.errors.length,0);assert.equal(field(h,'ai-login-model').value,model);assert.equal(field(h,'ai-login-model').selectedOptions[0]?.textContent,'Saved DeepSeek model');assert.equal(field(h,'ai-login-model').disabled,true);assert.match(field(h,'ai-login-status').textContent,/model.*invalid|invalid.*model/i);
  s.phase='healthy';field(h,'ai-login-refresh').click();await h.settle(180);assert.equal(field(h,'ai-login-model').disabled,false);assert.doesNotMatch(field(h,'ai-login-status').textContent,/invalid|failed|unavailable/i,'Successful retry replaces the old failure');
 }finally{h.close();}}
});
await run('Login service failure and successful retry update status',async()=>{
 const s=harness('login');await s.seed();s.phase='providers-failure';const h=await s.boot();try{
  assert.equal(field(h,'ai-login-model').value,model);assert.equal(field(h,'ai-login-model').disabled,true);assert.match(field(h,'ai-login-status').textContent,/Synthetic provider unavailable/);
  s.phase='healthy';field(h,'ai-login-refresh').click();await h.settle(180);assert.equal(field(h,'ai-login-model').disabled,false);assert.doesNotMatch(field(h,'ai-login-status').textContent,/Synthetic provider unavailable/,'A recovered catalogue must replace the previous temporary error');
 }finally{h.close();}
});
await run('balance 503 invalid JSON and incomplete DTO keep values with warning',async()=>{
 for(const phase of ['me-failure','me-invalid','me-incomplete']){const s=harness();await s.seed();s.phase=phase;const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(field(h,'ai-paid-model-name').textContent,'Saved TP model');assert.equal(field(h,'ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(field(h,'ai-paid-model').disabled,true);assert.match(field(h,'ai-paid-status').textContent,/last loaded|paused/i);assert.equal(field(h,'ai-paid-status').getAttribute('data-kind'),'warning');
  await s.recover(h);assert.equal(field(h,'ai-paid-model').disabled,false);assert.equal(field(h,'ai-paid-status').textContent,'');
 }finally{h.close();}}
});
await run('malformed balance held eligible credit and model rows cannot replace success',async()=>{
 for(const phase of ['me-balance-invalid','me-balance-missing','me-balance-unsafe','me-held-invalid','me-eligible-invalid','me-model-invalid']){const s=harness();await s.seed();s.phase=phase;const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP',phase+' cannot erase a known balance');assert.equal(field(h,'ai-paid-model-name').textContent,'Saved TP model');assert.equal(field(h,'ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(field(h,'ai-paid-model').disabled,true);assert.match(field(h,'ai-paid-status').textContent,/last loaded|paused/i);
  await s.recover(h);assert.equal(field(h,'ai-paid-model').disabled,false);
 }finally{h.close();}}
});
await run('large integer string TP stays exact and optional fields remain compatible',async()=>{
 const s=harness(),large='900719925474099312345678901234567890';s.credits={available:large};const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,BigInt(large).toLocaleString('en-US')+' TP');assert.equal(field(h,'ai-paid-model').disabled,false);assert.equal(h.errors.length,0);
 }finally{h.close();}
});
await run('current removed model replaces old choices without authorization',async()=>{
 const s=harness();await s.seed();s.phase='removed-model';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(field(h,'ai-paid-model').options.length,0);assert.match(field(h,'ai-paid-status').textContent,/No models are enabled/);assert.equal(field(h,'ai-paid-model-input').textContent,'—');
 }finally{h.close();}
});
await run('unavailable same-key inventory retains display but no model or quote authority',async()=>{
 const s=harness();s.inventory={mode:'all',status:'current',scope:'key',key_revision:7,checked_at:Date.now(),live_availability_verified:false};await s.seed();s.phase='inventory-unavailable';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(field(h,'ai-paid-model-name').textContent,'Saved TP model');assert.equal(field(h,'ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(field(h,'ai-paid-model').disabled,true);assert.match(field(h,'ai-paid-status').textContent,/catalogue|unavailable|paused/i);assert(!h.calls.some(row=>row.url.endsWith('/paid/price-quote')));
  s.phase='healthy';field(h,'ai-paid-refresh').click();await h.settle(180);assert.equal(field(h,'ai-paid-model').disabled,false);assert.equal(field(h,'ai-paid-status').textContent,'');
 }finally{h.close();}
});
await run('changed-key inventory retires old models and current empty confirms removal',async()=>{
 const s=harness();s.inventory={mode:'all',status:'current',scope:'key',key_revision:7,checked_at:Date.now(),live_availability_verified:false};await s.seed();s.inventory={mode:'all',status:'unavailable',scope:'key',key_revision:8,checked_at:null,live_availability_verified:false};s.phase='inventory-unavailable';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-model').options.length,0);assert.equal(field(h,'ai-paid-model-input').textContent,'—');assert.equal(field(h,'ai-paid-model').disabled,true);assert.match(field(h,'ai-paid-status').textContent,/catalogue|unavailable|paused/i);
 }finally{h.close();}
 s.inventory={mode:'all',status:'current',scope:'key',key_revision:8,checked_at:Date.now(),live_availability_verified:false};s.phase='removed-model';const current=await s.boot();try{assert.equal(field(current,'ai-paid-model').options.length,0);assert.match(field(current,'ai-paid-status').textContent,/No models are enabled/);}finally{current.close();}
});
await run('revoked account clears cached presentation and current session',async()=>{
 const s=harness('login');await s.seed();s.phase='revoked';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'— TP');assert.equal(field(h,'ai-login-model').options.length,0);assert.equal(field(h,'ai-login-model').disabled,true);assert.equal(s.local.paidSessionToken,'');assert.equal(s.local.loginProviderDisplayCacheV1,null);assert.match(field(h,'ai-paid-status').textContent,/expired|sign in/i);
 }finally{h.close();}
});
await run('revoked addon and absent provider remove Login readiness',async()=>{
 for(const phase of ['revoked-addon','absent-provider','models-removed']){const s=harness('login');await s.seed();s.phase=phase;const h=await s.boot();try{
  assert.equal(field(h,'ai-login-model').options.length,0);assert.equal(field(h,'ai-login-model').disabled,true);assert.match(field(h,'ai-login-status').textContent,phase==='revoked-addon'?/inactive|access/:phase==='absent-provider'?/Login opens|Sign in/:/model|quota/i);
 }finally{h.close();}}
});
await run('inline account retains prior balance plus error and blocks purchase',async()=>{
 const s=harness();const h=await s.boot();try{
  field(h,'ai-paid-details').click();await h.settle(180);const mount=field(h,'ai-paid-inline');assert.match(mount.textContent,/1,250/);
  s.phase='account-failure';const reload=mount.querySelectorAll('*').find(row=>row.tagName==='BUTTON'&&row.textContent==='Reload');assert(reload);reload.click();await h.settle(180);
  assert.match(mount.textContent,/1,250/);assert.match(mount.textContent,/Synthetic account details unavailable/);assert(mount.querySelectorAll('*').filter(row=>row.tagName==='BUTTON'&&['Select package','Buy add-on'].includes(row.textContent)).every(row=>row.disabled));
  s.phase='healthy';mount.querySelectorAll('*').find(row=>row.tagName==='BUTTON'&&row.textContent==='Reload').click();await h.settle(180);assert.doesNotMatch(mount.textContent,/Synthetic account details unavailable/);
 }finally{h.close();}
});
await run('inline malformed balance retains success plus validation warning',async()=>{
 for(const phase of ['account-missing-models','account-invalid','account-invalid-models']){const s=harness();const h=await s.boot();try{
  field(h,'ai-paid-details').click();await h.settle(180);const mount=field(h,'ai-paid-inline');assert.match(mount.textContent,/1,250/);
  s.phase=phase;mount.querySelectorAll('*').find(row=>row.tagName==='BUTTON'&&row.textContent==='Reload').click();await h.settle(180);
  assert.match(mount.textContent,/1,250/);assert.match(mount.textContent,/invalid|unavailable/i);assert(!/NaN|Infinity/.test(mount.textContent));
 }finally{h.close();}}
});
await run('cold failure stays honest and recovery loads first successful balance',async()=>{
 const s=harness();s.phase='me-failure';const h=await s.boot();try{
  assert.equal(field(h,'ai-paid-credits').textContent,'— TP');assert.equal(field(h,'ai-paid-model').disabled,true);assert.match(field(h,'ai-paid-connection-message').textContent,/unavailable|interrupted/i);
  await s.recover(h);assert.equal(field(h,'ai-paid-credits').textContent,'1,250 TP');assert.equal(field(h,'ai-paid-model').disabled,false);
 }finally{h.close();}
});
if(apiFixturePath)await run('actual Center HTTP exported selected all unavailable empty inventory reaches popup',async()=>{
 const dto=JSON.parse(await readFile(apiFixturePath,'utf8'));
 assert.equal(dto.selected.model_inventory.mode,'selected');assert.equal(dto.all.model_inventory.mode,'all');assert(dto.all.models.length>100);assert(dto.all.models.some(row=>row.id===dto.late_model));assert.equal(dto.unavailable_same_key.model_inventory.status,'unavailable');assert.equal(dto.empty_current.model_inventory.status,'current');assert.equal(dto.empty_current.models.length,0);
 let current=dto.selected;const quoteCalls=[];
 const s=harness();s.local.paidModel=dto.selected.models[0].id;
 const fetchReply=async(url,options={})=>{
  assert.equal(new URL(url).origin,base,'No live boundary in consumer replay');const p=new URL(url).pathname;
  if(p==='/meta')return reply({ok:true,paid:{configured:true}});
  if(p==='/health')return reply({ok:true});
  if(p==='/paid/me')return reply(current);
  if(p==='/paid/price-quote'){
   const body=JSON.parse(options.body);quoteCalls.push(body);const row=current.models.find(row=>row.id===body.model);assert(row,'Quote must belong to the currently exported inventory');assert.equal(body.max_tokens,row.max_output);
   return reply({pricing:row.pricing,route:{basis:'paired_endpoint_metadata',revision:row.route_price_sync.revision,checked_at:row.route_price_sync.checked_at}});
  }
  return reply({});
 };
 const h=await s.boot({fetchOverride:fetchReply});try{
  assert.equal(field(h,'ai-paid-model').options.length,dto.selected.models.length);
  current=dto.all;field(h,'ai-paid-refresh').click();await h.settle(200);assert.equal(field(h,'ai-paid-model').options.length,dto.all.models.length);
  field(h,'ai-paid-model').value=dto.late_model;field(h,'ai-paid-model').dispatchEvent({type:'change'});await h.settle(200);assert.equal(field(h,'ai-paid-model').value,dto.late_model);assert(quoteCalls.some(row=>row.model===dto.late_model),'A never-saved arbitrary key inventory model is selected through the normal handler');assert.equal(h.errors.length,0);
 }finally{h.close();}
 const pending=await s.boot({fetchOverride:()=>new Promise(()=>{})});try{assert.equal(field(pending,'ai-paid-model').options.length,dto.all.models.length);assert.equal(field(pending,'ai-paid-model').value,dto.late_model);assert.equal(field(pending,'ai-paid-model').disabled,true);}finally{pending.close();}
 current=dto.unavailable_same_key;const callsBefore=quoteCalls.length;const unavailable=await s.boot({fetchOverride:fetchReply});try{
  assert.equal(field(unavailable,'ai-paid-model').options.length,dto.all.models.length);assert.equal(field(unavailable,'ai-paid-model').value,dto.late_model);assert.equal(field(unavailable,'ai-paid-model').disabled,true);assert.match(field(unavailable,'ai-paid-status').textContent,/Previous models|paused/i);assert.equal(quoteCalls.length,callsBefore);
 }finally{unavailable.close();}
 current=dto.empty_current;const empty=await s.boot({fetchOverride:fetchReply});try{assert.equal(field(empty,'ai-paid-model').options.length,0);assert.match(field(empty,'ai-paid-status').textContent,/No models are enabled/);assert.equal(quoteCalls.length,callsBefore);}finally{empty.close();}
});
assert(checks.length>0,'No cases executed: unknown case selection');
console.log(JSON.stringify({passed:true,count:checks.length,checks,apiFixtureReplayed:Boolean(apiFixturePath),scope:'Actual popup.js/import graph and inline account; synthetic HTTP and manual clock, optional actual Center synthetic HTTP DTO export replay, no paid/live calls or browser pixels'}));
