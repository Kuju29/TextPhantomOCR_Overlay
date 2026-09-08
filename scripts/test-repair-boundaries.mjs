import assert from 'node:assert/strict';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {mountTranslationSessionStatus} from '../src/popup/controllers/translation-session-controller.js';
import {diagnoseTargetScripts} from '../src/background/ai/script-diagnostics.js';
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
{
 const sent=[],elements=Object.fromEntries(['translation-session-panel','translation-session-status','translation-session-resume'].map(id=>[id,{hidden:true,addEventListener(_event,fn){this.click=fn;}}]));
 const callbacks={};
 mountTranslationSessionStatus({document:{getElementById:id=>elements[id]},events:{addListener:f=>callbacks.change=f,removeListener(){}},page:{addEventListener(){}},
  send:async m=>{sent.push(m.type);return {ok:true,runs:[{phase:'blocked',repaired:2,failedUnits:3,unresolved:1}]}}});
 await new Promise(r=>setTimeout(r,0));assert.deepEqual(sent,['TP_GET_TRANSLATION_SESSIONS']);
 assert.equal(elements['translation-session-resume'].hidden,false);
 await elements['translation-session-resume'].click();assert.ok(sent.includes('TP_RESUME_REPAIRS'));
}
for(const text of ['@official_scan','++ KUMO TRANSLATION']) {
 const r=diagnoseTargetScripts([{id:'x',text}],'th',[{id:'x',text}]);assert.ok(r.every(x=>x.decision!=='reject'),text);
}
assert.ok(diagnoseTargetScripts([{id:'x',text:'I WILL GO HOME'}],'th',[{id:'x',text:'I WILL GO HOME'}]).some(x=>x.decision==='reject'));
console.log('Repair HTTP dispatch + popup read-only/external resume + narrow preservation boundaries passed.');
