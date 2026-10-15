/** Actual production popup; fictional HTTP/storage, no live accounts or pixels. */
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';

const base='http://localhost:7860',provider='login_deepseek',model='deepseek-chat';
const auth={id:'lgs_'+'a'.repeat(48),account_id:'b'.repeat(32),provider,transport:'web_endpoint'};
const account={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:'tp-model',name:'Saved TP model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'2',output_tp:'6'}}],addons:{entitlements:[{code:'ai_login',status:'active'}]}};
// Native WebCrypto uses a worker pool. Keep this HTTP/DOM fixture deterministic
// while still hashing exactly the production bytes with SHA256.
const cryptoProvider={
  subtle:{digest:async(name,bytes)=>{assert.equal(name,'SHA-256');const value=createHash('sha256').update(Buffer.from(bytes)).digest();return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);}},
  getRandomValues:value=>webcrypto.getRandomValues(value),randomUUID:()=>webcrypto.randomUUID(),
};
const field=(page,id)=>page.fields.get(id),checks=[];
async function until(page,predicate,label){
  for(let turn=0;turn<800;turn++){if(predicate())return;await page.settle(1);}
  assert.fail(label+' did not complete: '+JSON.stringify({calls:page.calls.map(x=>x.url),status:field(page,'ai-login-status').textContent,errors:page.errors}));
}
function fixture(){
  const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-owner',paidApiBase:base,paidServiceApiBase:base,paidModel:'tp-model',loginProvider:provider,loginModel:model};
  const session={};let phase='healthy',modelName='Saved DeepSeek model',released=null;
  const reply=(value,status=200)=>Response.json(value,{status});
  const fetchReply=(url,options={})=>{
    assert.equal(new URL(url).origin,base,'No live service may be contacted');
    const path=new URL(url).pathname;
    if(path==='/meta')return reply({ok:true,paid:{configured:true}});
    if(path==='/paid/me'){
      if(phase==='held'&&local.paidSessionToken==='replacement-owner')return new Promise(()=>{});
      return phase==='revoked'?reply({error:{message:'Synthetic expired account'}},401):reply(account);
    }
    if(path==='/login/providers'){
      if(phase==='providers-failure')return reply({error:{message:'Synthetic temporary provider failure'}},503);
      const result={providers:[{id:provider,name:'DeepSeek',available:true,supported:true,translation_supported:true,session:phase==='absent-provider'?null:auth}]};
      if(phase==='held')return new Promise((resolve,reject)=>{
        released=()=>resolve(reply(result));
        options.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('Aborted'),{name:'AbortError'})));
      });
      return reply(result);
    }
    if(path==='/login/providers/'+provider+'/models')return phase==='models-failure'?reply({models:{}}):reply({models:[{id:model,name:modelName}]});
    return reply({});
  };
  return {local,session,set phase(value){phase=value;},set modelName(value){modelName=value;},get release(){return released;},
    async boot(){return popupEntryFixture({local,session,fetchReply,cryptoProvider,manualTimers:true});},
    async seed(){const page=await this.boot();await until(page,()=>field(page,'ai-login-model').disabled===false&&Boolean(local.loginProviderDisplayCacheV1),'Fresh account/provider/model and saved display');assert.equal(page.errors.length,0);return page;},
  };
}

