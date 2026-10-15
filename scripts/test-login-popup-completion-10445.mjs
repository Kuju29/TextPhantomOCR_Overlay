import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {LOGIN_PENDING_AUTH,LOGIN_OUTCOME,loginAuthScope} from '../src/shared/login-auth.js';
import {createHash,webcrypto} from 'node:crypto';

// Real SHA-256 with a microtask completion keeps the facade's event settling
// deterministic instead of racing Node's unrelated crypto worker threads.
const fixtureCrypto={getRandomValues:webcrypto.getRandomValues.bind(webcrypto),randomUUID:webcrypto.randomUUID.bind(webcrypto),
 subtle:new Proxy(webcrypto.subtle,{get(target,key){
  if(key==='digest')return async(algorithm,bytes)=>{
   assert.equal(typeof algorithm==='string'?algorithm:algorithm.name,'SHA-256');
   const digest=createHash('sha256').update(new Uint8Array(bytes)).digest();
   return digest.buffer.slice(digest.byteOffset,digest.byteOffset+digest.byteLength);
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }})};
assert.deepEqual(new Uint8Array(await fixtureCrypto.subtle.digest('SHA-256',new TextEncoder().encode('scope fixture'))),
 new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('scope fixture'))));

const base='http://localhost:7860',provider='login_deepseek',model='deepseek-chat';
const identity={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider,transport:'web_endpoint'};
const flowId='lgf_'+'c'.repeat(48);
const account={email:'fixture@example.test',credits:{available:'1000',held:'0'},models:[{id:'tp-fixture',name:'TP fixture',eligible_tp:'1000',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6'}}],addons:{entitlements:[{code:'ai_login',status:'active'}]}};
const local=()=>({mode:'lens_text',sources:'ai',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-customer',paidApiBase:base,paidServiceApiBase:base,paidModel:'tp-fixture',loginProvider:provider,loginModel:'',aiProvider:'openrouter',aiModel:'fixture-model',aiKey:'synthetic-key'});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const checks=[],failures=[];
async function check(name,fn){try{await fn();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
function environment({providerId=provider}={}){
 const values=local(),session={},runtime=[];
 values.loginProvider=providerId;
 const providerIdentity={...identity,provider:providerId};
 let holdFresh=false,holdAccount=false,clock=Date.now(),remoteSession=null;
 const releases=[],providerReleases=[];
 const fetchReply=(url)=>{
  if(holdFresh&&url.includes('/login/providers')&&!url.includes('/auth/'))return new Promise(resolve=>providerReleases.push(resolve));
  const value=url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.endsWith('/paid/me')?account:url.endsWith('/login/providers')?{providers:[{id:providerId,name:providerId==='login_gemini'?'Gemini':providerId==='login_chatgpt'?'ChatGPT':providerId==='login_claude'?'Claude':'DeepSeek',available:true,supported:true,sign_in_available:true,translation_supported:!['login_claude'].includes(providerId),support_status:['login_claude'].includes(providerId)?'under_improvement':'supported',session:remoteSession}]}:url.includes('/models?')?{models:[{id:model,name:'Fixture provider model'}]}:url.endsWith('/auth/start')?{transport:'web_endpoint',flow_id:flowId,state:'d'.repeat(64),url:providerId==='login_gemini'?'https://gemini.google.com/app':providerId==='login_chatgpt'?'https://chatgpt.com/':providerId==='login_claude'?'https://claude.ai/':'https://chat.deepseek.com/'}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:['fixture-model'],model_candidates:[{id:'fixture-model',eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model:'fixture-model',status:'passed'}:{};
  if(holdAccount&&(url.endsWith('/meta')||url.endsWith('/paid/me')))return new Promise(resolve=>releases.push(()=>resolve(response(value))));
  return response(value);
 };
 const open=()=>popupEntryFixture({local:values,session,fetchReply,now:()=>clock,manualTimers:true,cryptoProvider:fixtureCrypto,runtimeReply:message=>{runtime.push(message.type);return message.type==='TP_LOGIN_ENDPOINT_OPEN'?{ok:true}:null;}});
 const complete=async(popup,{accepted=true,patch={}}={})=>{
  const models=['login_claude'].includes(providerId)?[]:[{id:model,name:'Fixture provider model'}];
  if(accepted){remoteSession=providerIdentity;popup.writeLocal({loginModel:models[0]?.id||''});await popup.settle(15);}
  popup.writeSession({[LOGIN_PENDING_AUTH]:null,loginSessionId:providerIdentity.id,loginAccountId:providerIdentity.account_id,[LOGIN_OUTCOME]:{scope:await loginAuthScope(base,'synthetic-customer'),provider:providerId,flow_id:flowId,status:'connected',expiresAt:clock+60000,endpoint_validation:'identity_verified',generation_validation:'not_tested',session:providerIdentity,models,...patch}});
 };
 return {open,complete,runtime,values,session,releases,providerReleases,hold(){holdFresh=true;},holdAccount(){holdAccount=true;},advance(ms){clock+=ms;}};
}
await check('Normal Sign in receives the actual atomic background completion and updates the open popup without reopening',async()=>{
 const env=environment(),popup=await env.open();
 try{
  await popup.settle(150);assert.equal(popup.errors.length,0,popup.errors.join('\n'));assert.equal(popup.fields.get('ai-login-connect').disabled,false,'Fresh entitled account can start a normal DeepSeek sign-in.');
  popup.fields.get('ai-login-connect').click();await popup.settle(150);
  assert(env.runtime.includes('TP_LOGIN_ENDPOINT_OPEN'));assert.equal(env.session[LOGIN_PENDING_AUTH]?.flow_id,flowId);
  env.hold();await env.complete(popup);await popup.settle(180);
  assert.match(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/,'Actual atomic session-handle and outcome event must not invalidate its own completion.');
  assert.equal(popup.fields.get('ai-login-model').value,model);
  assert.equal(popup.fields.get('ai-login-model').disabled,false,'Atomic connected receipt must finish verification rather than restart a held provider check.');
  assert.doesNotMatch(popup.fields.get('ai-login-status').textContent,/Checking|Verifying|Complete sign-in/i);
 }finally{popup.close();}
});

await check('A flow completed while popup is closed restores its connected display immediately before held account checks',async()=>{
 const env=environment(),first=await env.open();await first.settle(150);first.fields.get('ai-login-connect').click();await first.settle(150);first.close();
 await env.complete(first);env.holdAccount();env.hold();env.advance(61000);
 // Refresh the receipt lifetime without turning it into a new sign-in flow.
 env.session[LOGIN_OUTCOME].expiresAt+=61000;
 const reopened=await env.open();
 try{
  await reopened.settle(180);
  assert.equal(reopened.errors.length,0,reopened.errors.join('\n'));
  assert.match(reopened.fields.get('ai-login-account').textContent,/Signed in|Connected to/,'Closed-popup completion must be projected before fresh held server reads.');
  assert.equal(reopened.fields.get('ai-login-model').value,model);
  assert.equal(reopened.fields.get('ai-login-model').disabled,true,'Restored completion display cannot grant fresh authority.');
  assert.doesNotMatch(reopened.fields.get('ai-login-provider').selectedOptions[0]?.textContent||'',/Checking/);
  assert.doesNotMatch(reopened.fields.get('ai-login-status').textContent,/Checking|Verifying|Complete sign-in/i);
 }finally{reopened.close();}
});

await check('A pending flow survives closing and reopening, then the actual atomic completion updates the reopened popup',async()=>{
 const env=environment(),first=await env.open();await first.settle(150);first.fields.get('ai-login-connect').click();await first.settle(150);first.close();
 const reopened=await env.open();
 try{
  await reopened.settle(180);assert.equal(env.session[LOGIN_PENDING_AUTH]?.flow_id,flowId);
  assert.equal(reopened.fields.get('ai-login-cancel').style.display,'');
  env.hold();await env.complete(reopened);await reopened.settle(180);
  assert.equal(reopened.fields.get('ai-login-model').value,model);
  assert.equal(reopened.fields.get('ai-login-model').disabled,false);
  assert.equal(reopened.fields.get('ai-login-cancel').style.display,'none');
  assert.doesNotMatch(reopened.fields.get('ai-login-status').textContent,/Checking|Verifying|Complete sign-in/i);
 }finally{reopened.close();}
});

await check('Late cancelled, foreign-flow and expired-flow receipts never paint a usable signed-in session',async()=>{
 for(const kind of ['cancelled','foreign','expired']){
  const env=environment(),popup=await env.open();
  try{
   await popup.settle(150);popup.fields.get('ai-login-connect').click();await popup.settle(150);
   if(kind==='cancelled'){popup.fields.get('ai-login-cancel').click();await popup.settle(150);}
   if(kind==='expired')env.advance(300001);
   env.hold();await env.complete(popup,{accepted:false,patch:kind==='foreign'?{flow_id:'lgf_'+'e'.repeat(48)}:{}});await popup.settle(180);
   assert.equal(popup.fields.get('ai-login-model').disabled,true,kind);
   assert.equal(popup.fields.get('ai-login-model').options.length,0,kind+' receipt cannot populate models.');
   assert.doesNotMatch(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/,kind);
  }finally{popup.close();}
 }
});

await check('.75 Claude has no unsupported label and explains its claude.ai tab',async()=>{
 const env=environment({providerId:'login_claude'}),popup=await env.open();
 try{
  await popup.settle(150);
  assert.doesNotMatch(popup.fields.get('ai-login-provider').selectedOptions[0]?.textContent||'',/Not supported yet/);
  assert.match(popup.fields.get('ai-login-support')?.textContent||'',/claude\.ai tab in this browser/);
  assert.equal(popup.fields.get('ai-login-connect').disabled,false);
 }finally{popup.close();}
});

await check('.77 ChatGPT has no unsupported label and says which route it connected through',async()=>{
 for(const [mode,reason,text] of [['official','',/Sign in with ChatGPT\. Translations use your ChatGPT plan/],
   ['website','plan_free',/chatgpt\.com website in this browser\. Keep the browser open/],
   ['website','official_denied',/Sign in with ChatGPT is not available for this account/]]){
  const env=environment({providerId:'login_chatgpt'}),popup=await env.open();
  try{
   await popup.settle(150);
   assert.doesNotMatch(popup.fields.get('ai-login-provider').selectedOptions[0]?.textContent||'',/Not supported yet/);
   assert.doesNotMatch(popup.fields.get('ai-login-support')?.textContent||'',/under improvement/i);
   assert.equal(popup.fields.get('ai-login-connect').disabled,false);
   popup.fields.get('ai-login-connect').click();await popup.settle(150);assert(env.runtime.includes('TP_LOGIN_ENDPOINT_OPEN'));
   env.hold();await env.complete(popup,{patch:{chatgpt_mode:mode,chatgpt_reason:reason}});await popup.settle(180);
   assert.match(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/);
   assert.match(popup.fields.get('ai-login-status').textContent,text,mode+' '+reason);
   assert.equal(popup.fields.get('ai-login-model').disabled,false);
  }finally{popup.close();}
 }
});

await check('Gemini still connects normally without an unsupported label or a reopening requirement',async()=>{
 const env=environment({providerId:'login_gemini'}),popup=await env.open();
 try{
  await popup.settle(150);assert.doesNotMatch(popup.fields.get('ai-login-provider').selectedOptions[0]?.textContent||'',/Not supported yet/);
  popup.fields.get('ai-login-connect').click();await popup.settle(150);env.hold();await env.complete(popup);await popup.settle(180);
  assert.equal(popup.fields.get('ai-login-model').disabled,false);
  assert.match(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/);
 }finally{popup.close();}
});

await check('Unsupported translation uses the existing safe image error contract without hiding sign-in availability',async()=>{
 const {imageErrorMessage}=await import('../src/background/error-message.js');
 for(const code of ['login_translation_unsupported','LOGIN_TRANSLATION_UNSUPPORTED']){
  const result=imageErrorMessage({imgUrl:'https://example.test/image.png'},{code,origin:'api',stage:'ai',httpStatus:409,retryable:false,message:'untrusted upstream body'});
  assert.match(result.error.userMessage,/ยังไม่รองรับการแปล.*ปรับปรุง.*เข้าสู่บัญชีได้/);
  assert.equal(result.error.code,code);
  assert.equal(result.error.retryable,false);
  assert.doesNotMatch(JSON.stringify(result),/untrusted upstream body/);
 }
});

await check('Account, API and provider changes reject a late completion from the previous popup scope',async()=>{
 for(const patch of [{paidSessionToken:'different-customer'},{customApiUrl:'http://localhost:7999',paidApiBase:'http://localhost:7999',paidServiceApiBase:'http://localhost:7999'},{loginProvider:'login_gemini',loginModel:''}]){
  const env=environment(),popup=await env.open();
  try{
   await popup.settle(150);popup.fields.get('ai-login-connect').click();await popup.settle(150);
   env.hold();env.holdAccount();popup.writeLocal(patch);await popup.settle(120);
   await env.complete(popup,{accepted:false});await popup.settle(160);
   assert.equal(popup.fields.get('ai-login-model').disabled,true,JSON.stringify(patch));
   assert.equal(popup.fields.get('ai-login-model').options.length,0,JSON.stringify(patch));
   assert.doesNotMatch(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/,JSON.stringify(patch));
  }finally{popup.close();}
 }
});

await check('Automatic completion supersedes an older provider refresh and its late response cannot clear the connected session',async()=>{
 const env=environment(),first=await env.open();await first.settle(150);first.fields.get('ai-login-connect').click();await first.settle(150);first.close();
 env.hold();const popup=await env.open();
 try{
  await popup.settle(180);assert.ok(env.providerReleases.length,'Reopening entered the actual held provider refresh.');
  await env.complete(popup);await popup.settle(160);
  assert.equal(popup.fields.get('ai-login-model').disabled,false);
  for(const release of env.providerReleases.splice(0))release(response({providers:[]}));
  await popup.settle(180);
  assert.equal(popup.fields.get('ai-login-model').value,model);
  assert.equal(popup.fields.get('ai-login-model').disabled,false,'Older refresh cannot invalidate a newer verified completion.');
  assert.match(popup.fields.get('ai-login-account').textContent,/Signed in|Connected to/);
 }finally{popup.close();}
});

console.log(JSON.stringify({passed:failures.length===0,count:checks.length,checks,failures,scope:'Unmodified production popup entry/import graph and normal Sign in click; synthetic API/runtime/storage boundaries, no live account or generation.'}));
if(failures.length)process.exitCode=1;
