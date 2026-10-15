import assert from 'node:assert/strict';
import {createPaymentMonitor,reconcileAccountOrder} from '../src/paid/payment.js';
const id='ord_'+'a'.repeat(32), waiting={id,status:'waiting'}, cancelled={id,status:'cancelled'};
const data=order=>({history:{orders:{items:[order]}}});
let checks=0;
for(const terminal of ['cancelled','failed','credited','expired']){
 const newest={id,status:terminal};let d=data(waiting);
 assert.deepEqual(reconcileAccountOrder(d,newest,id,true),newest);
 assert.equal(d.history.orders.items[0].status,terminal);
 d=data(newest);assert.equal(reconcileAccountOrder(d,waiting,id).status,terminal);
 checks+=2;
}
let d=data(waiting);assert.equal(reconcileAccountOrder(d,{id,status:'processing'},id,true).status,'processing');checks++;
for(const status of ['cancelled','failed','credited','expired']){
 let done=0,timer=0;
 const m=createPaymentMonitor({request:async()=>({id,status}),onSettled:()=>done++,schedule:()=>++timer,unschedule:()=>{}});
 m.watch(waiting);await m.refresh();await m.refresh();assert.equal(done,1);m.dispose();checks++;
}
let release,seen=0;
const m=createPaymentMonitor({request:()=>new Promise(r=>release=r),onOrder:()=>seen++,schedule:()=>1,unschedule:()=>{}});
m.watch(waiting);const old=m.refresh();m.watch(cancelled);release(waiting);await old;
assert.equal(seen,0);assert.equal(m.getOrder().status,'cancelled');m.dispose();checks++;
console.log(JSON.stringify({checks,passed:true,scope:'Actual reconciliation/monitor functions, deferred synthetic responses'}));
