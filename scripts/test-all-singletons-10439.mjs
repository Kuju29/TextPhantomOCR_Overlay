import assert from 'node:assert/strict';
import {hasMeaningfulAiSource} from '../src/shared/ai-source-filter.js';
import {createTranslationService} from '../src/background/ai/translation-service.js';

let checked=0;
for(let point=0;point<=0x10ffff;point++) {
  if(point>=0xd800 && point<=0xdfff)continue;
  const text=String.fromCodePoint(point);
  assert.equal(hasMeaningfulAiSource(text),false,`Original single character U+${point.toString(16)} must skip`);
  checked++;
}
assert.equal(checked,1112064);
for(const text of ['ดี','มี','ที่','AB','漢字'])assert.equal(hasMeaningfulAiSource(text),true,text);
let providerCalls=0;
const service=createTranslationService({server:async()=>{providerCalls++;throw new Error('Singleton reached provider');}});
for(const translation_mode of ['independent','conversation']) {
  const units=['A','Z','ก','漢','क़','😀','-'].map((text,index)=>({id:`I1_P${index}`,text}));
  const result=await service(units,{route:'server',ai:{translation_mode}});
  assert.deepEqual(result.missing,[]);
  assert.deepEqual(result.meta.skippedUnitIds,units.map(unit=>unit.id));
  assert.equal(result.meta.generationAttempts,0);
  assert.equal(result.meta.providerAttempts,0);
}
assert.equal(providerCalls,0);
console.log(JSON.stringify({passed:true,singleUnicodeScalarsChecked:checked,thaiWordCharacters:Array.from('ดี').length,thaiWordEligible:hasMeaningfulAiSource('ดี'),providerCalls}));
