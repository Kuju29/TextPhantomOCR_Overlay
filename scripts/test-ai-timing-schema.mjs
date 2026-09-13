import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../src/shared/diagnostic-schema.js';

const events = [
  {schema:'tp.audit/1',event:'usage_commit_timing',reason:'success',timing:{usageCallbackMs:45,callbackMs:4,persistMs:40}},
  {schema:'tp.audit/1',event:'request_timing',reason:'body_failed',timing:{httpMs:45,bodyMs:4}},
  {schema:'tp.audit/1',event:'request_timing',reason:'response_complete',route:'direct-local',
    timing:{requestSetupMs:1,headersMs:2,headersToFirstByteMs:3,headersToFirstContentMs:4,contentToTerminalMs:null}},
  {schema:'tp.audit/1',event:'pre_provider_timing',batchIndex:0,
    timing:{fingerprintMs:1.125,workloadOpenMs:2,checkpointPreparedMs:3,
      checkpointDispatchMs:4,pageTranslationToTransportHandoffMs:10}},
  ...['prepared','dispatch','progress','finished'].map(reason => ({
    schema:'tp.audit/1',event:'checkpoint_timing',reason,
    scope:{imageId:'g1'},timing:{checkpointMs:5},counts:{failed:0}})),
  {schema:'tp.audit/1',event:'usage_commit_timing',reason:'success',
    timing:{queueMs:1,lockMs:2,readMs:3,computeMs:0.5,writeMs:4,persistMs:10.5,batchSize:1}},
  {schema:'tp.audit/1',event:'usage_commit_timing',reason:'failed',timing:{persistMs:5}},
];
const sanitized = events.map(event => globalThis.TPAuditSchema.sanitize(event));
assert.deepEqual(sanitized,events,'all timing fields must survive browser filtering');
const api = spawnSync('python3',['-c',
  'import json,sys; from backend.diagnostic_schema import sanitize_audit; print(json.dumps([sanitize_audit(v) for v in json.load(sys.stdin)]))'],
  {cwd:fileURLToPath(new URL('../api/',import.meta.url)),input:JSON.stringify(sanitized),encoding:'utf8'});
assert.equal(api.status,0,api.stderr);
assert.deepEqual(JSON.parse(api.stdout),events,'all timing fields must also survive API filtering');
const privateEvent = {...events[0],api_key:'secret',prompt:'private',timing:{...events[0].timing,rawText:'private'}};
assert.deepEqual(globalThis.TPAuditSchema.sanitize(privateEvent),events[0],'do not broaden content/credential logging');
console.log('PASS: timing events survive both browser and API; private fields remain excluded');
