import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
const base='http://localhost:7860',model='tp-model',provider='login_deepseek',loginModel='deepseek-chat';
const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-customer',paidApiBase:base,paidServiceApiBase:base,paidModel:model,loginProvider:provider,loginModel,aiProvider:'openrouter',aiModel:'fixture-model',aiKey:'synthetic-key'};
const session={},providerSession={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider,transport:'web_endpoint'};
const account={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:model,name:'TP saved model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6'}}],addons:{entitlements:[{code:'ai_login',status:'active'}]}};
const catalog={...account,packages:[{id:'fixture-pack',name:'Saved TP package',version:1,enabled:true,visible:true,price_satang:9900,credits_tp:'5000'}],history:{orders:{items:[],total:0},payments:{items:[],total:0},usage:{items:[],total:0},lots:{items:[],total:0},refunds:{items:[],total:0},ledger:{items:[],total:0}}};
let held=false,releases=[],accountStatus=200;const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const fetchReply=(url,opts)=>{
  const value=url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.endsWith('/paid/me')?account:url.endsWith('/paid/account')?catalog:url.endsWith('/login/providers')?{providers:[{id:provider,name:'DeepSeek',available:true,supported:true,session:providerSession}]}:url.includes('/login/providers/')?{models:[{id:loginModel,name:'DeepSeek saved model'}]}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:['fixture-model'],model_candidates:[{id:'fixture-model',eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model:'fixture-model',status:'passed'}:{};
  const status=url.endsWith('/paid/me')?accountStatus:200;
  if(held&&(url.endsWith('/meta')||url.includes('/paid/')||url.includes('/login/')))return new Promise((resolve,reject)=>{releases.push(()=>resolve(response(value,status)));opts.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})));});
  return Promise.resolve(response(value));
};
let clock=Date.now();
const first=await popupEntryFixture({local,session,fetchReply,now:()=>clock});await first.settle(100);
assert.equal(first.errors.length,0,first.errors.join('\n'));
assert.equal(first.fields.get('ai-paid-credits').textContent,'1,250 TP');
assert.equal(first.fields.get('ai-login-provider').selectedOptions[0]?.textContent,'DeepSeek');
assert.equal(first.fields.get('ai-login-model').value,loginModel);
first.fields.get('ai-paid-details').click();await first.settle(100);assert.equal(first.errors.length,0,first.errors.join('\n'));assert.match(first.fields.get('ai-paid-inline').textContent,/fixture@example.test/,'The actual account click must seed its scoped account/catalog display: '+JSON.stringify(first.calls.map(x=>x.url))+' status='+first.fields.get('ai-paid-status').textContent);
first.close();held=true;
const savedLocal=structuredClone(local),savedSession=structuredClone(session),checks=[];
// A normal reopen must reuse its display even when the freshness interval has
// elapsed: fresh authorization still comes only from the held current request.
clock+=Number(process.env.TP_REOPEN_DELAY_MS||61000);
const reopened=await popupEntryFixture({local,session,fetchReply,now:()=>clock});await reopened.settle(100);
try{
 assert.equal(reopened.errors.length,0,reopened.errors.join('\n'));
 assert.equal(reopened.fields.get('ai-paid-credits').textContent,'1,250 TP','Reopened normal popup entry must retain the previous TP display while refreshing.');
 assert.equal(reopened.fields.get('ai-paid-account-state').textContent,'Signed in');
 assert.equal(reopened.fields.get('ai-login-provider').selectedOptions[0]?.textContent,'DeepSeek','Reopened normal popup must retain provider label rather than Checking.');
 assert.equal(reopened.fields.get('ai-login-model').value,loginModel);
 assert.doesNotMatch(reopened.fields.get('ai-login-status').textContent,/Checking|Verifying/i);
 assert.equal(reopened.fields.get('ai-login-model').disabled,true,'Saved display cannot authorize Login before fresh account and model responses.');
 assert.equal(reopened.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
 assert.equal(reopened.fields.get('ai-paid-model-output').textContent,'≈ 6 TP');
 assert.equal(reopened.fields.get('ai-paid-inline').hidden,true,'A new popup must start on the normal panel even if Account details was open when the prior popup closed.');
 checks.push('Unchanged reopen after freshness expires retains provider/model/TP/rates and disables unverified controls');
 const since=reopened.paints.length;
 for(const next of [2,3,4]){releases.shift()();await reopened.settle(100);assert.equal(reopened.calls.filter(x=>/\/meta$|\/paid\/me$|\/login\//.test(x.url)).length,next);assert.equal(reopened.fields.get('ai-login-model').disabled,true);assert.equal(reopened.fields.get('ai-paid-credits').textContent,'1,250 TP');}
 releases.shift()();await reopened.settle(100);
 assert.equal(reopened.fields.get('ai-login-model').disabled,false);
 assert(!reopened.paints.slice(since).filter(x=>['ai-login-status','ai-paid-account-state','ai-paid-credits'].includes(x.id)).some(x=>/Checking|Verifying|Reconnecting|— TP/.test(x.text)),'Automatic metadata/account/provider/model stages must stay quiet when unchanged.');
 checks.push('Real startup metadata→account→provider→model chain stays quiet; fresh final response verifies controls');
 reopened.fields.get('ai-paid-details').click();await reopened.settle(100);assert.equal(reopened.fields.get('ai-paid-inline').hidden,false);assert.match(reopened.fields.get('ai-paid-inline').textContent,/fixture@example.test/);assert.doesNotMatch(reopened.fields.get('ai-paid-inline').textContent,/Loading your account/);assert(reopened.calls.some(x=>x.url.endsWith('/paid/account')),'Account details still requests current server data: '+reopened.fields.get('ai-paid-status').textContent);
 const nav=reopened.fields.get('ai-paid-inline').querySelectorAll('*').find(x=>x.tagName==='BUTTON'&&x.textContent==='Buy credits');assert(nav,'Actual customer account navigation must expose Buy credits.');nav.click();await reopened.settle(100);assert.match(reopened.fields.get('ai-paid-inline').textContent,/Saved TP package/);const purchase=reopened.fields.get('ai-paid-inline').querySelectorAll('*').find(x=>x.tagName==='BUTTON'&&/Select package/.test(x.textContent));assert(purchase?.disabled,'Stale catalog display must not enable purchase before the current account/catalog response.');checks.push('Actual Account details and package navigation retain stale catalog read-only; reopening always starts at main panel');
}finally{reopened.close();}
for(const [name,patch]of [['account',{paidSessionToken:'synthetic-other'}],['API',{customApiUrl:'http://localhost:7861'}],['provider',{loginProvider:'login_claude'}],['model',{loginModel:'other-model'}]]){
 releases=[];const changed=await popupEntryFixture({local:{...structuredClone(savedLocal),...patch},session:structuredClone(savedSession),fetchReply,now:()=>clock});await changed.settle(100);
 try{
  assert.equal(changed.errors.length,0,changed.errors.join('\n'));
  assert(!changed.fields.get('ai-login-provider').selectedOptions[0]?.textContent?.match(/^DeepSeek$/),name+' change must not expose prior provider session display.');
  assert.equal(changed.fields.get('ai-login-model').options.length,0,name+' change must drop prior session model choices.');
  if(['account','API'].includes(name))assert.equal(changed.fields.get('ai-paid-credits').textContent,'— TP');
  assert.equal(changed.fields.get('ai-login-model').disabled,true);
  checks.push(name+' change invalidates the affected snapshot before current verification');
 }finally{changed.close();}
}
releases=[];
const switched=await popupEntryFixture({local:structuredClone(savedLocal),session:structuredClone(savedSession),fetchReply,now:()=>clock});await switched.settle(100);releases.shift()();await switched.settle(100);const oldReply=releases.shift();
switched.writeLocal({paidSessionToken:'synthetic-other'});await switched.settle(100);
assert.equal(switched.fields.get('ai-paid-credits').textContent,'— TP');assert.equal(switched.fields.get('ai-login-model').options.length,0);oldReply();await switched.settle(100);assert.equal(switched.fields.get('ai-paid-credits').textContent,'— TP');switched.close();checks.push('Account switch during held account request clears old data and ignores its late reply');
releases=[];accountStatus=401;
const expired=await popupEntryFixture({local:structuredClone(savedLocal),session:structuredClone(savedSession),fetchReply,now:()=>clock});await expired.settle(100);assert.equal(expired.fields.get('ai-paid-credits').textContent,'1,250 TP');releases.shift()();await expired.settle(100);releases.shift()();await expired.settle(100);
assert.equal(expired.local.paidSessionToken,'');assert.equal(expired.fields.get('ai-paid-credits').textContent,'— TP');assert.equal(expired.fields.get('ai-login-model').options.length,0);assert.match(expired.fields.get('ai-paid-status').textContent,/expired/i);expired.close();checks.push('Fresh server401 overrides stale display and clears session/account/Login state');
accountStatus=200;releases=[];
const cold=await popupEntryFixture({local:{...structuredClone(savedLocal),paidAccountViewCacheV1:null},session:{...structuredClone(savedSession),loginProviderViewCacheV1:null},fetchReply,now:()=>clock});await cold.settle(100);assert.equal(cold.fields.get('ai-paid-credits').textContent,'— TP');assert.equal(cold.fields.get('ai-login-model').disabled,true);cold.close();checks.push('First open without a snapshot shows honest unknown data and remains unverified');
console.log(JSON.stringify({passed:true,scope:'Unmodified production popup.js boot and imported controller graph; DOM state and synthetic HTTP responses, no browser pixels or live accounts',moduleCount:reopened.modules.size,count:checks.length,checks}));
