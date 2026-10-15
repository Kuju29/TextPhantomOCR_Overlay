import assert from 'node:assert/strict';
import {createPaymentMonitor,paymentPending} from '../src/paid/payment.js';
import {createAccountClient} from '../src/paid/client.js';
const id='ord_'+'a'.repeat(32),other='ord_'+'b'.repeat(32),checks=[];
const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){
 let next=async()=>({id,status:'waiting'}),visible=true,seq=0;
 const timers=new Map(),delays=[],calls=[],orders=[],errors=[],settled=[];
 const monitor=createPaymentMonitor({request:async path=>{calls.push(path);return next(path);},isVisible:()=>visible,
  schedule:(fn,ms)=>{const key=++seq;timers.set(key,fn);delays.push(ms);return key;},unschedule:key=>timers.delete(key),
  onOrder:order=>orders.push(order),onError:error=>errors.push(error),onSettled:order=>settled.push(order)});
 return {monitor,delays,timers,calls,orders,errors,settled,setNext:fn=>next=fn,setVisible:v=>visible=v,
  async fire(){const [key,fn]=timers.entries().next().value;timers.delete(key);fn();await tick();}};
}
await check('Polling backs off 2 → 5 → 10 → 30 seconds (10490: bounded) and uses authenticated read route',async()=>{
 const h=harness();h.monitor.watch({id,status:'waiting'});await h.fire();await h.fire();await h.fire();
 assert.deepEqual(h.delays,[2000,5000,10000,30000]);assert(h.calls.every(path=>path==='/paid/orders/'+id));h.monitor.dispose();
});
await check('A credited response refreshes account balance once and stops automatic polling',async()=>{
 const h=harness();h.monitor.watch({id,status:'waiting'});h.setNext(async()=>({id,status:'credited'}));await h.fire();
 assert.equal(h.settled.length,1);assert.equal(h.timers.size,0);await h.monitor.refresh();assert.equal(h.settled.length,1);h.monitor.dispose();
});
await check('Recovery from a persisted order ID refreshes credits when payment settled since account load',async()=>{
 const h=harness();h.setNext(async()=>({id,status:'credited'}));await h.monitor.refresh(id);assert.equal(h.settled.length,1);h.monitor.dispose();
});
await check('Parallel refresh clicks share a single in-flight order request',async()=>{
 const h=harness();let release;h.setNext(()=>new Promise(resolve=>release=resolve));h.monitor.watch({id,status:'waiting'});
 const first=h.monitor.refresh(),second=h.monitor.refresh();assert.equal(h.calls.length,1);release({id,status:'processing'});
 await Promise.all([first,second]);assert.equal(h.orders.length,1);assert.equal(h.timers.size,1);h.monitor.dispose();
});
await check('Hidden page pauses polling and rejects an old in-flight result; visibility resumes',async()=>{
 const h=harness();let release;h.setNext(()=>new Promise(resolve=>release=resolve));h.monitor.watch({id,status:'waiting'});
 const old=h.monitor.refresh();h.setVisible(false);h.monitor.pause();release({id,status:'credited'});await old;
 assert.equal(h.orders.length,0);assert.equal(h.settled.length,0);assert.equal(h.timers.size,0);
 h.setVisible(true);h.setNext(async()=>({id,status:'credited'}));h.monitor.resume();await tick();assert.equal(h.settled.length,1);h.monitor.dispose();
});
await check('Account close/session change/disposing prevents old order updates and further requests',async()=>{
 for(const action of ['stop','dispose']){const h=harness();let release;h.setNext(()=>new Promise(resolve=>release=resolve));
  h.monitor.watch({id,status:'waiting'});const old=h.monitor.refresh();h.monitor[action]();release({id,status:'credited'});await old;
  assert.equal(h.orders.length,0);assert.equal(h.timers.size,0);assert.equal(h.settled.length,0);h.monitor.dispose();}
});
await check('Selecting another order rejects the previous order response',async()=>{
 const h=harness();let release;h.setNext(()=>new Promise(resolve=>release=resolve));h.monitor.watch({id,status:'waiting'});
 const old=h.monitor.refresh();h.monitor.watch({id:other,status:'waiting'});release({id,status:'credited'});await old;
 assert.equal(h.orders.length,0);assert.equal(h.monitor.getOrder().id,other);h.monitor.dispose();
});
await check('Mismatched order DTO is refused and transport failures preserve visible error',async()=>{
 const h=harness();h.monitor.watch({id,status:'waiting'});h.setNext(async()=>({id:other,status:'credited'}));
 await assert.rejects(()=>h.monitor.refresh(),/different payment order/);assert.equal(h.settled.length,0);assert.equal(h.errors.length,1);
 h.setNext(async()=>{throw new Error('Center unavailable');});await assert.rejects(()=>h.monitor.refresh(),/Center unavailable/);assert.equal(h.errors.length,2);h.monitor.dispose();
});
await check('Refreshing a different history order discards the current in-flight payment response',async()=>{
 const h=harness();let release;h.setNext(()=>new Promise(resolve=>release=resolve));h.monitor.watch({id,status:'waiting'});
 const old=h.monitor.refresh();h.setNext(async()=>({id:other,status:'processing'}));await h.monitor.refresh(other);
 release({id,status:'credited'});await old;assert.equal(h.orders.length,1);assert.equal(h.monitor.getOrder().id,other);assert.equal(h.settled.length,0);h.monitor.dispose();
});
await check('Terminal and historical transfer orders are not automatically polled',async()=>{
 for(const status of ['credited','cancelled','expired','failed','submitted']){const h=harness();assert(!paymentPending({id,status}));h.monitor.watch({id,status});assert.equal(h.timers.size,0);h.monitor.dispose();}
 assert(paymentPending({id,status:'creating'}));
});
await check('A review-held order keeps observing server status and refreshes credits when it settles',async()=>{
 const h=harness();h.monitor.watch({id,status:'review_required'});assert.equal(h.timers.size,1);
 h.setNext(async()=>({id,status:'credited'}));await h.fire();
 assert.equal(h.settled.length,1);assert.equal(h.timers.size,0);h.monitor.dispose();
});
await check('Authentication or ownership rejection stops automatic polling without clearing the saved session',async()=>{
 const h=harness();h.monitor.watch({id,status:'waiting'});h.setNext(async()=>{throw Object.assign(new Error('Order unavailable'),{status:403});});
 await assert.rejects(()=>h.monitor.refresh(),{status:403});assert.equal(h.errors.length,1);assert.equal(h.timers.size,0);assert.equal(h.monitor.getOrder().id,id);h.monitor.dispose();
});
await check('Customer order reads carry customer session only; account switch is rejected',async()=>{
 let saved={customApiUrl:'http://localhost:7860',paidApiBase:'http://localhost:7860',paidSessionToken:'customer-session'};let captured;
 const client=createAccountClient({read:async()=>saved,write:async()=>{},fetchFn:async(url,opts)=>{
  captured={url,opts};return new Response(JSON.stringify({id,status:'waiting',qr:{image_url:'data:image/png;base64,AA=='}}));}});
 await client.request('/paid/orders/'+id);assert.equal(captured.opts.headers.Authorization,'Bearer customer-session');
 assert.equal(captured.opts.method,'GET');assert(!captured.url.includes('customer-session'));assert.equal(captured.opts.redirect,'error');
 saved={...saved,customApiUrl:'https://other.example'};await assert.rejects(()=>client.request('/paid/orders/'+id),{code:'SESSION_SCOPE_MISMATCH'});client.invalidate();
});
console.log(JSON.stringify({scope:'Production payment monitor/account client with deterministic timers and stub transport. No live Stripe credentials or charges.',checks,total:checks.length,passed:true},null,2));
