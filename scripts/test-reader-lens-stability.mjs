import assert from 'node:assert/strict';
import {isStageBackpressure} from '../src/background/jobs/stage-backpressure.js';
import {classifyJobError} from '../src/background/images.js';

const stale={status:503,retryable:true,code:'lens_session_unavailable',
  tpError:{code:'lens_session_unavailable',retryable:true}};
assert.equal(isStageBackpressure(stale),false,
  'the same rejected Lens jar must not requeue a page forever');
assert.deepEqual(classifyJobError(stale),{permanent:true,manualRetry:true});
assert.equal(isStageBackpressure({status:503,retryable:true,code:'server_busy'}),true,
  'real server admission backpressure still waits for capacity');
assert.equal(isStageBackpressure({status:503,retryable:true,code:'API_5XX'}),true,
  'transient server faults still retry');
console.log('PASS rejected Lens session terminates only its image; capacity retries continue');
