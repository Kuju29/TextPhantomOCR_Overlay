import assert from 'node:assert/strict';
import {createUsageViewController} from '../src/popup/controllers/usage-view-controller.js';
const field=()=>({style:{},textContent:'',title:''});
const els={aiProvider:{value:'provider'},aiModel:{value:'model'},aiUsageWrap:field(),aiUsageKind:field(),aiUsageModel:field(),aiUsageCounts:field()};
let reads=0,resolveRead;
const c=createUsageViewController({els,state:{},isLocalProvider:()=>false,storageKey:'usage',
 getStorage:()=>{reads++;return new Promise(r=>{resolveRead=r;});},
 currentUsage:(ledger,target)=>({...target,requests:ledger?.requests||0,tokenStatus:'not_used'}),historyRows:()=>[]});
await c.refresh({requests:2});assert.equal(reads,0);assert.match(els.aiUsageCounts.textContent,/^2 requests/);
const stale=c.refresh();assert.equal(reads,1);
await c.refresh({requests:3});resolveRead({usage:{requests:1}});await stale;
assert.match(els.aiUsageCounts.textContent,/^3 requests/,'older pending read cannot overwrite event snapshot');
await c.refresh(undefined);assert.equal(reads,1);assert.match(els.aiUsageCounts.textContent,/^0 requests/,'storage removal uses empty ledger without read');
const switched=c.refresh();els.aiModel.value='next';resolveRead({usage:{requests:9}});await switched;
assert.doesNotMatch(els.aiUsageCounts.textContent,/^9 requests/,'stale target cannot receive old ledger');
console.log('PASS popup usage snapshots: zero redundant reads, deletion, stale read/target guards');
