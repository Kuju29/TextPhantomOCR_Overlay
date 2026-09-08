/** Real grouping -> source -> page validation -> durable repair -> patch.
 * Only OCR/provider I/O and browser storage are replaced; no live requests.
 */
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {translateUnits as routeTranslate} from '../src/background/ai/translation-service.js';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {makePageCheckpoint,buildPatchedResult,pageInitialReport} from '../src/background/repair/page-checkpoint.js';
import {executeRepairPool} from '../src/background/repair/executor.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {targetLanguagePriority} from '../src/shared/ai/direct-local/prompt.js';
import {reportTranslationFailure} from '../src/shared/diagnostic-policy.js';
import {createLogger,setLogLevel} from '../src/shared/logger.js';
import {makeTpError} from '../src/shared/error-contract.js';
let checks=0;async function test(name,fn){await fn();checks++;console.log('PASS '+name);}
const prompt=lang=>({version:'translation-plan-2',pieces:{systemPolicy:'POLICY',editableStyle:'STYLE SENTINEL',
 targetLanguageInstruction:targetLanguagePriority(lang).replace(/^Translate every source unit into /,'Target language: '),
 sourceInputContract:'SOURCE CONTRACT',imageHint:'IMAGE',seriesNotesHeading:'SERIES',markerOutputContract:'MARKER',structuredOutputContract:'SCHEMA'}});
const ai={provider:'ollama',model:'fixture-model',base_url:'http://localhost:11434',thinking:'off',prompt:'STYLE SENTINEL',promptMode:'replace',
 local_adapter:{protocol:'ollama',baseUrl:'http://localhost:11434'},model_capabilities:{limits:{contextTokens:8192,maxOutputTokens:4096},reasoning:{supported:false},structuredOutput:{supported:false}}};
