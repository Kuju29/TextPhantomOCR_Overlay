import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import '../src/shared/diagnostic-schema.js';

const events = [
  {schema:'tp.audit/1',event:'page_visibility',reason:'changed',hidden:true,observedAt:123,visibilityChanges:2},
  {schema:'tp.audit/1',event:'render_timing',reason:'success',hiddenAtStart:false,hiddenAtFinish:true,
    timing:{readableSourceMs:1,canvasReadMs:2,erasePaintMs:3,encodeMs:4,backgroundMs:10,layoutMs:2,domApplyMs:1,renderMs:13,visibilityChanges:1}},

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
  {schema:'tp.audit/1',event:'image_source',
    scope:{runId:'00000000-0000-4000-8000-000000000001',pageId:'p8',imageId:'00000000-0000-4000-8000-000000000002'},
    imageHint:'scrambled',sourceRoute:'url_with_referer'},
  {schema:'tp.audit/1',event:'route_retry',scope:{pageId:'p8'},status:503,
    counts:{httpAttempts:1},timing:{pauseMs:250}},
  {schema:'tp.audit/1',event:'image_composition',scope:{pageId:'p8'},
    imageHint:'scrambled',compositionState:'complete',compositionKind:'tiles',
    compositionGrid:'5x5',compositionCode:'unknown',counts:{w:1200,h:1685}},
  {schema:'tp.audit/1',event:'image_composition',scope:{pageId:'p32'},
    imageHint:'scrambled',compositionState:'failed',compositionKind:'unknown',
    compositionGrid:'unknown',compositionCode:'metadata_missing',counts:{w:0,h:0}},
];
const sanitized = events.map(event => globalThis.TPAuditSchema.sanitize(event));
assert.deepEqual(sanitized,events,'all timing fields must survive browser filtering');
const api = spawnSync('python3',['-c',
  'import json,sys; from backend.diagnostic_schema import sanitize_audit; print(json.dumps([sanitize_audit(v) for v in json.load(sys.stdin)]))'],
  {cwd:fileURLToPath(new URL('../api/',import.meta.url)),input:JSON.stringify(sanitized),encoding:'utf8'});
assert.equal(api.status,0,api.stderr);
assert.deepEqual(JSON.parse(api.stdout),events,'all timing fields must also survive API filtering');
const privateBase = events.find(event => event.event === "usage_commit_timing");
const privateEvent = {...privateBase,api_key:'secret',prompt:'private',timing:{...privateBase.timing,rawText:'private'}};
assert.deepEqual(globalThis.TPAuditSchema.sanitize(privateEvent),privateBase,'do not broaden content/credential logging');
const leaked={...events.find(event=>event.event==='image_source'),
  scope:{runId:'page:https://example.test/?token=private'},
  imageHint:'https://private.test/',sourceUrl:'https://private.test/'};
const safe=globalThis.TPAuditSchema.sanitize(leaked);
assert.equal(safe.scope.runId,null);
assert.equal(safe.imageHint,'unknown');
assert.equal(safe.sourceUrl,undefined);
console.log('PASS: timing and image-source events survive browser and API; private fields remain excluded');
