import assert from 'node:assert/strict';import fs from 'node:fs';
import {initialProfile,takeWorkloadBatch} from '../src/shared/ai/workload/model.js';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/workload39-packing.json',import.meta.url)));
for(const raw of fixture.cases){const c={...raw,units:raw.units.map(u=>({id:u.id,text:u.pattern.repeat(u.repeats)}))};let offset=0,actual=[];const p={...initialProfile(1),...c.profile};
 while(offset<c.units.length){let out;try{out=takeWorkloadBatch(c.units,offset,p,c.context);}catch(e){assert.equal(e.code,'ai_workload_budget_insufficient');break;}
  actual.push(out.units.length);offset+=out.units.length;
 }assert.deepEqual(actual,c.expected);
}
console.log(`PASS ${fixture.cases.length} portable .39 reference packing cases; no provider calls.`);