for(const phase of ['providers-failure','models-failure']){
  const state=fixture();const initial=await state.seed();
  try{
    const saved=JSON.stringify(state.local.loginProviderDisplayCacheV1);
    const savedSession=JSON.stringify(state.session.loginProviderViewCacheV1);
    state.phase=phase;field(initial,'ai-login-refresh').click();
    await until(initial,()=>field(initial,'ai-login-refresh').disabled===false&&/Synthetic temporary|invalid/i.test(field(initial,'ai-login-status').textContent),'Failed explicit refresh');
    assert.equal(field(initial,'ai-login-model').selectedOptions[0]?.textContent,'Saved DeepSeek model');
    assert.equal(field(initial,'ai-login-model').disabled,true);
    assert.equal(JSON.stringify(state.local.loginProviderDisplayCacheV1),saved,'A failed explicit refresh must preserve the last safe persistent display');
    assert.equal(JSON.stringify(state.session.loginProviderViewCacheV1),savedSession,'A failed explicit refresh must preserve the last same-owner RAM display');
  }finally{initial.close();}
  state.phase='held';state.modelName='Fresh DeepSeek model';const reopened=await state.boot();
  try{
    await until(reopened,()=>Boolean(state.release),'Reopened fresh provider request');
    assert.equal(field(reopened,'ai-paid-credits').textContent,'1,250 TP');
    assert.equal(field(reopened,'ai-login-model').selectedOptions[0]?.textContent,'Saved DeepSeek model','Last-success model must remain visible while the new reply is pending');
    // .72 owner rule: the remembered list is selectable while the fresh reply is pending
    // (no failure reported); translation readiness still waits for the server.
    assert.equal(field(reopened,'ai-login-model').disabled,false,'Remembered Login model list is selectable at reopen');
    state.phase='healthy';state.release();
    await until(reopened,()=>field(reopened,'ai-login-model').disabled===false&&field(reopened,'ai-login-model').selectedOptions[0]?.textContent==='Fresh DeepSeek model'&&JSON.stringify(state.local.loginProviderDisplayCacheV1).includes('Fresh DeepSeek model'),'Fresh model replacement');
    assert.equal(reopened.errors.length,0);
    checks.push(phase+': refresh failure → close → cached reopen → fresh replacement');
  }finally{reopened.close();}
}

{
  const state=fixture();const seed=await state.seed();seed.close();state.phase='absent-provider';const page=await state.boot();
  try{
    await until(page,()=>page.calls.some(x=>x.url.endsWith('/login/providers'))&&field(page,'ai-login-connect').disabled===false&&field(page,'ai-login-account').textContent==='Use your own AI account','Fresh absent provider response');
    assert.equal(field(page,'ai-login-model').options.length,0);assert.equal(field(page,'ai-login-model').disabled,true);
    assert(!JSON.stringify(state.local.loginProviderDisplayCacheV1).includes('Saved DeepSeek model'));
    checks.push('Fresh absent provider replaces cached signed-in presentation');
  }finally{page.close();}
}
{
  const state=fixture();const seed=await state.seed();seed.close();state.phase='revoked';const page=await state.boot();
  try{
    await until(page,()=>state.local.paidSessionToken===''&&state.local.loginProviderDisplayCacheV1===null,'Fresh401 invalidation');
    assert.equal(field(page,'ai-paid-credits').textContent,'— TP');assert.equal(field(page,'ai-login-model').options.length,0);
    assert.equal(state.session.loginProviderViewCacheV1,null);checks.push('Fresh account401 still invalidates cached display and handles');
  }finally{page.close();}
}
{
  const state=fixture();const seed=await state.seed();seed.close();state.phase='held';const page=await state.boot();
  try{
    await until(page,()=>Boolean(state.release),'Old-owner provider request');const oldReply=state.release;
    page.writeLocal({paidSessionToken:'replacement-owner'});
    await until(page,()=>state.local.loginProviderDisplayCacheV1===null&&page.calls.filter(x=>x.url.endsWith('/paid/me')).length>=2,'Replacement owner boot');
    assert.equal(field(page,'ai-paid-credits').textContent,'— TP','Owner replacement must drop the old balance before the new account reply');
    assert.equal(field(page,'ai-login-model').options.length,0,'Owner replacement must drop old Login models before the new account reply');
    oldReply();
    await page.settle(50);
    assert.equal(field(page,'ai-login-model').options.length,0);assert.equal(field(page,'ai-login-model').disabled,true);
    checks.push('Owner replacement rejects a late old-owner provider reply');
  }finally{page.close();}
}
console.log(JSON.stringify({passed:true,count:checks.length,checks,scope:'Production popup.js/controller import graph; fictional storage, HTTP and deterministic digest; completed-state waits, no native pixels, live accounts or payments'}));
