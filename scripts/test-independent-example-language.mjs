import assert from 'node:assert/strict';
import {suitableIndependentExample} from '../src/shared/ai/independent/examples.js';
import {verifiedIndependentPairs,createIndependentExampleStore} from '../src/background/ai/independent-example-store.js';
const rows=[
 {src:'SO... NO ONE HAS FOUND OUT YET?',tgt:'เอ่อ... ยังไม่มีใครพบ out ก็แค่นั้น?'},
 {src:'His Highness wishes a word.',tgt:'Your Highness ต้องการพูดด้วย'},
 {src:'WHAT DO YOU EXPECT ME TO DO?!',tgt:'คิดว่าจะให้ทำยังไงล่ะ?!'},
 {src:'A proper name.',tgt:'ชู เกย์เกตсу'},
];
assert.deepEqual(rows.map(x=>suitableIndependentExample(x.tgt,'th')),[false,false,true,false]);
const source=rows.map((row,i)=>({id:`P${i}`,text:row.src}));
const answer={translations:rows.map((row,i)=>({id:`P${i}`,text:row.tgt}))};
assert.deepEqual(verifiedIndependentPairs(source,answer,{},'th'),[rows[2]]);
// The original displayed output is not touched by stricter sample eligibility.
assert.equal(answer.translations.length,4); assert.equal(answer.translations[0].text,rows[0].tgt);
assert.equal(suitableIndependentExample('こんにちは、太郎。','ja'),true);
assert.equal(suitableIndependentExample('hello、太郎。','ja'),false);
assert.equal(suitableIndependentExample('บทที่ 23: เรย์ริน','th'),true);
// Already-saved contaminated examples from .20 are filtered during selection,
// without resetting the profile, deleting data, or re-translating any page.
let data={}; const store=createIndependentExampleStore({read:async()=>data,write:async patch=>Object.assign(data,patch),now:()=>10});
const scope={key:'test',scopeStatus:'document'};
await store.append(scope,rows);
const selected=await store.select(scope,'th',true);
assert.deepEqual(selected.pairs,[rows[2]]); assert.equal(selected.acceptedPairs,1);
assert.equal((await store.select(scope,'th',false)).source,'none');
console.log('Independent examples: mixed-script contamination rejected at learn and read; display preserved');
