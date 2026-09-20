import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLED_CANONICAL_PROMPT_PLANS as plans } from '../src/generated/canonical-prompt-plans.js';
import { composeCanonicalPrompt,composeTranslatorIdentitySystem,composeTranslationUserMessage,buildStyleExamples,buildStaticUserPrefix } from '../src/shared/ai/direct-local/prompt.js';
import { exactOutputInstruction,translationObjectSchema } from '../src/shared/ai/direct-local/output-contract.js';
import { promptLayout } from '../src/shared/ai/prompt-layout.js';
import { instructionPack } from '../src/shared/ai/prompt-language.js';
import { createPromptInputEstimator } from '../src/shared/ai/workload/prompt-input.js';
import { initialProfile,estimateRequest,textWeight } from '../src/shared/ai/workload/model.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const rows=[];
for(const lang of ['th','ja','en','fr'])for(const format of [false,true])for(const examples of [true,false])for(const mode of ['off','terms','full'])for(const custom of [false,true])rows.push({lang,format,examples,mode,custom});
const evidence=[{targetIds:['P0'],units:[{id:'ctx0',text:'NEARBY_SOURCE😀'}]}];
const aiBase={glossary:[{src:'TERM_SENTINEL',tgt:'ศัพท์'}],characters:[{name:'CHAR_SENTINEL',gender:'unknown',speech:'VOICE_SENTINEL',note:'NOTE_SENTINEL'}],series_state:'STORY_SENTINEL',speakers:{'0':'SPEAKER_SENTINEL'},prev_context:[{src:'PREVIOUS_SENTINEL',who:'Narrator'}],source_context:evidence};
const py=spawnSync('python',['-c',`
import json,sys
sys.path.insert(0,'api')
from backend.ai.prompts.styles import select_style
from backend.ai.prompts.builder import build_translator_identity_system,build_translation_user_message
from backend.ai.prompts.layout import prompt_layout
from backend.application.ai_translation.request_validation import build_config
from backend.jobs.cache import build_cache_key
rows,base=json.load(sys.stdin)
out=[]
for r in rows:
 lang=r['lang']; fmt=r['format']; examples=r['examples']; mode=r['mode']; custom='USER_STYLE_SENTINEL' if r['custom'] else ''
 source='P0:SOURCE😀' if fmt else '<<TP_P0:SOURCE😀>>'
 style,_=select_style(lang,custom)
 system=build_translator_identity_system(style,lang)
 user=build_translation_user_message(lang,custom,source,['P0'],structured_output=fmt,source_lang='en',style_examples=examples,memory_mode=mode,glossary=base['glossary'],characters=base['characters'],series_state=base['series_state'],speakers=base['speakers'],prev_context=base['prev_context'],source_context=base['source_context'],has_image=True,repair_reason='wrong_target_script')
 layout=prompt_layout(system,user,lang=lang,source_lang='en',structured=fmt,examples=examples,memory_mode=mode,selected_style=style)
 cfg=build_config({'provider':{'id':'ollama'},'memory':{'mode':mode,'styleExamples':examples}})
 out.append({'system':system,'user':user,'layout':layout,'examplesConfig':cfg.style_examples,'modeConfig':cfg.memory_mode,'cacheKey':build_cache_key('same','th','text.ai','ai',cfg)})
print(json.dumps(out,ensure_ascii=False))
`],{cwd:root,input:JSON.stringify([rows,aiBase]),encoding:'utf8',maxBuffer:20*1024*1024});
assert.equal(py.status,0,py.stderr);
const expected=JSON.parse(py.stdout);const keys=new Set();
for(let i=0;i<rows.length;i++) {
 const r=rows[i], ai={...aiBase,style_examples:r.examples,memory_mode:r.mode,prompt:r.custom?'USER_STYLE_SENTINEL':''},kind=r.format?'schema_object':'compact_records';
 const composed=composeCanonicalPrompt(plans[r.lang],ai,true,r.format,r.lang);
 const system=composeTranslatorIdentitySystem(`${composed.sections.language}\n${composed.sections.style}`,r.lang);
 const source=r.format?'P0:SOURCE😀':'<<TP_P0:SOURCE😀>>';
 const user=composeTranslationUserMessage({sections:composed.sections,requestOutputContract:exactOutputInstruction(['P0'],{kind},r.lang),sourceRecords:source,targetLang:r.lang,sourceLang:'en',expectedIds:['P0'],structuredOutput:r.format,repairReason:'wrong_target_script'});
 const label=JSON.stringify(r);
 assert.equal(system,expected[i].system,label+' system');assert.equal(user,expected[i].user,label+' user');
 const layout=await promptLayout(system,user,{targetLang:r.lang,sourceLang:'en',structured:r.format,examples:r.examples,memoryMode:r.mode,selectedStyle:`${composed.sections.language}\n${composed.sections.style}`});
 assert.deepEqual(layout,expected[i].layout,label+' layout');
 assert.equal(user.includes('STORY_SENTINEL'),r.mode==='full');assert.equal(user.includes('CHAR_SENTINEL'),r.mode==='full');assert.equal(user.includes('SPEAKER_SENTINEL'),r.mode==='full');assert.equal(user.includes('PREVIOUS_SENTINEL'),r.mode==='full');assert.equal(user.includes('TERM_SENTINEL'),r.mode!=='off');
 assert.equal(user.includes('NEARBY_SOURCE'),true,'source context is not story memory');
 assert.equal(layout.examplesEnabled,r.examples);assert.equal(expected[i].examplesConfig,r.examples);assert.equal(expected[i].modeConfig,r.mode);
 assert.equal(layout.examplesIncluded,r.examples&&r.lang!=='fr');
 const prefix=buildStaticUserPrefix(r.lang,'en',r.format,r.examples,`${composed.sections.language}\n${composed.sections.style}`);assert.ok(user.startsWith(prefix+'\n\n'));assert.ok(user.endsWith(instructionPack(r.lang).sourceHeading+'\n'+source));
 const input=createPromptInputEstimator({ai,targetLang:r.lang,sourceLang:'en',image:true,contract:kind});
 const units=[{id:'P0',text:'SOURCE😀'}];const est=estimateRequest(units,initialProfile(),{contract:kind,limits:{},fixedInput:0,estimateFixedInput:units=>input(units,units,evidence),reasoningActive:false});
 const actual=textWeight(system)+textWeight(user)+2048+(r.format?textWeight(JSON.stringify(translationObjectSchema(['P0']))):0);
 assert.ok(est.estimatedInput>=actual,label+' budget covers composed prompt '+est.estimatedInput+' vs '+actual);
 keys.add(expected[i].cacheKey);
}
assert.equal(keys.size,6,'API result cache distinguishes examples and memory modes');
for(const lang of ['th','en','ja'])for(const format of [false,true]) {
 const examples=buildStyleExamples(lang,['P0'],format,'en');
 assert.equal(examples,buildStyleExamples(lang,Array.from({length:2000},(_,i)=>`P${i}`),format,'en'));
 assert.equal(examples,buildStyleExamples(lang,['P1000000'],format,'en'),'human examples never allocate TP IDs');
 assert.match(examples,/H01\nEN: /);assert.match(examples,/\nJA: /);assert.match(examples,/\nTH: /);
 assert.doesNotMatch(examples,/<<TP_P1000000|P1000000:/);
}
console.log(`PASS ${rows.length} localized System/User + layout byte-parity cases, independent modes, human parallel examples, custom style, fallback target, context, budget and cache identity.`);
