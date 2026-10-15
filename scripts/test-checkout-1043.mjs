import assert from 'node:assert/strict';
import { checkoutLink, createCheckoutLauncher } from '../src/shared/customer-portal/checkout.js';
const id='ord_'+'a'.repeat(32), other='ord_'+'b'.repeat(32), url='https://checkout.stripe.com/c/pay/cs_test_QA';
const creating={id,status:'creating',method:'checkout',selection_result:'created'};
const ready={...creating,status:'waiting',checkout_url:url,checkout_expires_at:Date.now()+3600000};
let checks=0;
for(const value of ['http://checkout.stripe.com/pay','https://checkout.stripe.com.evil.example/pay','https://user@checkout.stripe.com/pay','https://checkout.stripe.com:444/pay','javascript:alert(1)','not a URL',null]){
 assert.equal(checkoutLink(value),null);checks++;
}
assert.equal(checkoutLink(url),url);checks++;
let opened=[],errors=[],eligible=true;
const launcher=createCheckoutLauncher({open:async value=>opened.push(value),isEligible:()=>eligible,onError:message=>errors.push(message)});
launcher.arm(creating);await launcher.update(creating);assert.equal(opened.length,0);checks++;
await launcher.update({...ready,id:other});assert.equal(opened.length,0);checks++;
await Promise.all([launcher.update(ready),launcher.update(ready)]);assert.deepEqual(opened,[url]);checks++;
await launcher.update(ready);assert.equal(opened.length,1);checks++;
for(const selection_result of ['reused','replayed',undefined]){
 launcher.arm({...ready,selection_result});await launcher.update(ready);assert.equal(opened.length,1);checks++;
}
for(const patch of [{cancel_pending:true},{status:'cancelled'},{status:'credited'},{status:'processing'},{status:'review_required'},{checkout_expires_at:Date.now()-1},{payment_expires_at:Date.now()-1}]){
 launcher.arm(creating);await launcher.update({...ready,...patch});await launcher.update(ready);assert.equal(opened.length,1);checks++;
}
launcher.arm(creating);launcher.cancel();await launcher.update(ready);assert.equal(opened.length,1);checks++;
launcher.arm(creating);eligible=false;await launcher.update(ready);eligible=true;await launcher.update(ready);assert.equal(opened.length,1);checks++;
let attempts=0;
const failed=createCheckoutLauncher({open:async()=>{attempts++;throw Error('browser unavailable');},onError:message=>errors.push(message)});
failed.arm(creating);await failed.update(ready);await failed.update(ready);assert.equal(attempts,1);assert.match(errors[0],/Open Stripe checkout/);checks++;
console.log(JSON.stringify({checks,passed:true,scope:'Actual one-shot launcher and Stripe URL validation; no live payment'}));
