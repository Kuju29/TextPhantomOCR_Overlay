import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { shortenValue } from '../src/shared/trace.js';
const original=globalThis.fetch;
const canonicalPrompt={version:'translation-plan-2',pieces:{systemPolicy:'POLICY',editableStyle:'Target language: Thai\nSTYLE SENTINEL',
 targetLanguageInstruction:'Target language: Thai (ภาษาไทย).',sourceInputContract:'SOURCE CONTRACT',imageHint:'IMAGE',seriesNotesHeading:'SERIES',markerOutputContract:'MARKER',structuredOutputContract:'SCHEMA'}};
const workload={version:1,predictedOutput:70,reasoningReserve:0,completionAvailable:1024};
try {
 for(const schema of [false,true]) {
  const bodies=[];
  globalThis.fetch=async (url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({model:'fixture-model',
   message:{role:'assistant',content:schema?' {"P0":"อรุณสวัสดิ์"} ':'<<TP_P0:อรุณสวัสดิ์>>'},done:true,done_reason:'stop',prompt_eval_count:750,eval_count:24,prompt_eval_cached_count:512}),
   {status:200,headers:{'Content-Type':'application/json'}});};
  const ai={provider:'ollama',model:'fixture-model',base_url:'http://localhost:11434',thinking:'off',prompt:'STYLE SENTINEL',promptMode:'replace',
   local_adapter:{protocol:'ollama',baseUrl:'http://localhost:11434'},
   model_capabilities:{limits:{contextTokens:4096,maxOutputTokens:1024},reasoning:{supported:false},structuredOutput:{supported:schema,contract:'tp.translation.schema-object/1',source:'fixture'}}};
  const units=[{id:'global_42',text:'Morning.'}];
  const opts={ai,canonicalPrompt,targetLang:'th'};
  const before=await translateWithLocalOpenAi(units,opts);
  const after=await translateWithLocalOpenAi(units,{...opts,ai:{...ai,workload}});
  assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1],'Within original budget, exact wire bytes/parameters remain unchanged');
  assert.equal(after.translations[0].id,'global_42');assert.equal(after.translations[0].text,'อรุณสวัสดิ์');
  assert.equal(after.meta.usage.cachedInputTokens,512);assert.equal(after.meta.requestedOutputTokens,1024);
  await assert.rejects(translateWithLocalOpenAi(units,{...opts,ai:{...ai,workload:{...workload,predictedOutput:3000}}}),
   e=>e.code==='ai_workload_budget_insufficient');
  assert.equal(bodies.length,2,'No probe/retry/dispatch after rejected budget');
  console.log(`PASS direct Ollama ${schema?'JSON':'marker'}: unchanged wire, exact global ID, real cache counters, pre-dispatch guard`);
 }
 const diag={event:'observation',operationId:'op',profileId:'abc',outcome:'ok',finishReason:'stop',requestedOutputTokens:1024,
  usage:{inputTokens:1000,outputTokens:80,visible:80,thinkingTokens:0,cachedInput:512},validation:{missingCount:0,wrongLanguageCount:0},
  learning:{samples:3,recordTarget:5,revision:0,decision:'fixed_records_3_5_no_adaptive_growth'}};
 assert.deepEqual(shortenValue(diag),diag,'Compact privacy filter must retain all numerical decisions');
 console.log('PASS workload diagnostics survive existing 12-field compact trace filter');
 const numeric={sourceChars:280,recordTarget:5};
 assert.deepEqual(shortenValue(numeric),numeric);
 const privateValues={sourceChars:'SENTINEL_SOURCE',sourceText:'SENTINEL_TEXT'};
 assert.doesNotMatch(JSON.stringify(shortenValue(privateValues)),/SENTINEL/);
 const py=spawnSync('python',['-c',`import sys,json;sys.path.insert(0,'api');from backend.trace import _short
n=json.loads(sys.argv[1]);p=json.loads(sys.argv[2]);assert _short(n)==n;assert 'SENTINEL' not in json.dumps(_short(p));print('PASS numeric workload trace survives API privacy pass; strings remain private')`,JSON.stringify(numeric),JSON.stringify(privateValues)],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
 assert.equal(py.status,0,py.stderr);console.log(py.stdout.trim());
} finally {globalThis.fetch=original;}
console.log('Local workload boundary: 4/4 PASS (mock transport only).');
