import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {diagnoseTargetScripts,dominantWrongTargetIds} from '../src/background/ai/script-diagnostics.js';
import {runContentValidatedTranslation} from '../src/shared/ai-content-repair.js';

const fixture=JSON.parse(await readFile(new URL('./fixtures/source-equivalent-credit-10449.json',import.meta.url),'utf8'));
const failures=[],checks=[];
async function check(name,fn){try{await fn();checks.push(name);}catch(error){failures.push({name,message:error.message});}}
await check('Owned bounded credit accepts only case/spacing variation for Thai and Korean',()=>{
 for(const lang of ['th','ko'])for(const row of fixture.accept){
  const [d]=diagnoseTargetScripts([{id:'owned-original',text:row.output}],lang,[{id:'owned-original',text:row.source}]);
  assert.equal(d.decision,'accept');assert.equal(d.reason,'preserved_identifier');assert.equal(d.id,'owned-original');
 }
});
await check('Changed content, owner, plus count, suffix, scripts and English prose stay rejected',()=>{
 for(const lang of ['th','ko'])for(const row of fixture.reject){
  assert.deepEqual(dominantWrongTargetIds([{id:'owned-original',text:row.output}],lang,[{id:'owned-original',text:row.source}]),['owned-original']);
 }
 assert.deepEqual(dominantWrongTargetIds([{id:'foreign-row',text:'Kumo Translation'}],'th',[{id:'owned-row',text:'KUMO TRANSLATION'}]),['foreign-row']);
});
await check('Actual initial content-validation path keeps text and ID without spending repair',async()=>{
 const units=[{id:'owned-original',text:'KUMO TRANSLATION'}];let calls=0;
 const result=await runContentValidatedTranslation({units,operationBase:'fictional-credit-operation',repair:{enabled:true},
  translate:async()=>{calls++;return {translations:[{id:'owned-original',text:'Kumo Translation'}],meta:{generationAttempts:1,providerAttempts:1}};},
  contentDefects:answer=>{const wrongLanguage=dominantWrongTargetIds(answer.translations,'th',units);return {missing:[],wrongLanguage,invalid:wrongLanguage.length>0};},
 });
 assert.equal(calls,1);assert.deepEqual(result.outcome.translations,[{id:'owned-original',text:'Kumo Translation'}]);
 assert.equal(result.repairAttempted,false);assert.equal(result.outcome.meta.generationAttempts,1);
});
console.log(JSON.stringify({passed:failures.length===0,count:checks.length,checks,failures,scope:'Actual source-aware validator and bounded content repair; synthetic translation only'}));
if(failures.length)process.exitCode=1;
