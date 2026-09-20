import assert from 'node:assert/strict';
import {createUsageViewController} from '../src/popup/controllers/usage-view-controller.js';
const field=()=>({style:{},textContent:'',title:''});
const els={aiProvider:{value:'provider'},aiModel:{value:'model'},aiUsageWrap:field(),aiUsageKind:field(),aiUsageModel:field(),aiUsageCounts:field()};
let reads=0,resolveRead,flushes=0;
const c=createUsageViewController({els,state:{},isLocalProvider:()=>false,storageKey:'usage',
 getStorage:()=>{reads++;return new Promise(r=>{resolveRead=r;});},
 flushUsage:async()=>{flushes++;},
 currentUsage:(ledger,target)=>({...target,requests:ledger?.requests||0,tokenStatus:'not_used'}),historyRows:()=>[]});
await c.refresh({requests:2});assert.equal(reads,0);assert.match(els.aiUsageCounts.textContent,/^Requests: 2$/m);
const stale=c.refresh();await Promise.resolve();assert.equal(reads,1);assert.equal(flushes,1);
await c.refresh({requests:3});resolveRead({usage:{requests:1}});await stale;
assert.match(els.aiUsageCounts.textContent,/^Requests: 3$/m,'older pending read cannot overwrite event snapshot');
await c.refresh(undefined);assert.equal(reads,1);assert.match(els.aiUsageCounts.textContent,/^Requests: 0$/m,'storage removal uses empty ledger without read');
const switched=c.refresh();await Promise.resolve();assert.equal(reads,2);assert.equal(flushes,2);els.aiModel.value='next';resolveRead({usage:{requests:9}});await switched;
assert.doesNotMatch(els.aiUsageCounts.textContent,/^Requests: 9$/m,'stale target cannot receive old ledger');
els.aiModel.value='model';
const passive=c.refreshPassive();assert.equal(reads,3);assert.equal(flushes,2);
resolveRead({usage:{requests:4}});await passive;assert.equal(flushes,2);
assert.match(els.aiUsageCounts.textContent,/^Requests: 4$/m,'passive usage refresh reads committed ledger without recovery flush');
console.log('PASS popup usage snapshots: zero redundant reads, deletion, stale read/target guards');
