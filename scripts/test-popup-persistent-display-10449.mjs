import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {createPaidViewCache,accountViewScope} from '../src/paid/view-cache.js';
const base='http://localhost:7860',provider='login_deepseek',model='deepseek-chat';
const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-owner',paidApiBase:base,paidServiceApiBase:base,paidModel:'tp-model',loginProvider:provider,loginModel:model,aiProvider:'openrouter',aiModel:'fixture-model',aiKey:'synthetic-key',tpDataConsentV1:{version:1,granted:true,at:1}}; // 10495: this user allowed account data
const session={},auth={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider,transport:'web_endpoint'};
const account={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:'tp-model',name:'Saved TP model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6'}}],addons:{entitlements:[{code:'ai_login',status:'active'}]}};
let clock=Date.now(),held=false,providerSession=auth,status=200,releases=[];
const reply=(value,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'Content-Type':'application/json'}});
const fetchReply=(url,opts)=>{
 const value=url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.endsWith('/paid/me')?account:url.endsWith('/login/providers')?{providers:[{id:provider,name:'DeepSeek',available:true,supported:true,translation_supported:true,session:providerSession}]}:url.includes('/login/providers/')?{models:[{id:model,name:'Saved DeepSeek model'}]}:{};
 if(held&&(url.endsWith('/meta')||url.includes('/paid/')||url.includes('/login/')))return new Promise((resolve,reject)=>{releases.push(Object.assign(()=>resolve(reply(value,url.endsWith('/paid/me')?status:200)),{url}));opts.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})));});
 return Promise.resolve(reply(value,url.endsWith('/paid/me')?status:200));
};
const checks=[];
// Release one held request by its path (the popup also reads Account details ahead, .72).
const release=path=>{const index=releases.findIndex(fn=>new URL(fn.url).pathname===path);assert(index>=0,'held '+path+' in '+releases.map(fn=>fn.url).join(' '));releases.splice(index,1)[0]();};
const first=await popupEntryFixture({local,session,fetchReply,now:()=>clock});await first.settle(100);
assert.equal(first.errors.length,0,first.errors.join('\n'));assert.equal(first.fields.get('ai-login-model').value,model);assert.equal(first.fields.get('ai-login-model').disabled,false);first.close();
// Browser storage.session disappears on a normal browser restart. Only harmless
// presentation is allowed to survive it; opaque provider session handles are not.
clock+=30*24*60*60*1000;held=true;
const saved=structuredClone(local);
const reopened=await popupEntryFixture({local,session:{},fetchReply,now:()=>clock});await reopened.settle(100);
try{
 assert.equal(reopened.errors.length,0,reopened.errors.join('\n'));
 assert.equal(reopened.fields.get('ai-paid-credits').textContent,'1,250 TP');
 assert.equal(reopened.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
 assert.equal(reopened.fields.get('ai-login-provider').selectedOptions[0]?.textContent,'DeepSeek','Last owner-scoped provider display must survive restart without a Checking replacement.');
 assert.equal(reopened.fields.get('ai-login-model').value,model);
 assert.equal(reopened.fields.get('ai-login-model').selectedOptions[0]?.textContent,'Saved DeepSeek model');
 assert.equal(reopened.fields.get('ai-login-account').textContent,'Signed in to your AI account');
 assert.doesNotMatch(reopened.fields.get('ai-login-status').textContent,/Checking|Verifying/i);
 // .72/.73: the remembered Login model is selectable at once while it is re-verified in the background;
 // the translation itself is authorized only by the job's fresh account/session/model check.
 assert.equal(reopened.fields.get('ai-login-model').disabled,false);
 assert.equal(reopened.fields.get('ai-login-connect').disabled,true);
 const cached=JSON.stringify(local.loginProviderDisplayCacheV1);
 assert(cached);assert(!cached.includes('lgs_'));assert(!cached.includes(auth.account_id));assert(!cached.includes('synthetic-owner'));assert(!cached.includes('model_capabilities'));
 checks.push('Actual popup restart after 30 days restores safe provider/model/balance/rates without provider handles or authorization');
 for(let n=0;n<4;n++){assert(releases.length);releases.shift()();await reopened.settle(100);}
 assert.equal(reopened.fields.get('ai-login-model').disabled,false,JSON.stringify({calls:reopened.calls.map(x=>x.url),status:reopened.fields.get('ai-login-status').textContent,errors:reopened.errors}));
 checks.push('Only fresh owned account→provider→model responses authorize the restored source');
}finally{reopened.close();}
for(const [name,patch] of [['account',{paidSessionToken:'other-owner'}],['API',{customApiUrl:'http://localhost:7861'}],['provider',{loginProvider:'login_gemini'}],['model',{loginModel:'different'}]]){
 releases=[];const changed=await popupEntryFixture({local:{...structuredClone(saved),...patch},session:{},fetchReply,now:()=>clock});await changed.settle(100);
 assert.equal(changed.fields.get('ai-login-model').options.length,0,name+' must invalidate prior provider/model display');assert.equal(changed.fields.get('ai-login-model').disabled,true);
 if(['account','API'].includes(name))assert.equal(changed.fields.get('ai-paid-credits').textContent,'— TP');changed.close();checks.push(name+' scope change drops previous presentation');
}
releases=[];
const switched=await popupEntryFixture({local:structuredClone(saved),session:{},fetchReply,now:()=>clock});await switched.settle(100);release('/meta');await switched.settle(100);release('/paid/me');await switched.settle(100);const oldProvider=releases.splice(releases.findIndex(fn=>new URL(fn.url).pathname==='/login/providers'),1)[0];assert(oldProvider&&new URL(oldProvider.url).pathname==='/login/providers');
switched.writeLocal({paidSessionToken:'replacement-owner'});await switched.settle(100);oldProvider();await switched.settle(100);
assert.equal(switched.fields.get('ai-login-model').options.length,0);assert.equal(switched.fields.get('ai-paid-credits').textContent,'— TP');assert.equal(switched.local.loginProviderDisplayCacheV1,null);switched.close();checks.push('Account replacement during provider refresh clears persistent display and rejects its late reply');
releases=[];status=503;
const offline=await popupEntryFixture({local:structuredClone(saved),session:{},fetchReply,now:()=>clock,manualTimers:true});await offline.settle(100);release('/meta');await offline.settle(100);release('/paid/me');await offline.settle(100);
assert.equal(offline.fields.get('ai-paid-credits').textContent,'1,250 TP');assert.equal(offline.fields.get('ai-login-model').value,model);assert.equal(offline.fields.get('ai-login-model').disabled,true);assert.match(offline.fields.get('ai-paid-status').textContent,/last loaded|paused/i);offline.close();status=200;checks.push('A fresh temporary service failure preserves previous display with an honest warning and no usable authority');
releases=[];providerSession=null;
const absent=await popupEntryFixture({local:structuredClone(saved),session:{},fetchReply,now:()=>clock});await absent.settle(100);for(const path of ['/meta','/paid/me','/login/providers']){release(path);await absent.settle(100);}
assert.equal(absent.fields.get('ai-login-model').options.length,0);assert.equal(absent.fields.get('ai-login-account').textContent,'');assert.match(absent.fields.get('ai-login-provider-tip').textContent,/^Use your own AI account/);/* 10496: not signed in → no status line; the explanation is on the Provider name */absent.close();checks.push('Fresh absent provider session replaces saved signed-in presentation');
releases=[];status=401;
const expired=await popupEntryFixture({local:structuredClone(saved),session:{},fetchReply,now:()=>clock});await expired.settle(100);release('/meta');await expired.settle(100);release('/paid/me');await expired.settle(100);
assert.equal(expired.fields.get('ai-paid-credits').textContent,'— TP');assert.equal(expired.fields.get('ai-login-model').options.length,0);assert.equal(expired.local.loginProviderDisplayCacheV1,null);expired.close();checks.push('Current server401 clears all scoped display and session state');
let values={};const scope=await accountViewScope(base,'synthetic-owner');const cache=createPaidViewCache({read:async()=>values,write:async patch=>Object.assign(values,patch),now:()=>clock});
await cache.remember(scope,'account',{...account,packages:[]});clock+=30*24*60*60*1000;
assert.equal((await cache.restore(scope,'account'))?.credits.available,'1250','The standalone Account default restore must not blank solely because time passed.');
assert.equal(await cache.restore(scope,'account',{allowStale:false}),null);checks.push('Standalone Account presentation has no expiry; explicit freshness check remains available');
console.log(JSON.stringify({passed:true,count:checks.length,checks,scope:'Production popup.js and import graph, synthetic HTTP + clock/restart; DOM/control state, no browser pixels, live accounts or purchases'}));
