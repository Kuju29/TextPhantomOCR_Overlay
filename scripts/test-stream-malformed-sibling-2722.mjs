import assert from 'node:assert/strict';
import {createStreamRecords} from '../src/background/ai/translation-paths/stream-records.js';
import {decodeTranslations} from '../src/shared/ai/direct-local/decode.js';
// A damaged physical line in the middle of a large multi-page response must
// agree with the terminal grammar. Duplicate/open/nested ambiguity stays bad.
const units=Array.from({length:286},(_,i)=>({id:`I${Math.floor(i/12)+2}_P${i%12}`,text:'source'}));
const malformed=51,provided=216;
const text=units.slice(0,provided).map((u,i)=>`<<${u.id}:คำแปล${i===malformed?'': '>>'}`).join('\n');
const expected=decodeTranslations(text,units,{compactMarkers:true,wireUnits:units});
for(const width of [1,2,3,7,43,4096]){
 const stream=createStreamRecords(units);
 for(let i=0;i<text.length;i+=width)stream.push(text.slice(i,i+width));stream.finish();
 assert.equal(stream.accepted.size,215,`chunk width ${width}`);
 assert.deepEqual([...stream.invalid],[units[malformed].id]);
 assert.deepEqual([...stream.accepted],expected.translations.filter(x=>x.text).map(x=>[x.id,x.text]));
}
console.log('PASS malformed sibling recovery: 286 requested / 215 accepted / 1 malformed / 70 omitted; six chunk boundaries, terminal parity');
