/** Actual Cloud transport boundary: no provider/network, no production keys. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const stored = {};
globalThis.chrome = {runtime:{getManifest:()=>({version:'test'})},storage:{local:{
  get(keys,cb){cb(typeof keys==='string'?{[keys]:stored[keys]}:{...stored});},
  set(values,cb){Object.assign(stored,values);cb?.();},
}}};
const root = pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
const {translateViaServer} = await import(new URL('src/background/ai/transports/server.js',root));
const captures=[];
const vectors = [
  ['supported', {structured_output:{supported:true}}, true],
  ['unsupported', {structured_output:{supported:false}}, false],
  ['unknown', {}, null],
  ['invalid-string', {structured_output:{supported:'true'}}, null],
  ['null', {structured_output:{supported:null}}, null],
  ['empty', {structured_output:{}}, null],
  ['camel-alias', {structuredOutput:{supported:true}}, true],
  ['canonical-wins', {structured_output:{supported:false},structuredOutput:{supported:true}}, false],
  ['no-reasoning', {structured_output:{supported:true},limits:{contextTokens:8192,maxOutputTokens:2048}}, true],
  ['with-reasoning', {structured_output:{supported:true},reasoning:{supported:true,mandatory:false,
    supported_efforts:['LOW','high','bad effort','low']}}, true],
];
let calls=0;
for(const [name,caps,supported] of vectors) for(const repair of [false,true]) {
  const operationId=`fixture-${name}-${repair}`;
  const input=structuredClone(caps);
  let body;
  globalThis.fetch = async (url,init) => {
    assert.equal(String(url),repair?'http://fixture.invalid/v2/engine/runsextension/repair-runs/run/tasks/task/translate':'http://fixture.invalid/v1/ai/translate');
    calls++;body=JSON.parse(init.body);
    return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'g0',text:'คำแปล'}],missing:[],
      meta:{resolvedProvider:'openrouter',resolvedModel:'test-model',generationAttempts:1,providerAttempts:1}}),{status:200});
  };
  await translateViaServer([{id:'g0',text:'Hello'}],{base:'http://fixture.invalid',targetLang:'th',sourceLang:'en',operationId,
    ai:{provider:'openrouter',model:'test-model',base_url:'https://openrouter.ai/api/v1',api_key:'fixture-not-a-key',
      prompt:'STYLE SENTINEL',thinking:'off',char_memory:false,modelCapabilities:caps,
      ...(repair?{repair_reason:'wrong_target_script'}:{})},
    repairClaim:repair?{runId:'run',taskId:'task',token:'fixture-token'}:null,
  });
  assert.deepEqual(caps,input,'normalization cannot mutate the saved profile');
  captures.push({name,repair,supported,body});
}
if(process.argv.includes('--capture')) console.log(JSON.stringify(captures));
else {
  for(const row of captures){
    const actual=row.body.provider.modelCapabilities.structured_output?.supported;
    assert.equal(actual,row.supported===null?undefined:row.supported,`${row.name} repair=${row.repair}: tri-state capability lost`);
    assert.equal(row.body.provider.outputContract,row.supported===true?'json_schema_object_v1':row.supported===false?'compact_markers_v1':undefined);
    assert.equal(row.body.prompt,'STYLE SENTINEL');assert.equal(row.body.provider.thinking,'off');
    assert.equal(row.body.repair.enabled,false,'no nested repair introduced');
  }
  assert.equal(calls,20);
  console.log('Capability forwarding: 20/20 wire cases passed (mock HTTP; zero live calls).');
}
