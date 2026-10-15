/** .69 Paid credit check (owner rule): estimate the run at click time; when the
 * balance may not cover it, ask on the page first (Yes = translate while credits
 * last, No = nothing starts). TP per image is learned from this account's own
 * Paid receipts; before any use, from the model price. */
import assert from 'node:assert/strict';
let disk={}, sent=[], reply=null;
globalThis.chrome={runtime:{lastError:null,id:'x',getManifest:()=>({version:'2026.10.4.69'}),sendMessage:(_m,cb)=>cb?.({}),onMessage:{addListener(){}}},
  storage:{local:{get(keys,cb){const out=keys==null?structuredClone(disk):Object.fromEntries([].concat(keys).map(k=>[k,structuredClone(disk[k])]));cb?.(out);return Promise.resolve(out);},
    set(patch,cb){Object.assign(disk,structuredClone(patch));cb?.();return Promise.resolve();}},onChanged:{addListener(){}},session:{get:(k,cb)=>{cb?.({});return Promise.resolve({});},set:(p,cb)=>{cb?.();return Promise.resolve();}}},
  tabs:{sendMessage(tabId,msg,opts,cb){sent.push({tabId,msg,opts});cb?.(reply);}},contextMenus:{create(){},removeAll(cb){cb?.()},onClicked:{addListener(){}}}};
const {estimatePaidRun,recordPaidRequest,paidRunEstimate,tpPerImage,DEFAULT_TOKENS}=await import('../src/background/paid-credit-estimate.js');
const {recordPaidUsage}=await import('../src/background/ai/translation-paths/batch-dispatch.js');
const {confirmPaidCredits}=await import('../src/background/context-menu.js');
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;},eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};

// Model price only (first use): one-off prompt + per image.
const pricing={input_tp:'83.8',output_tp:'335.3'};
const first=estimatePaidRun({images:10,availableTp:5000,pricing});
const perImage=(DEFAULT_TOKENS.inputPerImage*83.8+DEFAULT_TOKENS.outputPerImage*335.3)/1000, prompt=DEFAULT_TOKENS.promptInput*83.8/1000;
eq(first.basis,'model_price');eq(first.estimateTp,Math.ceil(prompt+perImage*10));ok(first.sufficient);
const short=estimatePaidRun({images:100,availableTp:2000,pricing});
ok(!short.sufficient&&short.coverableImages===Math.floor((2000-prompt)/perImage),'how many images the balance covers');
// Unknown price or balance: never block (the Center still checks every request).
ok(estimatePaidRun({images:5,availableTp:null,pricing}).sufficient);ok(estimatePaidRun({images:5,availableTp:10,pricing:null}).sufficient);

// Learned from this account's receipts (charged TP / pages per request).
const api='https://api.example',model='google/gemini-2.5-flash-lite';
for(const [tp,pages] of [[1069,25],[1308,9],[320,2]])await recordPaidRequest({apiBase:api+'/',model,chargedTp:tp,pages});
eq(tpPerImage(disk.paidCreditStatsV1[JSON.stringify([api,model])]),(1069+1308+320)/36);
const learned=await paidRunEstimate({apiBase:api,model,images:40,availableTp:2000,pricing});
eq(learned.basis,'your_recent_usage');eq(learned.estimateTp,Math.ceil(40*(1069+1308+320)/36));ok(!learned.sufficient);
// The hook records only Paid answers that report a charge.
const hook=recordPaidUsage(async row=>rows.push(row)),rows=[];
await hook({pages:[1,2,3],answer:{meta:{usage:{chargedTp:'930'}}},options:{base:api,ai:{provider:'paid',model}}});
await hook({pages:[1],answer:{meta:{usage:{chargedTp:'5'}}},options:{base:api,ai:{provider:'openrouter',model}}});
await hook({pages:[1],answer:null,error:new Error('x'),options:{base:api,ai:{provider:'paid',model}}});
eq(rows,[{apiBase:api,model,chargedTp:930,pages:3}]);

// Click-time confirm: enough -> no question; not enough -> the page is asked.
const ctx={paidCreditCheck:{apiBase:api,model,availableTp:100000,pricing}};
ok(await confirmPaidCredits(ctx,{id:7},0,40)&&sent.length===0,'enough credits: no question');
ctx.paidCreditCheck.availableTp=500;
reply={proceed:false};ok(!(await confirmPaidCredits(ctx,{id:7},0,40)),'No: nothing starts');
eq(sent.at(-1).msg.type,'TP_PAID_CREDIT_CONFIRM');ok(sent.at(-1).msg.estimate.coverableImages<40);
reply={proceed:true};ok(await confirmPaidCredits(ctx,{id:7},0,40),'Yes: run while credits last');
reply=null;ok(!(await confirmPaidCredits(ctx,{id:7},0,40)),'no answer from the page: do not start');
ok(await confirmPaidCredits({paidCreditCheck:null},{id:7},0,40),'Manual/Local/Login: no check');
console.log(`PASS ${checks} Paid credit confirm checks: price and learned estimates, coverable images, hook, ask/yes/no`);
