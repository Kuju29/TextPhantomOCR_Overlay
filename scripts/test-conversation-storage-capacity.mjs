/** A large image can exceed browser history storage after a valid generation. */
import assert from 'node:assert/strict';
import {conversationTranslation} from '../src/background/ai/translation-paths/conversation.js';
import {localScope,withLocalHistory} from '../src/background/ai/translation-paths/local-history.js';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';

const rows=new Map();
let failNextCommit=false,failNextRead=false;
const db={
  createObjectStore(){},
  transaction(_table,mode){
    const tx={};const staged=new Map(),removed=new Set();
    const finish=()=>queueMicrotask(()=>{
      if(failNextCommit&&mode==='readwrite'){
        failNextCommit=false;tx.error=new Error('synthetic post-provider commit failure');tx.onabort?.();return;
      }
      if(mode==='readwrite'){
        for(const key of removed)rows.delete(key);
        for(const [key,value] of staged)rows.set(key,structuredClone(value));
      }
      tx.oncomplete?.();
    });
    const request=work=>{
      const q={};queueMicrotask(()=>{
        if(failNextRead&&mode==='readonly'){
          failNextRead=false;tx.error=new Error('synthetic history read failure');tx.onabort?.();return;
        }
        q.result=structuredClone(work());q.onsuccess?.();finish();
      });
      return q;
    };
    tx.objectStore=()=>({
      get:key=>request(()=>rows.get(key)),
      count:()=>request(()=>rows.size),
      getAll:()=>{throw new Error('bulk history scan is forbidden');},
      put:value=>{staged.set(value.scope,structuredClone(value));},
      delete:key=>{removed.add(key);},
    });
    return tx;
  },
};
const oldIndexedDB=globalThis.indexedDB;
globalThis.indexedDB={open(){const q={};queueMicrotask(()=>{q.result=db;q.onsuccess?.();});return q;}};
const bigImage='data:image/png;base64,'+Buffer.alloc(780000).toString('base64');
let calls=0;
const base={provider:'ollama',model:'fixture-model',base_url:'http://127.0.0.1:11434',
  thinking:'off',style_examples:false,model_capabilities:{limits:{contextTokens:65536}},
  conversation:{owner:'first-owner',documentId:'first-document'}};

async function send(ai,page,image='',signal=null,afterGenerate=null,wireTrace=null,trace=null,
    sourceText=`source ${page}`){
  const id=`I${page}_P0`;
  const config={...ai,conversation:{...ai.conversation,origins:[{
    pageId:`page-${page}`,pageIndex:page-1,pageOrder:page,
    unitIds:[id],originalIds:[`g${page}`],
  }]}};
  return conversationTranslation(async(_units,{conversationContext})=>{
    await conversationContext.prepare({layout:{userStaticChars:6,userPersistentStaticChars:6,
      instructionLocale:'th',bootstrapExamplesChars:0},system:'SYSTEM',
      user:`STATIC\n\n<<${id}:${sourceText}>>`,schema:null,imageDataUri:image,
      outputReserve:128,executedModel:ai.model,
      protocol:ai.provider==='lmstudio'?'lmstudio_native':'ollama',selectedContract:'marker'});
    calls++;
    conversationContext.capture(`<<${id}:คำแปล>>`,ai.provider==='lmstudio'?`resp_${calls}`:undefined);
    afterGenerate?.();
    return {translations:[{id,text:'คำแปล'}],meta:{terminalCompleted:true,
      usage:{inputTokens:123,outputTokens:10},generationAttempts:1,providerAttempts:1}};
  },[{id,text:sourceText}],{route:'direct-local',ai:config,targetLang:'th',sourceLang:'en',signal,
    wireTrace,trace});
}

