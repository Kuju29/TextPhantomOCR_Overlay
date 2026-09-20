/** Layout invariants + actual browser trace shipment -> ASGI ingest -> trace file. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from '../src/generated/canonical-prompt-plans.js';
import { composeCanonicalPrompt, composeTranslationUserMessage, buildStaticUserPrefix } from '../src/shared/ai/direct-local/prompt.js';
import { exactOutputInstruction } from '../src/shared/ai/direct-local/output-contract.js';
import { promptLayout } from '../src/shared/ai/prompt-layout.js';
import { instructionPack } from '../src/shared/ai/prompt-language.js';
import { createPromptInputEstimator } from '../src/shared/ai/workload/prompt-input.js';
import { textWeight } from '../src/shared/ai/workload/model.js';
import { rememberDiagnostic, recentDiagnostic, clearRecentDiagnostics } from '../src/background/ai/recent-diagnostics.js';
import { formatRequestDiagnostic } from '../src/shared/ai/diagnostic-view.js';
import { setTracingEnabled, note, flushTrace, shortenValue } from '../src/shared/trace.js';
const root=fileURLToPath(new URL('../',import.meta.url));
let checks=0, sample;
async function assemble(lang, structured, prompt='', ai={}, source='SOURCE_ONE') {
 const config={prompt,style_examples:true,memory_mode:'off',...ai};
 const c=composeCanonicalPrompt(plans[lang],config,false,structured,lang);
 const style=`${c.sections.language}\n${c.sections.style}`;
 const user=composeTranslationUserMessage({sections:c.sections,targetLang:lang,sourceLang:'en',structuredOutput:structured,
  requestOutputContract:exactOutputInstruction(['P0'],{kind:structured?'schema_object':'compact_records'},lang),
  sourceRecords:structured?`P0:${source}`:`<<TP_P0:${source}>>`,repairReason:config.repair_reason});
 const layout=await promptLayout(c.system,user,{targetLang:lang,sourceLang:'en',structured,examples:config.style_examples,memoryMode:config.memory_mode,selectedStyle:style});
 return {system:c.system,user,style,layout,config};
}
for(const lang of ['th','en','ja','fr'])for(const structured of [false,true])for(const custom of ['', 'STYLE_SECRET_SENTINEL 😀']) {
 const a=await assemble(lang,structured,custom);
 assert.equal(a.system,`${instructionPack(lang).identity}\n\n${instructionPack(lang).styleHeading}\n${a.style}`);
 assert.equal(a.system.includes(a.style),true);
 const prefix=buildStaticUserPrefix(lang,'en',structured,true,a.style);
 assert.equal(prefix.split(a.style).length-1,0);
 assert.equal(a.layout.styleRole,'system');assert.equal(a.layout.systemStyleCopies,1);assert.equal(a.layout.userStyleCopies,0);
 assert.equal(a.layout.styleChars,Array.from(a.style).length);assert.equal(a.layout.styleCountScope,'instruction_blocks');
 assert.equal(a.layout.cacheHit,null);assert.equal(a.layout.cacheSupport,'unknown');
 for(const variant of [
  {config:{},source:'OTHER_SOURCE'},
  {config:{memory_mode:'full',series_state:'SERIES_CONTEXT_SENTINEL',characters:[{name:'Ada',speech:'reserved'}],page_context:[{id:'neighbor',text:'PAGE_EVIDENCE'}]},source:'OTHER_SOURCE'},
  {config:{repair_reason:'wrong_target_script',source_context:[{targetIds:['P0'],units:[{id:'ctx0',text:'REPAIR_EVIDENCE'}]}]},source:'OTHER_SOURCE'},
  {config:{},source:a.style}, // A source may quote instruction-like text; do not count it as an injected style block.
 ]) {
  const b=await assemble(lang,structured,custom,variant.config,variant.source);
  assert.equal(a.system,b.system);assert.equal(a.layout.staticPrefixSha256,b.layout.staticPrefixSha256);
  assert.equal(b.layout.userStyleCopies,0);checks++;
 }
 const edited=await assemble(lang,structured,'DIFFERENT_STYLE');
 assert.notEqual(a.system,edited.system);assert.notEqual(a.layout.styleSha256,edited.layout.styleSha256);
 assert.equal(a.layout.userStaticSha256,edited.layout.userStaticSha256);
 const noExamples=await assemble(lang,structured,custom,{style_examples:false});
 assert.equal(noExamples.layout.examplesIncluded,false);
 assert.equal(a.layout.staticPrefixSha256===noExamples.layout.staticPrefixSha256,lang==='fr');
 await assert.rejects(()=>promptLayout(a.system+a.style,a.user,{targetLang:lang,sourceLang:'en',structured,selectedStyle:a.style}),/prompt_style_delivery_mismatch/);
 await assert.rejects(()=>promptLayout(a.system,'WRONG_PREFIX'+a.user,{targetLang:lang,sourceLang:'en',structured,selectedStyle:a.style}),/prompt_static_prefix_mismatch/);
 const clean=shortenValue({...a.layout,prompt:'STYLE_SECRET_SENTINEL',api_key:'hf_0123456789abcdefgh'});
 for(const key of ['styleRole','systemStyleCopies','userStyleCopies','styleChars','styleSha256','systemChars','userStaticChars','staticPrefixSha256'])assert.deepEqual(clean[key],a.layout[key]);
 assert.doesNotMatch(JSON.stringify(clean),/STYLE_SECRET_SENTINEL|hf_0123456789abcdefgh/);
 checks+=10;sample=a;
}
// Moving style must not double-count it or remove it from the input estimator.
const us=[{id:'P0',text:'Hello'}];
const short='Faithful dialogue.',long=short+' Natural phrasing.'.repeat(200);
const e1=createPromptInputEstimator({ai:{prompt:short,style_examples:false},targetLang:'th'})(us);
const e2=createPromptInputEstimator({ai:{prompt:long,style_examples:false},targetLang:'th'})(us);
assert.equal(e2-e1,Math.ceil(textWeight(long))-Math.ceil(textWeight(short)));
const operationId='ai:'+ 'a'.repeat(32);
rememberDiagnostic({provider:'fixture',model:'small',operationId,layout:sample.layout});
const view=recentDiagnostic('fixture','small');
assert.equal(view.layout.styleRole,sample.layout.styleRole);
assert.equal(view.layout.userStyleCopies,0);assert.equal(view.layout.systemStyleCopies,1);
assert.equal(view.layout.systemStyleCopies,1);assert.equal(view.layout.userStyleCopies,0);
assert.doesNotMatch(formatRequestDiagnostic(view,'th'),/SHA256|layout revision|System 0/,'developer metadata stays in record/log, not the concise UI');
clearRecentDiagnostics();
const oldFetch=globalThis.fetch, shipments=[];
try {
 globalThis.fetch=async(_url,init)=>{shipments.push(JSON.parse(init.body));return {ok:true,status:200,json:async()=>({ok:true})};};
 setTracingEnabled(true,()=> 'http://fixture','compact','fixture-session');
 note('ai/prompt-layout','style-layout-regression',{...sample.layout,operationId,prompt:'STYLE_SECRET_SENTINEL',api_key:'hf_0123456789abcdefgh'});
 await flushTrace();
} finally {setTracingEnabled(false);globalThis.fetch=oldFetch;}
assert.equal(shipments.length,1);
const child=spawnSync('python',['-c',String.raw`
import os,sys,json,tempfile,asyncio
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='tp-style-log-') as temp:
 os.environ.update(TP_TRACE='compact',TP_TRACE_DIR=temp,TP_TRACE_CONTENT='0')
 sys.path.insert(0,'api')
 from backend import trace
 from backend.api.routes import logs
 from fastapi import FastAPI
 import httpx
 trace.start_session()
 payload=json.load(sys.stdin);payload['traceSession']=trace.session_id()
 app=FastAPI();app.include_router(logs.router)
 async def run():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
   a=await client.post('/v1/trace',json=payload)
   b=await client.post('/v1/trace',json=payload)
   assert a.status_code==200 and a.json()['written']==1,a.text
   assert b.status_code==200 and b.json()['written']==0,b.text
 asyncio.run(run());trace.flush()
 text='\n'.join(p.read_text() for p in Path(temp).glob('trace-*.jsonl'))
 records=[json.loads(line) for line in text.splitlines() if line]
 rows=[r for r in records if r.get('fn')=='style-layout-regression']
 assert len(rows)==1,records
 data=rows[0]['d']
 assert data['styleRole']=='system' and data['systemStyleCopies']==1 and data['userStyleCopies']==0,data
 for key in ['styleChars','styleSha256','systemChars','userStaticChars','staticPrefixSha256']:
  assert data[key]==payload['records'][0]['d'][key],(key,data)
 assert 'STYLE_SECRET_SENTINEL' not in text and 'hf_0123456789abcdefgh' not in text
 print(json.dumps({'written':len(rows),'duplicateWritten':0,'styleRole':data['styleRole'],'userStyleCopies':data['userStyleCopies'],'privacy':'pass'}))
`],{cwd:root,input:JSON.stringify(shipments[0]),encoding:'utf8'});
assert.equal(child.status,0,child.stderr||child.stdout);
console.log(`PASS ${checks+5} System-style single-owner invariants: static prefixes, custom/default, TH/EN/JA/fallback, repair and source scope, exact style budget and UI. Trace transport: ${child.stdout.trim()}`);
