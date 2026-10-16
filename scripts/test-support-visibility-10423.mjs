import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
globalThis.crypto ??= webcrypto;
const adjacent=fileURLToPath(new URL('..',import.meta.url));
const root=process.env.TP_QA_EXTENSION_ROOT||(existsSync(join(adjacent,'src'))?adjacent:fileURLToPath(new URL('../../source/TextPhantom',import.meta.url)));
const {syncSupportVisibility,activateSupport}=await import(pathToFileURL(join(root,'src/support/visibility.js')));
const {supportScopeId}=await import(pathToFileURL(join(root,'src/support/client.js')));
const select=(store,keys)=>typeof keys==='string'?{[keys]:structuredClone(store[keys])}:Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys)).map(key=>[key,structuredClone(store[key]??(Array.isArray(keys)?undefined:keys[key]))]));
async function fixture(patch={}){
  const saved={tpDataConsentV1:{version:1,granted:true,at:1},paidSessionToken:'a'.repeat(64),paidApiBase:'http://localhost:7860',customApiUrl:'http://localhost:7860',...patch},writes=[];
  globalThis.chrome={runtime:{lastError:null},storage:{local:{get:(keys,cb)=>queueMicrotask(()=>cb(select(saved,keys))),set:(value,cb)=>queueMicrotask(()=>{writes.push(structuredClone(value));Object.assign(saved,structuredClone(value));cb?.();})}}};
  const scope=await supportScopeId({base:saved.customApiUrl,token:saved.paidSessionToken});return {saved,writes,scope};
}
const dto=(patch={})=>({enabled:true,thread:{state:'waiting_customer',unread:2,last_seq:10,last_admin_seq:5,notification_muted:false,closed_seq:0,...patch}});
const results=[];
async function test(name,fn){try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}}
await test('Hide waits for new admin cursor rather than own-message or unread count changes',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:true,supportHideUntil:{scope:h.scope,lastAdminSeq:5}});await syncSupportVisibility(dto({last_seq:99,unread:4}),h.scope);assert.equal(h.saved.supportDockHidden,true);assert.equal(h.saved.supportHideUntil.lastAdminSeq,5);assert.equal(h.saved.supportUnread.unread,4);
});
await test('New admin reply clears temporary Hide without expanding or opening a page',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:true,supportHideUntil:{scope:h.scope,lastAdminSeq:5}});await syncSupportVisibility(dto({last_admin_seq:6}),h.scope);assert.equal(h.saved.supportDockHidden,false);assert.equal(h.saved.supportHideUntil,null);assert.equal(h.saved.supportDockView,undefined);
});
await test('Server close event supplies End suppression even with no previous local storage',async()=>{
  const h=await fixture();await syncSupportVisibility(dto({notification_muted:true,closed_seq:20}),h.scope);assert.equal(h.saved.supportDockHidden,true);assert.deepEqual(h.saved.supportChatMuted,{scope:h.scope});assert.deepEqual(h.saved.supportClosedSeen,{scope:h.scope,seq:20});
});
await test('Replies after ended chat retain server-authoritative suppression',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:true,supportChatMuted:{scope:h.scope},supportClosedSeen:{scope:h.scope,seq:20}});await syncSupportVisibility(dto({notification_muted:true,closed_seq:20,last_admin_seq:23,unread:4}),h.scope);assert.equal(h.saved.supportDockHidden,true);assert.deepEqual(h.saved.supportChatMuted,{scope:h.scope});
});
await test('Already seen close status allows explicit Contact to show readonly history',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:false,supportChatMuted:null,supportClosedSeen:{scope:h.scope,seq:20}});await syncSupportVisibility(dto({notification_muted:true,closed_seq:20}),h.scope);assert.equal(h.saved.supportDockHidden,false);assert.equal(h.saved.supportChatMuted,null);
});
await test('Server reopen clears persisted End suppression from another device',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:true,supportChatMuted:{scope:h.scope},supportClosedSeen:{scope:h.scope,seq:20}});await syncSupportVisibility(dto({closed_seq:20}),h.scope);assert.equal(h.saved.supportDockHidden,false);assert.equal(h.saved.supportChatMuted,null);
});
await test('Legacy hidden state gets current admin cursor baseline without resurfacing old unread',async()=>{
  const h=await fixture({supportDockHidden:true});await syncSupportVisibility(dto({last_admin_seq:15,unread:3}),h.scope);assert.equal(h.saved.supportDockHidden,true);assert.deepEqual(h.saved.supportHideUntil,{scope:h.scope,lastAdminSeq:15});
});
await test('Delayed visibility read cannot clear new-account End flags or write stale unread',async()=>{
  const h=await fixture();Object.assign(h.saved,{supportDockHidden:true,supportChatMuted:{scope:h.scope}});const original=chrome.storage.local.get;let entered,release;const started=new Promise(resolve=>entered=resolve);
  chrome.storage.local.get=(keys,cb)=>{if(keys.includes('supportClosedSeen')){const snapshot=select(h.saved,keys);release=()=>cb(snapshot);entered();}else original(keys,cb);};
  const pending=syncSupportVisibility(dto(),h.scope);await started;h.saved.paidSessionToken='b'.repeat(64);const newScope=await supportScopeId({base:h.saved.customApiUrl,token:h.saved.paidSessionToken});Object.assign(h.saved,{supportDockHidden:true,supportChatMuted:{scope:newScope},supportClosedSeen:{scope:newScope,seq:99}});release();await pending;
  assert.equal(h.writes.length,0);assert.equal(h.saved.supportDockHidden,true);assert.deepEqual(h.saved.supportChatMuted,{scope:newScope});
});
await test('Explicit Contact reopens server-ended case with pinned identity then clears suppression',async()=>{
  const h=await fixture(),identity={base:h.saved.customApiUrl,token:h.saved.paidSessionToken,tokenBase:h.saved.paidApiBase};const requests=[];let closed=true;
  const client={scope:async()=>identity,request:async(path,options)=>{requests.push({path,options});if(path.endsWith('/action')){closed=false;return {ok:true};}return dto({notification_muted:closed,closed_seq:20,last_seq:23});}};
  await activateSupport(client);assert.deepEqual(requests.map(x=>x.path),['/paid/support','/paid/support/action','/paid/support']);assert.equal(requests[1].options.body.action,'reopen');assert.equal(requests[1].options.body.expected_seq,23);assert.deepEqual(requests[1].options.identity,identity);assert.equal(h.saved.supportDockHidden,false);assert.equal(h.saved.supportChatMuted,null);assert.equal(h.saved.supportActivated,true);
});
for (const error of [
  Object.assign(new Error('Sign in first'), { code: 'SIGN_IN_REQUIRED', status: 401 }),
  Object.assign(new Error('Session expired'), { code: 'AUTH_REQUIRED', status: 401 }),
  Object.assign(new Error('Account changed'), { code: 'STALE_SUPPORT_RESPONSE' }),
]) await test('Contact does not activate chat after ' + error.code, async () => {
  const h = await fixture({ supportActivated: false, supportDockHidden: true });
  const before = structuredClone(h.saved);
  const client = {
    scope: async () => ({ base: h.saved.customApiUrl, token: h.saved.paidSessionToken }),
    request: async () => { throw error; },
  };
  await assert.rejects(() => activateSupport(client), { code: error.code });
  assert.deepEqual(h.saved, before);
  assert.equal(h.writes.length, 0);
});
const report={checks:results.length,passed:results.filter(result=>result.passed).length,results};
if(process.env.TP_QA_OUTPUT){mkdirSync(process.env.TP_QA_OUTPUT,{recursive:true});writeFileSync(join(process.env.TP_QA_OUTPUT,'visibility-report-10423.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report,null,2));process.exitCode=results.some(result=>!result.passed)?1:0;
