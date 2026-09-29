import assert from 'node:assert/strict';

const stored={};
let releaseFirstWrite=null,storageWrites=0;
globalThis.chrome={storage:{local:{
  get(defaults,callback){callback({...defaults,...stored});},
  set(patch,callback){
    storageWrites++;
    if (!releaseFirstWrite) {
      releaseFirstWrite=()=>{Object.assign(stored,patch);callback();};
      return;
    }
    Object.assign(stored,patch);callback();
  },
}}};
const payload={mode:'lens_text',source:'ai',
  ai:{provider:'lmstudio',model:'sample',base_url:'http://localhost:1234/v1',
    local_adapter:{protocol:'openai',baseUrl:'http://localhost:1234/v1'}},
  limits:{aiLocalCapacityMode:'auto'}};
const abort={code:'provider_protocol_error',generationAttempts:1,
  requestDispatched:true,providerResponded:true,
  diagnostics:{validatorSubtype:'provider_terminal_missing'}};
const first=await import('../src/background/scheduler.js?localRestart=first');
first.configureLocalCapacityForPayload(payload);
const key=first.laneKeyFor(payload);
await first.acquire(key);first.releaseSuccess(key,1000);
await Promise.all([first.acquire(key),first.acquire(key)]);
assert.equal(storageWrites,1,'the first capacity snapshot can remain pending');
assert.equal(first.releaseLocalFailure(key,abort),'rejected');
first.releaseFailed(key);
for (let n=0;n<5;n++) {
  await first.acquire(key);first.releaseSuccess(key,1000);
  assert.equal(first.describe(key).window,1);
}
assert.equal(storageWrites,1,'new snapshots cannot race ahead of a stalled write');
releaseFirstWrite();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(stored.aiConcurrencyLearningV1?.[key]?.localParallelStreamCooldown,true,
  'one-slot Local Auto cooldown is persisted before the worker restarts');
assert.equal(stored.aiConcurrencyLearningV1?.[key]?.localParallelStreamSuccesses,5,
  'completed cooldown samples survive the worker restart');

const restarted=await import('../src/background/scheduler.js?localRestart=second');
restarted.configureLocalCapacityForPayload(payload);
await restarted.acquire(key);
assert.equal(restarted.describe(key).window,1);
restarted.releaseSuccess(key,1000);
for (let n=6;n<12;n++) {
  assert.equal(restarted.describe(key).window,1,
    'restarted LM Studio Auto must not immediately repeat the parallel probe');
  await restarted.acquire(key);restarted.releaseSuccess(key,1000);
}
assert.equal(restarted.describe(key).window,2,
  'after twelve completed replies Auto can test recovered parallelism');
await new Promise(resolve=>setTimeout(resolve,0));
assert.notEqual(stored.aiConcurrencyLearningV1?.[key]?.localParallelStreamCooldown,true,
  'completed cooldown is cleared from durable learning');
console.log('PASS LM Studio Auto cooldown retains completed samples across worker restart and excludes HTTP 200 from rejection counts');