try {
  const first=await send(base,1);
  assert.equal(first.meta.conversation.commitStatus,'committed');
  const acceptedScope=await localScope(base,'th','en');
  const earlier=structuredClone(rows.get(acceptedScope));
  const second=await send(base,2,bigImage);
  assert.equal(second.translations[0].text,'คำแปล','first large-image result remains visible');
  assert.equal(second.meta.conversation.commitStatus,'history_storage_limit');
  assert.equal(calls,2);
  assert.deepEqual(rows.get(acceptedScope).history,earlier.history,
    'marking capacity must preserve earlier committed turn bytes');
  await assert.rejects(send(base,3),error=>error.code==='ai_conversation_history_capacity'&&
    error.requestDispatched===false&&error.providerAttempts===0);
  assert.equal(calls,2,'same-scope follow-up must stop before provider dispatch');

  const fresh=await import('../src/background/ai/translation-paths/local-history.js?storage-capacity-restart');
  await assert.rejects(fresh.withLocalHistory(base,'th','en',null,()=>{}),
    error=>error.code==='ai_conversation_history_capacity'&&error.requestDispatched===false,
    'persisted capacity fence survives a fresh worker module');

  const anotherDocument={...base,conversation:{...base.conversation,documentId:'new-document'}};
  const isolated=await send(anotherDocument,1);
  assert.equal(isolated.meta.conversation.commitStatus,'committed');
  const otherProvider={...base,provider:'jan',conversation:{...base.conversation}};
  assert.equal((await send(otherProvider,1)).meta.conversation.commitStatus,'committed');
  assert.equal(calls,4,'document and provider scopes must not share a capacity fence');

  const failedCommit={...base,conversation:{...base.conversation,documentId:'failed-commit'}};
  assert.equal((await send(failedCommit,1)).meta.conversation.commitStatus,'committed');
  const faultScope=await localScope(failedCommit,'th','en');
  const beforeFault=structuredClone(rows.get(faultScope).history);
  const failedResult=await send(failedCommit,2,'',null,()=>{failNextCommit=true;});
  assert.equal(failedResult.translations[0].text,'คำแปล','provider answer survives post-provider storage failure');
  assert.equal(failedResult.meta.conversation.commitStatus,'not_committed_storage_unavailable');
  assert.deepEqual(rows.get(faultScope).history,beforeFault,'write-ahead retains previously accepted history');
  assert.equal(rows.get(faultScope).pending,'provider_result_uncommitted');
  const afterFaultCalls=calls;
  await assert.rejects(send(failedCommit,3),error=>error.code==='ai_conversation_storage_unavailable'&&
    error.requestDispatched===false&&error.providerAttempts===0&&error.generationAttempts===0);
  const restartedAfterFault=await import('../src/background/ai/translation-paths/local-history.js?failed-commit-restart');
  await assert.rejects(restartedAfterFault.withLocalHistory(failedCommit,'th','en',null,()=>{}),
    error=>error.code==='ai_conversation_state_pending'&&error.requestDispatched===false&&
      error.providerAttempts===0&&error.generationAttempts===0,
    'fresh worker cannot regenerate from stale history after a failed answer commit');
  assert.equal(calls,afterFaultCalls);

  const unavailableRead={...base,conversation:{...base.conversation,documentId:'unavailable-read'}};
  failNextRead=true;
  await assert.rejects(send(unavailableRead,1),error=>error.code==='ai_conversation_storage_unavailable'&&
    error.requestDispatched===false&&error.providerAttempts===0&&error.generationAttempts===0);
  assert.equal(calls,afterFaultCalls,'history read failure must stop before provider dispatch');

  const unavailableBegin={...base,conversation:{...base.conversation,documentId:'unavailable-begin'}};
  failNextCommit=true;
  await assert.rejects(send(unavailableBegin,1),error=>error.code==='ai_conversation_storage_unavailable'&&
    error.requestDispatched===false&&error.providerAttempts===0&&error.generationAttempts===0);
  assert.equal(calls,afterFaultCalls,'write-ahead failure must stop before provider dispatch');

  const traceFailure={...base,conversation:{...base.conversation,documentId:'trace-failure'}};
  assert.equal((await send(traceFailure,1)).meta.conversation.commitStatus,'committed');
  const failedTraceResult=await send(traceFailure,2,'',null,()=>{failNextCommit=true;},
    async()=>{throw new Error('synthetic timing trace failure');});
  assert.equal(failedTraceResult.meta.conversation.commitStatus,'not_committed_storage_unavailable');
  const traceScope=await localScope(traceFailure,'th','en');
  assert.equal(rows.get(traceScope).pending,'provider_result_uncommitted',
    'a trace failure after failed answer commit cannot erase its durable fence');
  const traceRestart=await import('../src/background/ai/translation-paths/local-history.js?trace-failure-restart');
  await assert.rejects(traceRestart.withLocalHistory(traceFailure,'th','en',null,()=>{}),
    error=>error.code==='ai_conversation_state_pending');

  const traceSuccess={...base,conversation:{...base.conversation,documentId:'trace-success'}};
  const successfulDespiteTrace=await send(traceSuccess,1,'',null,null,
    async()=>{throw new Error('synthetic timing trace failure');},
    (_name,evidence)=>{if(evidence.phase==='finished')throw new Error('synthetic final trace failure');});
  assert.equal(successfulDespiteTrace.meta.conversation.commitStatus,'committed',
    'a diagnostic hook failure cannot turn a durable translation into failure');
  assert.equal(rows.get(await localScope(traceSuccess,'th','en')).history.length,1);

  const branchAi={...base,conversation:{...base.conversation,documentId:'branch-document'}};
  await send(branchAi,1);
  await send(branchAi,2);
  const branchScope=await localScope(branchAi,'th','en');
  const beforeBranch=structuredClone(rows.get(branchScope));
  await assert.rejects(send(branchAi,1,'',null,
    ()=>{throw new Error('synthetic edited-page provider failure');},null,null,'edited source 1'),
    error=>error.message==='synthetic edited-page provider failure');
  assert.deepEqual(rows.get(branchScope).history,beforeBranch.history,
    'failed branch generation must not erase accepted later turns');
  assert.equal(rows.get(branchScope).revision,beforeBranch.revision);
  assert.equal(rows.get(branchScope).pending,undefined);
  const acceptedBranch=await send(branchAi,1,'',null,null,null,null,'edited source 1');
  assert.equal(acceptedBranch.meta.conversation.commitStatus,'committed');
  assert.equal(acceptedBranch.meta.conversation.rolloverReason,'source_replayed');
  assert.equal(rows.get(branchScope).revision,beforeBranch.revision+1,
    'accepted branch and new answer commit in one revision');
  assert.equal(rows.get(branchScope).history.length,1,
    'accepted edited first page replaces its old branch in one transaction');

  const cancelled={...base,conversation:{...base.conversation,documentId:'cancel-document'}};
  const controller=new AbortController();controller.abort();
  await assert.rejects(send(cancelled,1,bigImage,controller.signal),error=>error.name==='AbortError');
  assert.equal((await send(cancelled,1)).meta.conversation.commitStatus,'committed',
    'pre-dispatch cancellation must not poison a new scope');

  const native={...base,provider:'lmstudio',model:'native-model',
    conversation:{...base.conversation,documentId:'native-document'}};
  const nativeFirst=await send(native,1,bigImage);
  assert.equal(nativeFirst.translations[0].text,'คำแปล');
  assert.equal(nativeFirst.meta.conversation.commitStatus,'history_storage_limit');
  await assert.rejects(send(native,2),error=>error.code==='ai_conversation_history_capacity'&&
    error.requestDispatched===false);

  // The production ready queue must project this valid LM Studio generation,
  // even though its provider cursor could not be saved for a later turn.
  for(const [route,status] of [['direct-local','history_storage_limit'],
    ['direct-local','not_committed_storage_unavailable'],['server','not_committed_storage_error']]) {
    const payload={source:'ai',lang:'th',context:{page_url:`${status}-queue`,tp_tab_session:'capacity-owner'},
      metadata:{image_id:'queue-page'},ai:{provider:'lmstudio',model:'fixture',translation_mode:'conversation'}};
    reserveConversationJob(payload,1);
    const q=createReadyQueue({choose:async units=>({units,estimate:{estimatedInput:20,predictedOutput:20}}),
      dispatch:async units=>({translations:units.map(unit=>({id:unit.id,text:'คำแปล'})),
        meta:{conversation:{commitStatus:status,historyTurns:0}}})});
    try {
      const page=await q.submit([{id:'P0',text:'Source'}],{
        payload,ai:payload.ai,imageId:'queue-page',targetLang:'th',sourceLang:'en',route,
      });
      assert.equal(page.translations[0].text,'คำแปล','queue keeps a valid native answer');
      assert.equal(page.meta.conversation.commitStatus,status);
    } finally {q.close();finishConversationJob(payload);}
  }
  for(const [route,status] of [['direct-local','not_committed_storage_error'],
    ['server','not_committed_storage_unavailable'],['server','not_committed_provider_cursor_missing']]) {
    const payload={source:'ai',lang:'th',context:{page_url:`rejected-${route}-${status}`,tp_tab_session:'capacity-owner'},
      metadata:{image_id:'queue-page'},ai:{provider:'lmstudio',model:'fixture',translation_mode:'conversation'}};
    reserveConversationJob(payload,1);
    const q=createReadyQueue({choose:async units=>({units,estimate:{estimatedInput:20,predictedOutput:20}}),
      dispatch:async units=>({translations:units.map(unit=>({id:unit.id,text:'คำแปล'})),
        meta:{conversation:{commitStatus:status,historyTurns:0}}})});
    try {
      await assert.rejects(q.submit([{id:'P0',text:'Source'}],{
        payload,ai:payload.ai,imageId:'queue-page',targetLang:'th',sourceLang:'en',route,
      }),error=>error.code==='ai_conversation_turn_not_committed');
    } finally {q.close();finishConversationJob(payload);}
  }

  while(rows.size<256){
    const filler={...base,conversation:{owner:'capacity-owner',documentId:`capacity-${rows.size}`}};
    await withLocalHistory(filler,'th','en',null,async state=>{
      await state.begin();
      await state.save({history:[],prefix:'',revision:1});
    });
  }
  assert.equal(rows.size,256);
  const atLimit={...base,conversation:{owner:'capacity-owner',documentId:'beyond-256'}};
  const beforeLimitCalls=calls;
  await assert.rejects(send(atLimit,1),error=>error.code==='ai_conversation_capacity'&&
    error.requestDispatched===false&&error.providerAttempts===0&&error.generationAttempts===0);
  assert.equal(calls,beforeLimitCalls,'session capacity must fail before provider dispatch');
  assert.equal(rows.size,256,'a new scope must not evict an accepted scope');
  assert.deepEqual(rows.get(faultScope).history,beforeFault);

  // Two independent worker modules can read the same committed revision before
  // either starts generation. The transaction that marks the request pending
  // must admit only one of them across the shared IndexedDB database.
  const raceRows=new Map();let writeTurn=Promise.resolve();
  const raceDb={createObjectStore(){},transaction(_table,mode){
    const tx={},staged=new Map();let predecessor=Promise.resolve(),release=()=>{};
    if(mode==='readwrite'){
      predecessor=writeTurn;
      writeTurn=new Promise(resolve=>{release=resolve;});
    }
    const request=work=>{
      const q={};predecessor.then(()=>queueMicrotask(()=>{
        q.result=structuredClone(work());q.onsuccess?.();
        queueMicrotask(()=>{
          if(mode==='readwrite')for(const [key,value] of staged)raceRows.set(key,structuredClone(value));
          tx.oncomplete?.();release();
        });
      }));return q;
    };
    tx.objectStore=()=>({get:key=>request(()=>raceRows.get(key)),
      count:()=>request(()=>raceRows.size),
      getAll:()=>{throw new Error('bulk history scan is forbidden');},
      put:value=>{staged.set(value.scope,structuredClone(value));}});
    return tx;
  }};
  globalThis.indexedDB={open(){const q={};queueMicrotask(()=>{q.result=raceDb;q.onsuccess?.();});return q;}};
  const [workerA,workerB]=await Promise.all([
    import('../src/background/ai/translation-paths/local-history.js?atomic-worker-a'),
    import('../src/background/ai/translation-paths/local-history.js?atomic-worker-b'),
  ]);
  const raceAi={...base,conversation:{owner:'race-owner',documentId:'race-document'}};
  await workerA.withLocalHistory(raceAi,'th','en',null,state=>state.save({
    history:[{user:'previous accepted',assistant:'ก่อนหน้า'}],prefix:'',revision:1}));
  const raceScope=await workerA.localScope(raceAi,'th','en');
  const priorRaceHistory=structuredClone(raceRows.get(raceScope).history);
  let readyCount=0,releaseReady;
  const readyBarrier=new Promise(resolve=>{releaseReady=resolve;});
  let raceProviderCalls=0;
  const raceWork=worker=>worker.withLocalHistory(raceAi,'th','en',null,async state=>{
    assert.equal(state.revision,1,'both workers must read the same prior revision');
    if(++readyCount===2)releaseReady();
    await readyBarrier;
    await state.begin();
    raceProviderCalls++;
    await state.save({history:[...state.history,{user:'new',assistant:'ใหม่'}],prefix:'',revision:2});
  });
  const raceResults=await Promise.allSettled([raceWork(workerA),raceWork(workerB)]);
  assert.equal(raceProviderCalls,1,'only one worker may reach the provider');
  assert.equal(raceResults.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(raceResults.filter(result=>result.status==='rejected').length,1);
  const rejectedRace=raceResults.find(result=>result.status==='rejected').reason;
  assert.equal(rejectedRace.code,'ai_conversation_state_conflict');
  assert.equal(rejectedRace.requestDispatched,false);
  assert.equal(rejectedRace.providerAttempts,0);
  assert.equal(rejectedRace.generationAttempts,0);
  assert.deepEqual(raceRows.get(raceScope).history[0],priorRaceHistory[0],
    'the accepted prior turn cannot be overwritten by the losing worker');
  assert.equal(raceRows.get(raceScope).history.length,2);
  await workerB.withLocalHistory(raceAi,'th','en',null,async stale=>{
    assert.equal(stale.revision,2);
    await workerA.withLocalHistory(raceAi,'th','en',null,async latest=>{
      await latest.begin();
      await latest.save({history:[...latest.history,{user:'newer',assistant:'ใหม่กว่า'}],
        prefix:'',revision:latest.revision+1});
    });
    await assert.rejects(stale.begin(),error=>error.code==='ai_conversation_state_conflict'&&
      error.requestDispatched===false&&error.providerAttempts===0&&error.generationAttempts===0,
      'a committed revision change between read and begin must reject stale work');
  });
  assert.equal(raceRows.get(raceScope).history.length,3);
  console.log('PASS Local Conversation capacity: write-ahead restart fence, atomic worker admission, 256 scopes, cancellation and route-specific native results');
} finally {globalThis.indexedDB=oldIndexedDB;}
