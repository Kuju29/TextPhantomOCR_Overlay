import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
const base='http://localhost:7860',model='owner/model',response=value=>Response.json(value),checks=[],failures=[];
async function check(name,run){try{await run();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
const localFor=mode=>({mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:mode,paidTranslationSource:'tp',paidSessionToken:'synthetic-customer',paidApiBase:base,paidServiceApiBase:base,paidModel:'tp-model',aiProvider:'openrouter',aiModel:model,aiKey:'synthetic-key'});
// .90 owner: no periodic polling and no fixed-time staleness. A visible popup
// re-reads only on use/changes (open, model change, usage ledger, X-TP-Changes
// account/prices token, return to view); nothing runs while hidden or closed.
const changeToken=(seq,changed)=>({tpChangeTokensV1:{scope:'f'.repeat(32),tokens:{b:'aaaaaa',account:'bbbbb'+seq,prices:'ccccc'+seq},changed,seq,at:Date.now()}});
await check('Visible Paid popup re-reads current prices only on change/usage/return signals (.90, no 10-minute timer) and stops while hidden/closed',async()=>{
 let clock=Date.now(),input='2',finish,hold=false;
 const popup=await popupEntryFixture({local:localFor('paid'),now:()=>clock,manualTimers:true,fetchReply:async(url)=>{
  const account={email:'fixture@example.test',credits:{available:'1250',held:'0'},models:[{id:'tp-model',name:'Selected TP model',eligible_tp:'1250',pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:input,output_tp:'6'},price_sync:{automatic:true,status:'current',checked_at:Math.floor(clock/1000)}}],addons:{entitlements:[]}};
  if(url.endsWith('/paid/me')&&hold)return new Promise(resolve=>finish=()=>resolve(response(account)));
  return response(url.endsWith('/paid/me')?account:url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.includes('/login/providers')?{providers:[]}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model],model_candidates:[{id:model,eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model,status:'passed'}:{});
 }});
 const reads=()=>popup.calls.filter(call=>call.url.endsWith('/paid/me')).length;
 try{
  await popup.settle(150);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
  const count=reads();input='4';clock+=601000;popup.runDueTimers();await popup.settle(150);
  assert.equal(reads(),count,'An idle visible popup must not re-read prices on a fixed timer.');assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');
  hold=true;const since=popup.paints.length;popup.writeLocal(changeToken(1,['prices']));await popup.settle(150);
  assert.equal(reads(),count+1,'A moved prices change token must re-read the account at once.');
  assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 2 TP');assert.equal(typeof finish,'function');finish();await popup.settle(150);assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 4 TP');
  assert(!popup.paints.slice(since).some(row=>['ai-paid-model-input','ai-paid-account-state'].includes(row.id)&&/Checking|Loading|Reconnecting|^—/.test(row.text)));
  hold=false;input='5';clock+=61000;popup.writeLocal({aiUsageV1:{models:{},touched:clock}});await popup.settle(100);
  assert.equal(reads(),count+1,'A usage ledger change is debounced, not read immediately.');
  clock+=5000;popup.runDueTimers();await popup.settle(150);assert.equal(reads(),count+2,'A finished Paid translation re-reads the balance once it settles.');assert.equal(popup.fields.get('ai-paid-model-input').textContent,'≈ 5 TP');
  popup.setVisibility('hidden');const hidden=popup.calls.length;clock+=601000;popup.runDueTimers();await popup.settle(150);assert.equal(popup.calls.length,hidden,'Hidden popup must not poll.');
  // Signals while hidden do not re-read the account (a usage write may still read the daily FX rate).
  popup.writeLocal(changeToken(2,['account','prices']));popup.writeLocal({aiUsageV1:{models:{},touched:clock}});
  clock+=6000;popup.runDueTimers();await popup.settle(150);assert.equal(reads(),count+2,'Hidden popup must not re-read the account on signals.');
  popup.setVisibility('visible');await popup.settle(150);assert.equal(reads(),count+3,'Returning to view re-reads once.');
  clock+=601000;popup.runDueTimers();await popup.settle(150);assert.equal(reads(),count+3,'No timer resumes after returning to view.');
  popup.close();const closed=popup.calls.length;clock+=601000;popup.writeLocal(changeToken(3,['prices']));popup.runDueTimers();await popup.settle(150);assert.equal(popup.calls.length,closed,'Closed popup must not re-read prices.');
 }finally{popup.close();}
});
await check('Visible Manual OpenRouter rates refresh on dialog open/model change (.90, no 60 s timer), preserve edits and stop while hidden/closed',async()=>{
 let clock=Date.now(),prompt='0.0000003',finish,hold=false;
 const popup=await popupEntryFixture({local:localFor('manual'),now:()=>clock,manualTimers:true,fetchReply:async(url)=>{
  const data={data:[{id:model,pricing:{prompt,completion:'0.0000012',input_cache_read:'0.000000006'}}]};
  if(url==='https://openrouter.ai/api/v1/models')return hold?new Promise(resolve=>finish=()=>resolve(response(data))):response(data);
  return response(url.includes('frankfurter')?{base:'USD',date:'2026-10-08',rates:{THB:35}}:url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.includes('/ai/resolve')?{provider:'openrouter',backend_supported:true,key_status:'valid',models_verified:true,models:[model],model_candidates:[{id:model,eligibility:'usable'}]}:url.includes('/ai/probe')?{provider:'openrouter',model,status:'passed'}:{});
 }});
 const count=()=>popup.calls.filter(call=>call.url==='https://openrouter.ai/api/v1/models').length;
 const modelChange=()=>popup.fields.get('ai-model').dispatchEvent({type:'change'});
 try{
  await popup.settle(150);popup.fields.get('ai-usage-detailed').click();await popup.settle(150);assert.equal(popup.fields.get('ai-price-input').value,'0.3');
  const initial=count();prompt='0.0000004';hold=true;clock+=61000;popup.runDueTimers();await popup.settle(150);
  assert.equal(count(),initial,'An open Manual rates dialog must not poll the catalogue on a fixed timer.');
  popup.fields.get('ai-usage-detailed').click();await popup.settle(150);
  assert.equal(count(),initial+1,'Opening the rates dialog re-reads a catalogue price older than one minute.');assert.equal(popup.fields.get('ai-price-input').value,'0.3');finish();await popup.settle(150);assert.equal(popup.fields.get('ai-price-input').value,'0.4');
  popup.fields.get('ai-price-input').value='9';prompt='0.0000005';clock+=61000;modelChange();await popup.settle(150);assert.equal(count(),initial+2,'A model change re-reads the catalogue price.');finish();await popup.settle(150);assert.equal(popup.fields.get('ai-price-input').value,'9','A quiet refresh cannot overwrite the current edit.');
  hold=false;popup.setVisibility('hidden');const hidden=count();clock+=61000;modelChange();popup.runDueTimers();await popup.settle(150);assert.equal(count(),hidden,'Hidden popup must not read the catalogue.');
  popup.setVisibility('visible');clock+=61000;popup.runDueTimers();await popup.settle(150);assert.equal(count(),hidden,'Returning to view starts no timer.');
  modelChange();await popup.settle(150);assert.equal(count(),hidden+1);
  popup.close();const closed=count();clock+=61000;modelChange();popup.runDueTimers();await popup.settle(150);assert.equal(count(),closed,'Closed popup must not read the catalogue.');
 }finally{popup.close();}
});
console.log(JSON.stringify({passed:failures.length===0,count:checks.length,checks,failures,scope:'Unmodified production popup entry and controllers; virtual clock advances the real scheduled callbacks, synthetic HTTP only; no browser pixels or actual charge'}));
if(failures.length)process.exitCode=1;
