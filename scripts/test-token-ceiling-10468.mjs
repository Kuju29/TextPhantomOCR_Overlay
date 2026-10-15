// .68 per-model token ceiling (replaces the request-rate cap). Default OFF:
// Paid = Center model ceiling, Manual Cloud = application 8192 (or a lower model
// maximum), Local = loaded context. ON: the user's number is used first.
import assert from 'node:assert/strict';
import {defaultTokenCeiling,activeTokenCeiling,cleanTokenCeiling,validTokenCeiling} from '../src/shared/token-ceiling.js';
import {cleanPaidProfile} from '../src/shared/paid-profile.js';
import {initialProfile,takeWorkloadBatch} from '../src/shared/ai/workload/model.js';
import {planConversationBatch} from '../src/shared/ai/workload/conversation-batch-planner.js';
import {readFile} from 'node:fs/promises';
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;};

// Defaults shown when OFF.
eq(defaultTokenCeiling({service:'paid',paidCeiling:12000}),{tokens:12000,source:'center'});
eq(defaultTokenCeiling({service:'paid'}),{tokens:8192,source:'application'});
eq(defaultTokenCeiling({modelCapabilities:{limits:{maxOutputTokens:4096}}}),{tokens:4096,source:'application'});
eq(defaultTokenCeiling({}),{tokens:8192,source:'application'});
eq(defaultTokenCeiling({local:true,localLimits:{contextTokens:32768}}),{tokens:32768,source:'model'});
eq(defaultTokenCeiling({local:true}),{tokens:null,source:'unknown'},'a Local window is never invented');
// Stored fields: OFF keeps the number; invalid numbers are dropped.
eq(activeTokenCeiling({tokenCeilingEnabled:true,tokenCeiling:20000}),20000);
eq(activeTokenCeiling({tokenCeilingEnabled:false,tokenCeiling:20000}),null);
eq(cleanTokenCeiling({tokenCeilingEnabled:true,tokenCeiling:12}),{});
ok(!validTokenCeiling(255)&&validTokenCeiling(256)&&!validTokenCeiling(2_000_001));
eq(cleanPaidProfile({tokenCeilingEnabled:true,tokenCeiling:16000}).tokenCeiling,16000,'Paid model profile keeps its own ceiling');

// Conversation: the user's ceiling replaces the default turn budget.
const rows=Array.from({length:200},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'ก'.repeat(35)}));
const plan=(over={})=>planConversationBatch({rows,pageSizes:Array(20).fill(10),profileSnapshot:initialProfile(),conversationState:{continuation:true},
  context:{limits:{contextTokens:1048576,maxOutputTokens:8192},provider:'paid',contract:'compact_markers_v1',reasoningActive:false,paidRequestBudget:8192,...over},
  capabilities:{reasoning:{supported:false,supports_max_tokens:true}},estimateFixedInput:()=>2000});
const base=plan(),higher=plan({userTokenCeiling:16000}),lower=plan({userTokenCeiling:4096});
eq(base.estimate.turnBudget.ceiling,8192);eq(higher.estimate.turnBudget.ceiling,16000);eq(lower.estimate.turnBudget.ceiling,4096);
ok(higher.pageCount>base.pageCount&&lower.pageCount<base.pageCount,'higher ceiling = fewer requests; lower = more');
ok(higher.estimate.predictedOutput<=8192,'the reply never exceeds the model/API output maximum');
const manual=plan({provider:'openrouter',paidRequestBudget:null,userTokenCeiling:12000});
eq(manual.estimate.turnBudget.ceiling,12000,'Manual Cloud uses the same per-model override');

// .69 Login chat: OFF keeps today's automatic size (no turn budget); ON uses the
// user's number as the whole-turn budget, so more pages go in each request.
const login=(over={})=>planConversationBatch({rows,pageSizes:Array(20).fill(10),profileSnapshot:initialProfile(),conversationState:{continuation:true},
  context:{limits:{},provider:'login',contract:'compact_markers_v1',reasoningActive:false,...over},
  capabilities:{reasoning:{supported:false}},estimateFixedInput:()=>2000});
const loginOff=login(),loginOn=login({userTokenCeiling:16000}),loginSmall=login({userTokenCeiling:2048});
eq(loginOff.estimate.turnBudget,undefined,'Login OFF: no turn budget, unchanged sizing');
eq(loginOn.estimate.turnBudget.ceiling,16000);
ok(loginOn.pageCount>loginOff.pageCount,'Login ceiling ON: more pages per request');
ok(loginSmall.pageCount<=loginOff.pageCount,'Login small ceiling: no larger than today');
ok(loginOn.estimate.turnBudget.turnInput+loginOn.estimate.predictedOutput<=16000);

// Local Independent: the user's ceiling is the window target; the real model
// window still bounds every request (planner never exceeds what the model loaded).
const local=(over={})=>({provider:'lmstudio',localIndependent:true,wholePageFirst:true,contract:'compact_markers_v1',
  reasoningSupported:false,reasoningActive:false,limits:{contextTokens:32768,source:'runtime'},fixedInput:1500,...over});
const page=Array.from({length:400},(_,i)=>({id:`P${i}`,text:'ก'.repeat(30)}));
const full=takeWorkloadBatch(page,0,initialProfile(),local());
const capped=takeWorkloadBatch(page,0,initialProfile(),local({userTokenCeiling:8192}));
ok(capped.units.length<full.units.length,'a lower Local ceiling sends less per request');
ok(capped.estimate.estimatedInput+capped.estimate.predictedOutput+128<=8192);
const above=takeWorkloadBatch(page,0,initialProfile(),local({userTokenCeiling:200000}));
ok(above.estimate.estimatedInput+above.estimate.predictedOutput+128<=32768,'above the loaded window: still bounded by the real window');
const unknown=takeWorkloadBatch(page,0,initialProfile(),local({limits:{},userTokenCeiling:8192}));
ok(unknown.estimate.estimatedInput+unknown.estimate.predictedOutput+128<=8192,'a user ceiling lets Local plan before the window is known');

// Popup: the request-rate cap UI is gone; the token ceiling is in its place.
const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
const resolver=await readFile(new URL('../src/background/ai-profile-resolver.js',import.meta.url),'utf8');
eq((resolver.match(/aiTokenCeiling:\s*activeTokenCeiling\(profile\)/g)||[]).length,3,'Manual, Paid and Login pass the ceiling');
const paidUi=await readFile(new URL('../src/popup/controllers/paid-service-controller.js',import.meta.url),'utf8');
ok(paidUi.includes('show(els.aiTokenCeilingWrap, true)'),'ceiling field shown for Login too');
ok(!html.includes('rate-limit-enabled')&&!html.includes('ai-local-rate-enabled'),'request-rate cap UI removed');
ok(/id="ai-token-ceiling-enabled"/.test(html)&&/id="ai-token-ceiling"[^>]*disabled/.test(html),'ceiling input is OFF by default');
console.log(`PASS ${checks} token ceiling checks: defaults per service, per-model override, fewer requests when raised, real window still bounds Local`);
