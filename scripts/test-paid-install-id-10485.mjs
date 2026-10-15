// One random install id per browser profile, migrated from older device ids,
// sent as X-TP-Install on Paid and support requests; refund chat lines render.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installId, installHeaders, legacyInstallId, INSTALL_KEY, INSTALL_HEADER} from '../src/paid/install-id.js';
import {createAccountClient} from '../src/paid/client.js';
import {createSupportClient} from '../src/support/client.js';
import {supportEventText, supportEventParts} from '../src/support/events.js';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const checks=[];
const test=async(name,fn)=>{await fn();checks.push(name);};
const store=(values={})=>{const saved={...values},writes=[];
  return {saved,writes,read:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in saved).map(k=>[k,saved[k]])),
    write:async patch=>{writes.push(patch);Object.assign(saved,patch);}};};
const HEX=/^[a-f0-9]{32}$/;

await test('A new browser gets one random 128-bit id, created once',async()=>{
  const s=store();
  const [a,b]=await Promise.all([installId(s),installId(s)]);
  assert.match(a,HEX);assert.equal(a,b);assert.equal(s.saved[INSTALL_KEY],a);assert.equal(s.writes.length,1);
  assert.equal(await installId(s),a);
  const other=store();assert.notEqual(await installId(other),a,'ids are random, not derived from the browser');
});
await test('Existing users keep their first popup id (paidDeviceIds)',async()=>{
  const s=store({paidDeviceIds:[{apiBase:'https://a.example',id:'ab'.repeat(16)},{apiBase:'https://b.example',id:'cd'.repeat(16)}],
    paidDeviceId:'11111111-2222-3333-4444-555555555555'});
  assert.equal(await installId(s),'ab'.repeat(16));assert.equal(s.saved[INSTALL_KEY],'ab'.repeat(16));
  assert.deepEqual(s.saved.paidDeviceIds.length,2,'old keys are kept');
});
await test('Support chat id (paidDeviceId uuid) is reused when no popup id exists',async()=>{
  const s=store({paidDeviceId:'0123ABCD-4567-89ab-cdef-0123456789ab'});
  assert.equal(await installId(s),'0123abcd456789abcdef0123456789ab');
  assert.equal(legacyInstallId({paidDeviceIds:[{id:'bad'}],paidDeviceId:'nope'}),'');
});
await test('A saved install id wins over legacy values',async()=>{
  const s=store({[INSTALL_KEY]:'ef'.repeat(16),paidDeviceIds:[{apiBase:'https://a.example',id:'ab'.repeat(16)}]});
  assert.equal(await installId(s),'ef'.repeat(16));assert.equal(s.writes.length,0);
  assert.deepEqual(await installHeaders(s),{[INSTALL_HEADER]:'ef'.repeat(16)});
});
await test('Storage failure sends no header instead of blocking the request',async()=>{
  const broken={read:async()=>{throw new Error('storage unavailable');},write:async()=>{}};
  assert.deepEqual(await installHeaders(broken),{});
});
await test('Account requests (me, orders, add-on orders, refunds) carry X-TP-Install',async()=>{
  const s=store({customApiUrl:'http://localhost:7860',paidApiBase:'http://localhost:7860',paidSessionToken:'customer-test-session',[INSTALL_KEY]:'12'.repeat(16)});
  const calls=[];
  const client=createAccountClient({read:s.read,write:s.write,fetchFn:async(url,options)=>{calls.push([url,options]);return new Response('{"ok":true}',{status:200});}});
  for(const [path,body] of [['/paid/account',null],['/paid/orders',{package_id:'pkg_1'}],['/paid/addon-orders',{code:'ai_login'}],['/paid/refunds',{payment_id:'pay_1'}]])
    await client.request(path,{body});
  assert.equal(calls.length,4);
  for(const [,options] of calls)assert.equal(options.headers[INSTALL_HEADER],'12'.repeat(16));
});
await test('Support and sign-in requests carry X-TP-Install',async()=>{
  const s=store({customApiUrl:'http://localhost:7860',paidApiBase:'http://localhost:7860',paidSessionToken:'t'.repeat(48),[INSTALL_KEY]:'34'.repeat(16)});
  const calls=[];
  const client=createSupportClient({read:s.read,write:s.write,fetchFn:async(url,options)=>{calls.push([url,options]);return new Response('{"ok":true}',{status:200});}});
  await client.request('/paid/auth/request',{auth:false,body:{email:'a@example.com'}});
  await client.request('/paid/support/messages',{body:{command_id:'c'.repeat(16),text:'hi'}});
  for(const [,options] of calls)assert.equal(options.headers[INSTALL_HEADER],'34'.repeat(16));
  assert.equal(calls[0][1].headers.Authorization,undefined);
});
await test('Refund and hold lines render; unknown events are not "Chat reopened"',()=>{
  assert.equal(supportEventText({event:'refund_admin',event_data:{package_name:'Starter',amount_satang:2900,kind:'pack_full'}}),
    'Refund: Starter · ฿29.00 · full pack price · by support');
  assert.equal(supportEventText({event:'refund_customer',event_data:{package_name:'Starter',amount_satang:1740,kind:'unused',estimated:true}}),
    'Refund: Starter · ฿17.40 (estimated) · unused credits · by you');
  assert.equal(supportEventText({event:'refund_block',event_data:{scopes:['paid','purchases']}}),'On hold after refund until support reviews it: TP use, purchases');
  assert.equal(supportEventParts({event:'linked_block',event_data:{scopes:['login_chat']}}).detail,'AI Login');
  assert.equal(supportEventText({event:'closed_idle'}),'Chat ended automatically');
  assert.equal(supportEventText({event:'reopened_customer'}),'Chat reopened');
  assert.equal(supportEventText({event:'something_new'}),'Conversation update');
});
console.log(JSON.stringify({suite:'paid-install-id-10485',passed:checks.length,checks}));
