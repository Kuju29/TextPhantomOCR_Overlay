import assert from 'node:assert/strict';
import {createAiProfileStorageWriter} from '../src/popup/controllers/ai-profile-storage-writer.js';
import {createAiProfileController} from '../src/popup/controllers/ai-profile-controller.js';
const pending=[], storage={}, seen=[];
const writer=createAiProfileStorageWriter(patch=>new Promise((resolve,reject)=>{
  seen.push(structuredClone(patch)); pending.push({apply:()=>{Object.assign(storage,patch);resolve();},reject});
}));
const first={aiProfilesV1:{active:{model:'A'}},aiThinking:'minimum'};
const a=writer(first); first.aiThinking='mutated after snapshot';
const b=writer({aiProfilesV1:{active:{model:'B'}},aiThinking:'off'});
const c=writer({aiProfilesV1:{active:{model:'B'}},aiThinking:'on'});
assert.equal(seen.length,1,'first write starts synchronously; later snapshots wait');
// An unrelated UI/usage patch is not serialized behind profile snapshots.
const unrelated = writer({unrelatedUiSetting:true});
assert.equal(seen.length,2,'non-profile write is dispatched while profiles are queued');
pending.splice(1,1)[0].apply(); await unrelated;
seen.splice(1,1);
pending.shift().apply(); await a; await new Promise(resolve=>setImmediate(resolve));
assert.equal(storage.aiThinking,'minimum'); assert.equal(seen.length,2);
pending.shift().apply(); await b; await new Promise(resolve=>setImmediate(resolve));
pending.shift().apply(); await c; await writer.whenIdle();
assert.equal(storage.aiThinking,'on'); assert.equal(storage.aiProfilesV1.active.model,'B');
// One failure must not block a newer selection forever.
const failed=writer({aiProfilesV1:{active:{model:'C'}}});
const failure=assert.rejects(failed,/fixture storage failure/);
const next=writer({aiProfilesV1:{active:{model:'D'}}});
pending.shift().reject(new Error('fixture storage failure')); await failure;
await new Promise(resolve=>setImmediate(resolve)); pending.shift().apply(); await next; await writer.whenIdle();
assert.equal(storage.aiProfilesV1.active.model,'D');
// Options and metadata use the very same writer as Provider transitions in the
// real popup. The obsolete Provider completion must not append a stale repair.
let defer=false; const holds=[], current={aiProvider:'anthropic',aiModel:'a',aiBaseUrl:'',lang:'th'};
const shared=createAiProfileStorageWriter(patch=>defer?new Promise(resolve=>holds.push(()=>{Object.assign(current,patch);resolve();})):Object.assign(current,structuredClone(patch)));
const val=value=>({value});
const els={aiProvider:val('anthropic'),aiModel:val('a'),aiBaseUrl:val(''),lang:val('th'),aiPrompt:val('')};
const state={desiredLang:'th',desiredAiModel:'a'};
const profile=createAiProfileController({els,state,setStorage:shared}); await profile.initialize(current);
defer=true;
const t1=profile.beginProviderTransition('openai'); els.aiProvider.value='openai';els.aiBaseUrl.value=t1.selected.endpoint;els.aiModel.value=t1.selected.model;
const p1=t1.commit();
const t2=profile.beginProviderTransition('anthropic');els.aiProvider.value='anthropic';els.aiBaseUrl.value=t2.selected.endpoint;els.aiModel.value=t2.selected.model;
const p2=t2.commit(); const option=profile.saveProfile({thinking:'off',memoryMode:'full'});
while(holds.length){holds.shift()(); await new Promise(resolve=>setImmediate(resolve));}
await Promise.all([p1,p2,option]);await shared.whenIdle();
assert.equal(current.aiProvider,'anthropic'); assert.equal(current.aiThinking,'off');assert.equal(current.aiMemoryMode,'full');
console.log('Profile snapshot ordering: model/provider/options/pagehide writes ordered; failed writes recover; non-profile work unblocked');
