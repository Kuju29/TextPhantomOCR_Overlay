import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createAccountClient,safeAccountBase,configuredAccountBase} from '../src/paid/client.js';
import {userMessageForCode} from '../src/shared/error-contract.js';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const checks=[];
const test=async(name,fn)=>{await fn();checks.push({name,passed:true});};
let saved={customApiUrl:'http://localhost:7860',paidApiBase:'http://localhost:7860',paidSessionToken:'customer-test-session'};
let calls=[],next=()=>new Response(JSON.stringify({ok:true,id:'ord_'+'a'.repeat(32)}),{status:200});
const client=createAccountClient({read:async()=>({...saved}),write:async p=>Object.assign(saved,p),fetchFn:async(url,options)=>{calls.push([url,options]);return next();}});
await test('Only secure or loopback saved API targets accepted',()=>{
 for(const u of ['http://evil.example','https://user:pass@api.example','https://api.example?token=x','https://api.example#secret','javascript:alert(1)'])assert.equal(safeAccountBase(u),'');
 assert.equal(safeAccountBase('http://127.0.0.1:7860/'),'http://localhost:7860');
});
await test('Customer token is sent in Authorization only to saved matching API',async()=>{
 await client.request('/paid/account');const [url,opt]=calls.at(-1);assert.equal(url,'http://localhost:7860/paid/account');
 assert.equal(opt.headers.Authorization,'Bearer customer-test-session');assert.equal(opt.redirect,'error');assert.equal(opt.credentials,'omit');assert.equal(opt.cache,'no-store');assert(!url.includes(saved.paidSessionToken));
});
await test('Managed default supports account requests without a custom override',async()=>{
 const old={...saved};
 try {
  saved={...saved,customApiUrl:'',apiUrlDefault:saved.paidApiBase};
  await client.request('/paid/account');
  assert.equal(calls.at(-1)[0],saved.paidApiBase+'/paid/account');
  assert.equal(calls.at(-1)[1].headers.Authorization,'Bearer '+saved.paidSessionToken);
  assert.equal(configuredAccountBase({...saved,customApiUrl:'https://own.example'}),'https://own.example');
 } finally {saved=old;}
});
await test('Changed managed default rejects the previous session before dispatch',async()=>{
 const old={...saved},n=calls.length;
 try {
  saved={...saved,customApiUrl:'',apiUrlDefault:'https://new-service.example'};
  await assert.rejects(()=>client.request('/paid/account'),{code:'SESSION_SCOPE_MISMATCH'});
  assert.equal(calls.length,n);
 } finally {saved=old;}
});
await test('An invalid explicit override cannot fall back to the managed default',async()=>{
 const old={...saved},n=calls.length;
 try {
  saved={...saved,customApiUrl:'http://unsafe.example',apiUrlDefault:saved.paidApiBase};
  await assert.rejects(()=>client.request('/paid/account'),{code:'SESSION_SCOPE_MISMATCH'});
  assert.equal(calls.length,n);
 } finally {saved=old;}
});
await test('Managed default changed during a request discards the old response',async()=>{
 const old={...saved},oldNext=next;
 try {
  saved={...saved,customApiUrl:'',apiUrlDefault:saved.paidApiBase};
  next=()=>{saved.apiUrlDefault='https://new-service.example';return new Response('{"email":"old@example.com"}',{status:200});};
  await assert.rejects(()=>client.request('/paid/account'),{code:'SESSION_SCOPE_MISMATCH'});
 } finally {saved=old;next=oldNext;}
});
await test('Activity filter is accepted without widening customer paths',async()=>{
 await client.request('/paid/history?kind=ledger&offset=25&limit=25&ledger_filter=admin');
 assert(calls.at(-1)[0].endsWith('kind=ledger&offset=25&limit=25&ledger_filter=admin'));
 for(const path of ['/paid/history?kind=ledger&offset=0&limit=25&ledger_filter=private','/paid/history?kind=ledger&offset=0&limit=25&user_id=other'])await assert.rejects(()=>client.request(path),{code:'INVALID_ACCOUNT_PATH'});
});
await test('Changed API never receives old session token',async()=>{
 const n=calls.length;saved.customApiUrl='https://other.example';await assert.rejects(()=>client.request('/paid/account'),{code:'SESSION_SCOPE_MISMATCH'});assert.equal(calls.length,n);saved.customApiUrl=saved.paidApiBase;
});
await test('Response from old account is discarded after session switch',async()=>{
 next=()=>{saved.paidSessionToken='new-customer-session';return new Response(JSON.stringify({email:'old@example.com'}),{status:200});};
 await assert.rejects(()=>client.request('/paid/account'),{code:'STALE_ACCOUNT_RESPONSE'});
});
await test('Only explicit customer routes can be invoked',async()=>{
 const n=calls.length;for(const path of ['/api/admin/users','/paid/orders/../../admin','//evil.example/paid/account','/paid/orders/ord_'+'a'.repeat(32)+'/confirm','/paid/history?kind=orders&user_id=other'])
  await assert.rejects(()=>client.request(path),{code:'INVALID_ACCOUNT_PATH'});
 assert.equal(calls.length,n);
});
await test('Creating and submitting an order are explicit POST requests',async()=>{
 next=()=>new Response(JSON.stringify({id:'ord_'+'b'.repeat(32),status:'waiting'}),{status:200});
 await client.request('/paid/orders',{body:{request_key:'req-test-12345678',package_id:'pkg_test',package_version:1}});
 assert.equal(calls.at(-1)[1].method,'POST');assert(!calls.at(-1)[1].body.includes(saved.paidSessionToken));
 await client.request('/paid/orders/ord_'+'b'.repeat(32)+'/action',{body:{action:'submit'}});assert.equal(calls.at(-1)[1].body,'{"action":"submit"}');
});
await test('Errors preserve code and correlation without auto retry',async()=>{
 const n=calls.length;next=()=>new Response(JSON.stringify({error:{code:'PURCHASE_UNAVAILABLE',message:'Purchase is disabled',request_id:'ref-103'}}),{status:409});
 await assert.rejects(()=>client.request('/paid/orders',{body:{}}),e=>e.code==='PURCHASE_UNAVAILABLE'&&e.reference==='ref-103');assert.equal(calls.length,n+1);
});
await test('Logout does not clear a different session changed in flight',async()=>{
 next=()=>{saved.paidSessionToken='replacement-customer-session';return new Response('{"ok":true}',{status:200});};
 await assert.rejects(()=>client.logout());assert.equal(saved.paidSessionToken,'replacement-customer-session');
});
await test('Current account 401 invokes scoped expiry once and never retries',async()=>{
 const expired=[];const current={...saved};
 const scoped=createAccountClient({read:async()=>({...current}),fetchFn:async()=>new Response('{"error":{"code":"AUTH_REQUIRED","message":"Sign in"}}',{status:401}),onSessionExpired:(id,error)=>expired.push({id,status:error.status})});
 await assert.rejects(()=>scoped.request('/paid/account'),e=>e.status===401);
 assert.equal(expired.length,1);assert.equal(expired[0].id.token,current.paidSessionToken);assert.equal(expired[0].status,401);
});
await test('An old account 401 cannot expire a newly signed-in account',async()=>{
 const expired=[];const current={...saved};
 const scoped=createAccountClient({read:async()=>({...current}),fetchFn:async()=>{current.paidSessionToken='new-session-after-dispatch';return new Response('{"error":{"code":"AUTH_REQUIRED"}}',{status:401});},onSessionExpired:id=>expired.push(id)});
 await assert.rejects(()=>scoped.request('/paid/account'),{code:'STALE_ACCOUNT_RESPONSE'});assert.equal(expired.length,0);
});
await test('403 capacity or permission refusal does not sign the customer out',async()=>{
 let expired=0;
 const scoped=createAccountClient({read:async()=>({...saved}),fetchFn:async()=>new Response('{"error":{"code":"FORBIDDEN"}}',{status:403}),onSessionExpired:()=>expired++});
 await assert.rejects(()=>scoped.request('/paid/account'),e=>e.status===403);assert.equal(expired,0);
});
await test('Paid 404 and provider funds are not blamed on customer key or TP',()=>{
 const route=userMessageForCode('paid_provider_route'),balance=userMessageForCode('paid_provider_balance');
 assert(route.includes('โมเดล Paid') && route.includes('รหัสอ้างอิง'));
 assert(!/Control Center|OpenRouter|เส้นทาง|ตรวจ AI key/.test(route));
 assert(balance.includes('ยอดเครดิตของคุณไม่ได้เป็นสาเหตุ'));
});
await test('Popup exposes inline buy and details without opening browser tabs',async()=>{
 const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');assert(html.includes('id="ai-paid-buy"'));assert(html.includes('id="ai-paid-details"'));
 const source=await readFile(new URL('../src/popup/controllers/paid-service-controller.js',import.meta.url),'utf8');assert(source.includes('inlineAccount?.open(tab)'));assert(!source.includes('createTab('));assert(!source.includes('token=" + token'));
});
console.log(JSON.stringify({scope:'Isolated Node account client, stub fetch/storage. No live credentials or charges.',checks,total:checks.length,passed:true},null,2));
