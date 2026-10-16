import assert from 'node:assert/strict';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {diagnoseTargetScripts} from '../src/background/ai/script-diagnostics.js';
import {repairRequest} from '../src/background/repair/client.js';
const savedFetch=globalThis.fetch;
let captured;
try {
 globalThis.fetch=async(url,options)=>{
  captured={url,body:JSON.parse(options.body),headers:options.headers};
  return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'R0',text:'ไทย'}],missing:[],meta:{providerAttempts:1,generationAttempts:1}}));
 };
 const answer=await translateViaServer([{id:'R0',text:'Hello'}],{base:'https://example.test',targetLang:'th',sourceLang:'en',
  operationId:'repair:r:t',ai:{provider:'openrouter',model:'fixture',prompt:'UNTOUCHED STYLE',api_key:'test-key'},
  repairClaim:{runId:'r',taskId:'t',token:'token-fixture'}});
 assert.equal(captured.url,'https://example.test/v2/engine/runsextension/repair-runs/r/tasks/t/translate');
 assert.equal(captured.headers['X-TP-Run-Token'],'token-fixture');assert.equal(captured.body.prompt,'UNTOUCHED STYLE');
 assert.deepEqual(captured.body.units,[{id:'R0',text:'Hello'}]);assert.equal(answer.translations[0].id,'R0');
 assert.equal(captured.body.repair.enabled,false);
} finally {globalThis.fetch=savedFetch}
// (The popup translation-session status panel was dead code — not in popup.html — and was removed.)
{
 let seen;
 try {
  globalThis.fetch=async(_url,options)=>{seen=options.headers;return new Response(JSON.stringify({ok:true}));};
  await repairRequest({base:'https://example.test',id:'run-a',token:'a'.repeat(64),batchId:'batch-a',sessionId:'tab-session-a'},'register',{runId:'run-a',manifest:['p']});
  assert.equal(seen['X-TP-Tab-Session'],'tab-session-a','repair quota identity must follow the owning tab session');
 } finally { globalThis.fetch=savedFetch; }
}

for(const text of ['@official_scan','++ KUMO TRANSLATION']) {
 const r=diagnoseTargetScripts([{id:'x',text}],'th',[{id:'x',text}]);assert.ok(r.every(x=>x.decision!=='reject'),text);
}
assert.ok(diagnoseTargetScripts([{id:'x',text:'I WILL GO HOME'}],'th',[{id:'x',text:'I WILL GO HOME'}]).some(x=>x.decision==='reject'));
console.log('Repair HTTP dispatch + tab-session quota identity + narrow preservation boundaries passed.');