const savedFetch=globalThis.fetch;
function reply(text){return new Response(JSON.stringify({model:'fixture-model',message:{role:'assistant',content:text},done:true,done_reason:'stop',prompt_eval_count:750,eval_count:24,prompt_eval_cached_count:512}),{status:200,headers:{'content-type':'application/json'}});}
function ledger(){
 const c=spawn('python',['-u','scripts/repair-ledger-fixture.py'],{stdio:['pipe','pipe','inherit']}),q=[];
 createInterface({input:c.stdout}).on('line',s=>{const p=q.shift(),r=JSON.parse(s);r.ok?p.resolve(r.value):p.reject(new Error(r.code));});
 c.on('exit',code=>{for(const p of q.splice(0))p.reject(new Error('ledger exited '+code));});
 return {api(run,action='',body={}){return new Promise((resolve,reject)=>{q.push({resolve,reject});c.stdin.write(JSON.stringify({run,action,body})+'\n');});},close(){c.stdin.end();}};
}
const generated=spawnSync('python',['-c',`import sys,json
sys.path.insert(0,'api')
from backend.grouping.detector_free_service import group_vertical_lens
from backend.grouping.ai_source_tree import build_ai_source_tree
from backend.lens.document import build
p=[]
for i,(text,x,y,w,h,angle) in enumerate([('本文',100,20,20,160,90),('かな',180,40,20,20,None)]):
 b=[x,y,x+w,y+h];box={} if angle is None else {'rotation_deg':angle}
 p.append({'id':'raw'+str(i),'para_index':i,'text':text,'bounds_px':b,'items':[{'text':text,'bounds_px':b,'box':box,'height_raw':h/1000,'baseline_p1':{'x':x/1000,'y':y/1000},'baseline_p2':{'x':(x+w)/1000,'y':y/1000}}]})
t={'paragraphs':p};g=group_vertical_lens(t,1000,1000);d=build(t,{},width=1000,height=1000,source_lang='ja',target_lang='th');d['canonicalOriginalTree']=build_ai_source_tree(t,g['grouping_result'])
print(json.dumps({'doc':d,'debug':g['debug']}))`],{encoding:'utf8'});
assert.equal(generated.status,0,generated.stderr);const fixture=JSON.parse(generated.stdout);
await test('uncertain geometry reaches AI preparation and one failed unit repairs into the original clean-background patch',async()=>{
 assert.deepEqual(fixture.debug.isolatedIds,['raw1']);
 const b=ledger(),run={id:'recovery-integration',token:'a'.repeat(64)},events=[],calls=[];
 let page;const input={backgroundMode:'boxes',lensDocument:structuredClone(fixture.doc),eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
 try {
  const ctl=createWorkloadController({read:async()=>({}),write:async()=>{}});
  const plan={route:'direct-local',ai};
  const result=await translateLensPage({base:'http://test',payload:{lang:'th',metadata:{image_id:'page'},context:{}},result:input,plan,
   trace:(name,data)=>events.push({name,data}),onCheckpoint:async row=>{
    if(row.stage==='prepared')page=await makePageCheckpoint({...row,ctx:{jobId:'generation'}});
    if(row.stage==='finished'){page.accepted=row.accepted;page.failures=row.failures;page.phase='finished';}
   },dependencies:{workloadController:ctl,translateUnits:async rows=>{
    calls.push(rows);return {translations:rows.map((u,i)=>({id:u.id,text:i===0?'คำแปลที่ดีเดิม':'日本語のままです'})),missing:[],meta:{finishReason:'stop',generationAttempts:1,providerAttempts:1}};
   }}});
  assert(result.usable);assert(page);assert.equal(page.failures.length,1);assert.equal(page.accepted.length,1);
  const acceptedId=page.accepted[0].id;await b.api(run,'register',{manifest:['page']});await b.api(run,'pages',pageInitialReport(page));
  const sealed=await b.api(run,'seal');assert.equal(sealed.unavailablePages,0);assert.equal(sealed.failedUnits,1);
  let patches=0,wire=[];globalThis.fetch=async(url,init)=>{wire.push(JSON.parse(init.body));return reply('<<TP_P0:คำแปลที่ซ่อมแล้ว>>');};
  const final=await executeRepairPool({run,snapshot:sealed,executor:'test',getPage:async()=>page,resolveAi:async()=>ai,
   checkpointTask:async()=>{},onProgress:d=>events.push({name:'repair',data:d}),withCapacity:async(_p,_a,_s,fn)=>fn(),api:b.api,planner:ctl,
   translate:async(rows,opts)=>{assert(rows.every(u=>u.id!==acceptedId));return translateWithLocalOpenAi(rows,{...opts,canonicalPrompt:prompt('th')});},
   applyResults:async rows=>{patches++;assert.equal(wire.length,1);const patched=buildPatchedResult(page,rows);
    assert.equal(patched.result.backgroundMode,'boxes');assert.equal(patched.missing.length,0);
    assert(patched.accepted.some(r=>r.id===acceptedId&&r.text==='คำแปลที่ดีเดิม'));
    assert.deepEqual(buildPatchedResult(page,rows),patched,'repeat apply is idempotent');}
  });
  assert.equal(final.repaired,1);assert.equal(final.unavailablePages,0);assert.equal(patches,1);
  assert.match(wire[0].messages[1].content,/REPAIR — WRONG TARGET LANGUAGE/);
  assert(events.some(e=>e.name==='repair'&&e.data.acceptedCount===1));
 }finally{globalThis.fetch=savedFetch;b.close();}
});
for(const lang of ['th','en'])for(const schema of [false,true])await test(`Local ${lang}/${schema?'schema':'marker'}: repair changes User only, initial is untouched, usage preserved`,async()=>{
 const wire=[],text=lang==='th'?'คำแปล':'Translation';globalThis.fetch=async(_u,init)=>{wire.push(JSON.parse(init.body));return reply(schema?JSON.stringify({P0:text}):`<<TP_P0:${text}>>`);};
 try{
  const config={...ai,model_capabilities:{...ai.model_capabilities,structuredOutput:{supported:schema,contract:'tp.translation.schema-object/1',source:'fixture'}}};
  const opts={ai:config,canonicalPrompt:prompt(lang),targetLang:lang};const units=[{id:'failed-global-id',text:'星野、目をつぶって。'}];
  await translateWithLocalOpenAi(units,opts);
  const out=await translateWithLocalOpenAi(units,{...opts,ai:{...config,repair_reason:'wrong_target_script'}});
  assert.equal(wire.length,2);assert.equal(wire[0].messages[0].content,wire[1].messages[0].content);
  assert.doesNotMatch(wire[0].messages[1].content,/REPAIR —/);assert.match(wire[1].messages[1].content,/previous response/);
  assert(wire[1].messages[1].content.includes(targetLanguagePriority(lang)));assert.equal(out.translations[0].id,'failed-global-id');
  assert.equal(out.meta.usage.cachedInputTokens,512);assert.equal(out.meta.usage.outputTokens,24);
 }finally{globalThis.fetch=savedFetch;}
});
await test('actual Local/Cloud route owners preserve repair reason and account exactly two mocked receipts',async()=>{
 const oldChrome=globalThis.chrome,storage={},wire=[];
 globalThis.chrome={runtime:{getManifest:()=>({version:'2026.9.5.48'})},storage:{local:{
  get(keys,cb){cb(Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,storage[k]])):{...keys,...storage});},
  set(value,cb){Object.assign(storage,value);cb?.();}
 }}};
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(init.body);wire.push({url:String(url),body});
  if(String(url).endsWith('/api/chat'))return reply('<<TP_P0:คำแปลที่ซ่อมแล้ว>>');
  return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'global-failed',text:'คำแปลที่ซ่อมแล้ว'}],missing:[],
   meta:{resolvedProvider:'openrouter',resolvedModel:'fixture-model',generationAttempts:1,providerAttempts:1,
    usage:{inputTokens:750,outputTokens:24,totalTokens:774,cachedInputTokens:512,source:'provider'}}}),{status:200,headers:{'content-type':'application/json'}});
 };
 try{
  for(const route of ['direct-local','server']){
   const config=route==='server'?{...ai,provider:'openrouter',base_url:'https://openrouter.ai/api/v1',api_key:'test-key'}:ai;
   const answer=await routeTranslate([{id:'global-failed',text:'星野、目をつぶって。'}],{route,base:'https://fixture.invalid',ai:{...config,repair_reason:'wrong_target_script'},targetLang:'th',sourceLang:'ja',operationId:'repair-route-'+route});
   assert.equal(answer.translations[0].id,'global-failed');
  }
  assert.equal(wire.length,2);assert.match(wire[0].body.messages[1].content,/REPAIR — WRONG TARGET LANGUAGE/);
  assert.deepEqual(wire[1].body.repair,{owner:'extension',enabled:false,reason:'wrong_target_script'});
  const sessions=Object.values(storage.aiUsageV1.models).flatMap(m=>m.sessions||[]);
  assert.equal(sessions.reduce((n,s)=>n+s.requests,0),2);
  assert.equal(sessions.reduce((n,s)=>n+s.inputTokens,0),1500);
  assert.equal(sessions.reduce((n,s)=>n+s.outputTokens,0),48);
 }finally{globalThis.fetch=savedFetch;globalThis.chrome=oldChrome;}
});
await test('expected diagnostics never call console at debug/warn levels; real runtime failures remain visible',async()=>{
 const warn=console.warn,error=console.error,seen=[],traces=[];
 console.warn=(...a)=>seen.push(a);console.error=(...a)=>seen.push(a);
 try{
  for(const enabled of [false,true])for(const level of ['debug','warn']){
   setLogLevel(level);const log=createLogger('test-recovery');const trace=(...a)=>{if(enabled)traces.push(a);};
   for(const code of ['wrong_language_output','orientation_unresolved','invalid_model_output','AI_OUTPUT_INVALID','cancelled'])
    reportTranslationFailure(log,trace,'expected',Object.assign(new Error('content defect'),{code}));
   assert.equal(seen.length,0);
  }
  assert.equal(traces.length,10);const log=createLogger('test-recovery');
  for(const e of [Object.assign(new Error('offline'),{code:'NET_OFFLINE'}),Object.assign(new Error('invalid key'),{code:'invalid_api_key'}),new TypeError('bug')])
   reportTranslationFailure(log,()=>{},'action required',e);
  assert.equal(seen.length,3);
  const message=makeTpError({code:'orientation_unresolved'}).userMessage;
  assert.doesNotMatch(message,/ยังไม่มีคำอธิบาย|UNCLASSIFIED/);assert.match(message,/ทิศทาง|กรอบ|ตำแหน่ง/);
 }finally{console.warn=warn;console.error=error;setLogLevel('warn');}
});
await test('page catch uses trace-only classification while returning the actual failure',async()=>{
 const warnings=[],events=[];const fail=Object.assign(new Error('malformed provider result'),{code:'invalid_model_output',generationAttempts:1});
 await assert.rejects(translateLensPage({base:'http://test',payload:{lang:'th',metadata:{image_id:'page-error'},context:{}},result:{lensDocument:structuredClone(fixture.doc),eraseBoxes:[]},plan:{route:'direct-local',ai},log:{info(){},warn:(...a)=>warnings.push(a)},trace:(...a)=>events.push(a),dependencies:{workloadController:createWorkloadController({read:async()=>({}),write:async()=>{}}),translateUnits:async()=>{throw fail;}}}),e=>e.code==='invalid_model_output');
 assert.equal(warnings.length,0);assert(events.some(e=>e[0]==='translationFailure'));
 const jobs=readFileSync('src/background/jobs.js','utf8');assert.match(jobs,/reportFailure\("the extension route threw before it could draw", e/);
});
console.log(`Recovery runtime: ${checks}/${checks} PASS; real modules+durable ledger, mocked provider HTTP.`);
