import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {webcrypto} from 'node:crypto';

globalThis.crypto ||= webcrypto;
const {translateLensPage}=await import('../src/background/pipeline/page-translation.js');
const {createRepairCoordinator}=await import('../src/background/repair/coordinator.js');
const {createTranslationSessionStore}=await import('../src/background/translation-session-store.js');
const {createDispatchJournal}=await import('../src/background/repair/dispatch-journal.js');
const {createPreparedPageJournal}=await import('../src/background/repair/prepared-page-journal.js');
const {ensureBatch}=await import('../src/background/batches.js');
const {translationUnits}=await import('../src/shared/lens-document.js');

function memory() {
  const value={};
  return {
    async get(key) { return key == null ? structuredClone(value) : {[key]:structuredClone(value[key])}; },
    async set(patch) { Object.assign(value,structuredClone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys)?keys:[keys]) delete value[key]; },
  };
}
function ledger() {
  const child=spawn(process.env.TP_TEST_PYTHON || 'python',['-u','scripts/repair-ledger-fixture.py'],
    {cwd:new URL('..',import.meta.url),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','inherit']});
  const queue=[];
  createInterface({input:child.stdout}).on('line',line=>{
    const next=queue.shift(),response=JSON.parse(line);
    response.ok ? next.resolve(response.value) : next.reject(Object.assign(new Error(response.code),response));
  });
  return {
    api(run,action='',body,options={}) {
      return new Promise((resolve,reject)=>{
        queue.push({resolve,reject});
        child.stdin.write(JSON.stringify({run,action:options.method==='DELETE'?'delete':action,body})+'\n');
      });
    },
    close() {child.stdin.end();},
  };
}
const document={schema:'tp.lens-document/1',image:{width:100,height:100},
  languages:{source:'ja',target:'th'},
  paragraphs:Array.from({length:16},(_,i)=>({id:`p${i}`,sourceText:`こんにちは ${i}`,items:[]}))};
const units=translationUnits(document);
assert.equal(units.length,16);

for (const [name,outcomes,acceptedCount,translationMode] of [
  ['first chunk empty',['empty'],0,'independent'],
  ['reasoning only first chunk',['reasoning-only'],0,'independent'],
  ['accepted first chunk',['accepted','empty'],6,'independent'],
  ['conversation accepted first chunk',['accepted','empty'],6,'conversation'],
  ['malformed first chunk',['malformed','empty'],0,'independent'],
  ['wrong language first chunk',['wrong-language','empty'],0,'independent'],
  ['conversation receipt first chunk empty',['empty'],0,'conversation'],
]) {
  const bridge=ledger();
  try {
    const area=memory(),sessions=createTranslationSessionStore({area:()=>area});
    const dispatchJournal=createDispatchJournal({area:()=>area});
    const preparedPages=createPreparedPageJournal({area:()=>area});
    const batch=ensureBatch(`terminal-empty-${name}`,72300+acceptedCount+outcomes.length,0);
    const jobId=`terminal-job-${name.replaceAll(' ','-')}`;
    const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',
      src:`http://fixture.invalid/${encodeURIComponent(name)}.png`,metadata:{image_id:'p'},context:{}};
    const result={lensDocument:structuredClone(document),eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}};
    const ai={provider:'ollama',model:'fixture',thinking:'off',style_examples:false,
      translation_mode:translationMode,model_capabilities:{reasoning:{supported:false},
        limits:{contextTokens:16384,maxOutputTokens:1024}}};
    const ctx={jobId,imageKey:'p',tabId:batch.tabId,frameId:0,imgUrl:payload.src,
      mode:'lens_text',source:'ai',sessionId:'fixture-session',settingsEpoch:7};
    batch.items.set('p',{attempt:1,status:'queued',phase:'waiting',payload});
    const reports=[],snapshots=[],actions=[],providerCalls=[];let repairExecutorCalls=0;
    const api=async (...args)=>{
      const action=args[3]?.method==='DELETE'?'DELETE':args[1]||'GET';
      actions.push(action);
      if(action==='pages') reports.push(...(args[2].pages || [args[2]]));
      const response=await bridge.api(...args);
      if(action==='seal') snapshots.push(response);
      return response;
    };
    const coordinator=createRepairCoordinator({sessions,api,getBase:async()=> 'http://fixture.invalid',
      currentEpoch:()=>7,currentSession:()=> 'fixture-session',getContext:id=>id===jobId?ctx:null,
      getCapabilitiesFor:async()=>({}),refreshLocalAiCapabilities:async current=>current,
      dispatchJournal,preparedPages,
      insert:async()=>({ok:true,applied:true}),emit:()=>{},
      execute:async()=>{repairExecutorCalls++;return {phase:'done',failedUnits:0,repaired:0,unresolved:0};}});
    const run=await coordinator.registerBatch(batch,[payload]);
    assert.ok(run);
    const controller={open:async()=>({key:'fixture-workload',ai,
      next:(all,offset)=>{const selected=all.slice(offset,offset+6);
        return {units:selected,estimate:{limits:{source:'fixture'},target:529,
          sourceChars:selected.reduce((n,u)=>n+u.text.length,0),predictedOutput:529,
          completionAvailable:529,revision:1},splitReason:'fixture_six'};},
      observe:({error})=>({outcome:error?.code==='invalid_model_output'?'structure':'length',
        usage:error?.generationMeta?.usage || {}}),
      flush:async()=>{}})};
    const traces=[];
    const translation=translateLensPage({base:'http://fixture.invalid',payload,result,
      plan:{route:'direct-local',ai},jobId,cancelBatchId:batch.id,trace:(event,data)=>traces.push({event,data}),
      onCheckpoint:data=>coordinator.capture(batch.id,data),
      dependencies:{workloadController:controller,refreshLocalAiCapabilities:async current=>current,
        translateUnits:async selected=>{
          providerCalls.push(selected.map(row=>row.id));
          const outcome=outcomes[providerCalls.length-1];
          if(outcome==='accepted') return {translations:selected.map(row=>({id:row.id,text:'คำแปล'})),
            missing:[],meta:{generationAttempts:1,providerAttempts:1,usage:{inputTokens:100,outputTokens:50}}};
          if(outcome==='wrong-language') return {translations:selected.map(row=>({id:row.id,text:'原文のまま'})),
            missing:[],meta:{generationAttempts:1,providerAttempts:1,usage:{inputTokens:100,outputTokens:50}}};
          if(outcome==='malformed') throw Object.assign(new Error('malformed result'),{
            code:'invalid_model_output',requestDispatched:true,providerResponded:true,
            generationAttempts:1,providerAttempts:1});
          if(outcome==='empty' || outcome==='reasoning-only')
            throw Object.assign(new Error('output limit: zero visible bytes'),{
            code:'output_budget_exhausted',requestDispatched:true,providerResponded:true,
            generationAttempts:1,providerAttempts:1,
            diagnostics:{validatorSubtype:outcome==='reasoning-only'?'reasoning_only_exhausted':'empty_output'},
            generationMeta:{model:'fixture',finishReason:'length',requestedOutputTokens:529,
              usage:{source:'provider',inputTokens:2105,outputTokens:529,totalTokens:2634,thinkingTokens:null}}});
          assert.fail(`unexpected provider dispatch ${providerCalls.length}`);
        },
        diagnoseTargetScripts:translations=>translations.filter(row=>row.text==='原文のまま')
          .map(row=>({id:row.id,decision:'reject'})),
      }});
    const expectedSubtype=outcomes.includes('reasoning-only')?'reasoning_only_exhausted':'empty_output';
    await assert.rejects(translation,error=>error.code==='output_budget_exhausted' &&
      error.diagnostics?.validatorSubtype===expectedSubtype && error.generationMeta?.usage?.outputTokens===529);
    assert.equal(providerCalls.length,outcomes.length);
    assert.equal(providerCalls[0].length,6,'16 requested units must split into the first 6');
    assert.equal(repairExecutorCalls,0,'repair only starts at the batch barrier');
    const current=(await sessions.get(run.id)).pages.p;
    const accepted=current?.accepted || (await dispatchJournal.get(run.id,'p'))?.accepted || [];
    assert.equal(accepted.length,acceptedCount,'accepted prior chunks remain checkpointed');
    assert.ok(traces.some(entry=>entry.event==='translationResult' && entry.data.actualOutput===529),
      'provider usage remains visible on the failed generation');
    await coordinator.finishInitial(batch);
    assert.equal(reports.length,1);
    assert.equal(reports[0].initialAccepted,acceptedCount);
    assert.equal(reports[0].unverified,16-acceptedCount);
    assert.deepEqual(reports[0].failed,[],
      'terminal zero-visible failure must not turn unsent units or earlier failures into repair requests');
    assert.equal(snapshots.length,1,JSON.stringify({actions,
      phase:(await sessions.get(run.id))?.phase,lastError:(await sessions.get(run.id))?.lastError}));
    assert.equal(snapshots[0].phase,'done','actual repair ledger must not plan provider work');
    assert.equal(repairExecutorCalls,0,'no same-model generation may start after the barrier');
    assert.equal(actions.includes('claim'),false);
    console.log(`PASS ${name}: initial ${providerCalls.length} call(s), accepted ${acceptedCount}, blocked ${16-acceptedCount}, repair 0`);
  } finally {
    bridge.close();
  }
}
console.log('PASS terminal empty output across page checkpoint, coordinator, and actual repair ledger.');
