/** Storage retirement and source-mask regression checks.
 * Run from any checkout: node scripts/test-storage-retirement-10455.mjs
 * TP_STORAGE_SOURCE optionally selects another checkout directory.
 * --baseline=44|52 requires TP_INSPECTION_ROOT and expects cleanup to fail.
 * --historical [--terminal-done] audits the same known immutable directories.
 * TP_STORAGE_REPORT optionally writes JSON outside the source tree.
 * Synthetic browser RAM only: no providers, accounts or native quota claims.
 */
import assert from 'node:assert/strict';
import {readFile,writeFile,access} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve,sep} from 'node:path';
globalThis.crypto ||= webcrypto;
const args=process.argv.slice(2);
const historical=args.includes('--historical'),requireCleanup=!historical;
const historicalDone=args.includes('--terminal-done');
const terminalPhase=requireCleanup||historicalDone?'done':'unavailable';
const baseline=args.find(value=>value.startsWith('--baseline='))?.split('=')[1];
assert(!baseline||['44','52'].includes(baseline),'Only immutable .44 or .52 baseline sources may be selected');
assert(args.every(value=>['--historical','--terminal-done','--require-cleanup'].includes(value)||/^--baseline=(44|52)$/.test(value)),'Unsupported storage test option');
assert(!(historical&&args.includes('--require-cleanup')),'Select historical audit or current cleanup acceptance');
assert(!(historical||baseline)||process.env.TP_INSPECTION_ROOT,'Historical sources require TP_INSPECTION_ROOT');
const directoryURL=value=>pathToFileURL(resolve(value)+sep);
const appRoot=process.env.TP_STORAGE_SOURCE?directoryURL(process.env.TP_STORAGE_SOURCE):new URL('../',import.meta.url);
const inspectionRoot=process.env.TP_INSPECTION_ROOT?directoryURL(process.env.TP_INSPECTION_ROOT):null;
const knownRoots=inspectionRoot?[
  ['44',new URL('v44/TextPhantom/',inspectionRoot)],['52',new URL('delivered52/TextPhantom/',inspectionRoot)],
]:[];
const versions=baseline?knownRoots.filter(([version])=>version===baseline):historical?knownRoots:[['current-checkout',appRoot]];
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const preparedPrefix='tpTranslationPreparedPageV1:',dispatchPrefix='tpTranslationDispatchV1:';
function memoryArea(initial={},hooks={}){
  const saved=structuredClone(initial);
  return {saved,area:{get:async keys=>{await hooks.get?.(keys,saved);return keys==null?structuredClone(saved):Object.fromEntries([].concat(keys).filter(key=>key in saved).map(key=>[key,structuredClone(saved[key])]))},
    set:async patch=>{await hooks.set?.(patch,saved);Object.assign(saved,structuredClone(patch));},
    remove:async keys=>{const list=[].concat(keys);await hooks.remove?.(list,saved);for(const key of list)delete saved[key];},
    getKeys:async()=>Object.keys(saved),setAccessLevel:async()=>{}},
    family(prefix){return Object.entries(saved).filter(([key])=>key.startsWith(prefix));}};
}
const outputs=[];
for(const [version,root] of versions){
  await access(new URL('src/background/translation-session-store.js',root));
  const load=relative=>import(new URL(relative,root));
  const storeModule=await load('src/background/translation-session-store.js');
  const preparedModule=await load('src/background/repair/prepared-page-journal.js');
  const dispatchModule=await load('src/background/repair/dispatch-journal.js');
  const pageModule=await load('src/background/repair/page-checkpoint.js');
  const clock=100_000_000,now=()=>clock;
  const sourcePage=id=>({pageId:id,generationId:'generation-'+id,phase:'prepared',delivered:false,
    units:[{id:'u1',text:'Synthetic source '+('x'.repeat(100_000)),translatable:true}],accepted:[],failures:[],blocked:[],inFlight:[],repaired:[]});
  const protectedValues={loginSessionId:'synthetic-opaque-handle',loginProviderViewCacheV1:{signedIn:true,models:[{id:'saved',name:'Last success'}]},
    popupApiDisplayV1:{base:'http://localhost:7860',online:true}};
  const expired={id:'expired-owner',createdAt:clock-6*60*60*1000-1,updatedAt:clock-100,phase:'collecting',pages:{}};
  const active={id:'active-owner',createdAt:clock,updatedAt:clock,phase:'collecting',pages:{}};
  const snapshot=memoryArea({...protectedValues,[storeModule.translationSessionRunKey(expired.id)]:{version:1,row:expired},[storeModule.translationSessionRunKey(active.id)]:{version:1,row:active}});
  const prepared=preparedModule.createPreparedPageJournal({area:()=>snapshot.area,now});
  const dispatch=dispatchModule.createDispatchJournal({area:()=>snapshot.area,now});
  for(const owner of [expired,active]){
    await prepared.record(owner.id,'page',sourcePage(owner.id));
    await dispatch.record(owner.id,'page',{operationId:'operation-'+owner.id,ids:['u1']});
  }
  const before=bytes(snapshot.saved);
  const store=storeModule.createTranslationSessionStore({area:()=>snapshot.area,now});
  assert.deepEqual((await store.list()).map(row=>row.id),[active.id]);
  assert(!(storeModule.translationSessionRunKey(expired.id) in snapshot.saved));
  const expiredPrepared=snapshot.family(preparedPrefix).filter(([,row])=>row.runId===expired.id);
  const expiredDispatch=snapshot.family(dispatchPrefix).filter(([,row])=>row.runId===expired.id);
  assert.equal(expiredPrepared.length,requireCleanup?0:1,'Expiry must retire journals only in the corrected implementation');
  assert.equal(expiredDispatch.length,requireCleanup?0:1,'Expiry must retire dispatch receipts only in the corrected implementation');
  for(const [key,value] of Object.entries(protectedValues))assert.deepEqual(snapshot.saved[key],value);
  assert(await prepared.get(active.id,'page'));assert(await dispatch.get(active.id,'page'));
  await storeModule.createTranslationSessionStore({area:()=>snapshot.area,now}).list();
  assert.equal(snapshot.family(preparedPrefix).length,requireCleanup?1:2,'Worker recovery must preserve the active source and must not revive an expired source');
  const expiration={beforeUtf8JsonBytes:before,afterUtf8JsonBytes:bytes(snapshot.saved),expiredOwnerRemoved:true,
    orphanPrepared:expiredPrepared.length,orphanDispatch:expiredDispatch.length,orphanUtf8JsonBytes:bytes(Object.fromEntries([...expiredPrepared,...expiredDispatch])),
    activeAndLoginUiValuesPreserved:true};

  const growing=memoryArea(protectedValues),bounded=storeModule.createTranslationSessionStore({area:()=>growing.area,now});
  const journal=preparedModule.createPreparedPageJournal({area:()=>growing.area,now}),receipts=dispatchModule.createDispatchJournal({area:()=>growing.area,now});
  const samples=[];
  for(let index=0;index<50;index++){
    const id='terminal-owner-'+index;
    await bounded.update(id,()=>({createdAt:clock,phase:'collecting',pages:{}}));
    await journal.record(id,'page',sourcePage(id));
    await receipts.record(id,'page',{operationId:'operation-'+index,ids:['u1']});
    await bounded.update(id,row=>({...row,phase:terminalPhase}));
    if([0,23,24,49].includes(index))samples.push({ownersCreated:index+1,visibleRuns:(await bounded.list()).length,
      preparedPages:growing.family(preparedPrefix).length,dispatchReceipts:growing.family(dispatchPrefix).length,utf8JsonBytes:bytes(growing.saved)});
  }
  const retained=new Set((await bounded.list()).map(row=>row.id));
  const orphans=[...growing.family(preparedPrefix),...growing.family(dispatchPrefix)].filter(([,row])=>!retained.has(row.runId));
  assert.equal(retained.size,24);assert.equal(growing.family(preparedPrefix).length,requireCleanup?24:50);assert.equal(orphans.length,requireCleanup?0:52);
  const prior=bytes(growing.saved);
  await storeModule.createTranslationSessionStore({area:()=>growing.area,now}).list();
  assert.equal(growing.family(preparedPrefix).length,requireCleanup?24:50);assert.equal(growing.family(dispatchPrefix).length,requireCleanup?24:50);
  const eviction={terminalPhase,runsCreated:50,runLimit:24,visibleRuns:retained.size,preparedPages:growing.family(preparedPrefix).length,dispatchReceipts:growing.family(dispatchPrefix).length,
    orphanKeys:orphans.length,orphanUtf8JsonBytes:bytes(Object.fromEntries(orphans)),beforeReloadUtf8JsonBytes:prior,
    afterReloadUtf8JsonBytes:bytes(growing.saved),samples};

  const fixture=JSON.parse(await readFile(new URL('scripts/fixtures/lens-display-recorded.json',root),'utf8'));
  const {decodeLensResponse}=await load('src/shared/lens-decode.js'),{translationUnits}=await load('src/shared/lens-document.js');
  const decoded=decodeLensResponse(fixture.lens,{...fixture.image,targetLang:'th',source:'ai'});
  const result={lensDocument:decoded.document,eraseBoxes:decoded.eraseBoxes,backgroundMode:'boxes',layout:{relayout_translated:false}};
  const units=translationUnits(decoded.document);
  const page=await pageModule.makePageCheckpoint({payload:{lang:'th',metadata:{image_id:'recorded'},context:{}},result,
    plan:{route:'cloud',ai:{provider:'synthetic',model:'synthetic',translation_mode:'conversation',prompt:'Synthetic style'}},units,ctx:{jobId:'recorded'},operationId:'operation-recorded'});
  if(requireCleanup)assert.equal(page.result.eraseBoxes,undefined,'Corrected representation must store the source mask once');
  else assert.deepEqual(page.result.eraseBoxes,page.originalEraseBoxes,'Historical source mask is serialized twice');
  assert.deepEqual(page.originalEraseBoxes,result.eraseBoxes,'The complete original source mask must remain recoverable');
  page.phase='finished';page.accepted=page.units.filter(unit=>unit.translatable).map(unit=>({id:unit.id,text:'คำแปลทดสอบ'}));
  assert.equal(pageModule.compactDeliveredPage(page),page,'Awaiting DOM ACK must retain recoverable source');
  const acceptedPage=pageModule.compactDeliveredPage({...page,delivered:true});
  assert.equal(acceptedPage.compacted,true);assert.equal(acceptedPage.units.length,0);
  const duplicated=structuredClone(page);duplicated.result.eraseBoxes=structuredClone(page.originalEraseBoxes);
  const deduplicated=structuredClone(page);delete deduplicated.result.eraseBoxes;
  const complete=pageModule.buildPatchedResult(deduplicated,[]);
  assert.deepEqual(complete,pageModule.buildPatchedResult(duplicated,[]),
    'Read-only proposed representation retains the original mask and produces the identical complete repair result');
  assert.deepEqual(complete.result.eraseBoxes,result.eraseBoxes,'Complete repair must restore every original geometry box');
  const partial=structuredClone(duplicated);partial.accepted=partial.accepted.slice(1);const leanPartial=structuredClone(partial);delete leanPartial.result.eraseBoxes;
  assert.deepEqual(pageModule.buildPatchedResult(leanPartial,[]),pageModule.buildPatchedResult(partial,[]),
    'Read-only proposed representation produces the identical selective erase mask for a partial repair');
  const compaction={pendingAckUtf8JsonBytes:bytes(page),confirmedAckUtf8JsonBytes:bytes(acceptedPage),
    duplicateEraseMapUtf8JsonBytes:bytes(page.originalEraseBoxes),proposedDedupSavingsUtf8JsonBytes:bytes(duplicated)-bytes(deduplicated),
    completeAndPartialRepairResultUnchanged:true};
  const cleanupChecks=[];
  if(requireCleanup){
    // Old versions can leave tombstones plus their journals across a worker
    // restart. Recovery may reclaim those exact owners, never active sources.
    const inherited=memoryArea({...protectedValues,[storeModule.translationSessionRunKey(active.id)]:{version:1,row:active}});
    const inheritedAge=()=>clock-6*60*60*1000-1;
    const inheritedPages=preparedModule.createPreparedPageJournal({area:()=>inherited.area,now:inheritedAge}),inheritedReceipts=dispatchModule.createDispatchJournal({area:()=>inherited.area,now:inheritedAge});
    for(let index=0;index<32;index++){
      const id='inherited-deleted-'+index;inherited.saved[storeModule.translationSessionRunKey(id)]={version:1,deleted:true,id,updatedAt:clock-6*60*60*1000-1};
      await inheritedPages.record(id,'page',sourcePage(id));await inheritedReceipts.record(id,'page',{operationId:'deleted-operation-'+index,ids:['u1']});
    }
    await preparedModule.createPreparedPageJournal({area:()=>inherited.area,now}).record(active.id,'page',sourcePage(active.id));
    assert.deepEqual((await storeModule.createTranslationSessionStore({area:()=>inherited.area,now}).list()).map(row=>row.id),[active.id]);
    assert.equal(inherited.family(preparedPrefix).length,1);assert.equal(inherited.family(dispatchPrefix).length,0);
    assert.equal(Object.values(inherited.saved).filter(value=>value?.deleted===true).length,0);
    for(const [key,value] of Object.entries(protectedValues))assert.deepEqual(inherited.saved[key],value);
    cleanupChecks.push('32 expired inherited tombstones reclaim only their journals during recovery');

    // An unavailable owner may contain an unknown in-flight provider result.
    // Correctness takes priority over new-job availability: preserve the full
    // unavailable owner until explicit cancellation or its original owner TTL.
    let unknownClock=clock;const unknownNow=()=>unknownClock;
    const unknown=memoryArea(protectedValues),unknownStore=storeModule.createTranslationSessionStore({area:()=>unknown.area,now:unknownNow,maxRuns:1});
    const unknownPages=preparedModule.createPreparedPageJournal({area:()=>unknown.area,now:unknownNow}),unknownReceipts=dispatchModule.createDispatchJournal({area:()=>unknown.area,now:unknownNow});
    await unknownStore.update('unknown-owner',()=>({createdAt:clock,phase:'unavailable'}));
    await unknownPages.record('unknown-owner','page',sourcePage('unknown-owner'));
    await unknownReceipts.record('unknown-owner','page',{operationId:'unknown-operation',ids:['u1'],providerOutcome:'unknown'});
    await assert.rejects(unknownStore.update('retained-live-owner',()=>({createdAt:clock,phase:'collecting'})),{code:'session_checkpoint_limit'});
    assert.equal(unknown.family(preparedPrefix).length,1);assert.equal(unknown.family(dispatchPrefix).length,1);
    const unknownOwner=unknown.saved[storeModule.translationSessionRunKey('unknown-owner')];
    assert.equal(unknownOwner?.row?.phase,'unavailable');assert.equal(await unknownStore.get('retained-live-owner'),null);
    unknownClock+=60*60*1000;
    await storeModule.createTranslationSessionStore({area:()=>unknown.area,now:unknownNow}).list();
    assert.equal(unknown.family(preparedPrefix).length,1);assert.equal(unknown.family(dispatchPrefix).length,1);
    assert.equal(unknown.saved[storeModule.translationSessionRunKey('unknown-owner')]?.row?.phase,'unavailable','Fresh unavailable owner must survive recovery');
    unknownClock=clock+6*60*60*1000+1;
    await storeModule.createTranslationSessionStore({area:()=>unknown.area,now:unknownNow}).list();
    assert.equal(unknown.family(preparedPrefix).length,0);assert.equal(unknown.family(dispatchPrefix).length,0);
    cleanupChecks.push('Full unavailable owner and unknown dispatch survive recovery; admission safely refuses at the owner limit until cancellation or original TTL');

    const legacyUnknown=memoryArea({...protectedValues,[storeModule.translationSessionRunKey('legacy-unknown')]:{version:1,deleted:true,id:'legacy-unknown',updatedAt:clock-1}});
    await preparedModule.createPreparedPageJournal({area:()=>legacyUnknown.area,now}).record('legacy-unknown','page',sourcePage('legacy-unknown'));
    await dispatchModule.createDispatchJournal({area:()=>legacyUnknown.area,now}).record('legacy-unknown','page',{operationId:'legacy-unknown-operation',ids:['u1']});
    await preparedModule.createPreparedPageJournal({area:()=>legacyUnknown.area,now}).record('ownerless-fresh','page',sourcePage('ownerless-fresh'));
    await storeModule.createTranslationSessionStore({area:()=>legacyUnknown.area,now}).list();
    assert.equal(legacyUnknown.family(preparedPrefix).length,2);assert.equal(legacyUnknown.family(dispatchPrefix).length,1);
    for(const [,row] of [...legacyUnknown.family(preparedPrefix),...legacyUnknown.family(dispatchPrefix)])
      assert.equal(row.createdAt,clock,'Unknown fresh journals must retain the original age used by their existing TTL');
    cleanupChecks.push('Fresh legacy-owner and ownerless journals retain their sources, receipts and original TTL timestamps while provenance is unknown');

    // One older orphan page cannot prove that a later ownerless provider
    // dispatch has expired. Keep TTL authority per journal when no owner row
    // supplies the original run lifetime.
    const mixed=memoryArea(protectedValues);
    const oldMixedPages=preparedModule.createPreparedPageJournal({area:()=>mixed.area,now:inheritedAge});
    const oldMixedReceipts=dispatchModule.createDispatchJournal({area:()=>mixed.area,now:inheritedAge});
    await oldMixedPages.record('ownerless-mixed','old',sourcePage('old'));
    await oldMixedReceipts.record('ownerless-mixed','old',{operationId:'expired-operation',ids:['u1']});
    await preparedModule.createPreparedPageJournal({area:()=>mixed.area,now}).record('ownerless-mixed','fresh',sourcePage('fresh'));
    await dispatchModule.createDispatchJournal({area:()=>mixed.area,now}).record('ownerless-mixed','fresh',{operationId:'fresh-unknown-operation',ids:['u1'],providerOutcome:'unknown'});
    await storeModule.createTranslationSessionStore({area:()=>mixed.area,now}).list();
    assert.equal(mixed.family(preparedPrefix).length,1,'Expired orphan page must not retire a later fresh page of the same unknown owner');
    assert.equal(mixed.family(dispatchPrefix).length,1,'Expired orphan receipt must not retire a later unknown provider dispatch');
    assert.equal(mixed.family(preparedPrefix)[0][1].pageId,'fresh');assert.equal(mixed.family(dispatchPrefix)[0][1].pageId,'fresh');
    for(const [,row] of [...mixed.family(preparedPrefix),...mixed.family(dispatchPrefix)])assert.equal(row.createdAt,clock);
    cleanupChecks.push('Ownerless TTL cleanup selects only individually expired journals and preserves newer unknown dispatches of the same owner');

    let rejectExpiredCleanup=true;
    const optional=memoryArea({...protectedValues,[storeModule.translationSessionRunKey(expired.id)]:{version:1,row:expired},[storeModule.translationSessionRunKey(active.id)]:{version:1,row:active}},
      {remove:async keys=>{if(rejectExpiredCleanup&&keys.some(key=>key.startsWith(preparedPrefix)||key.startsWith(dispatchPrefix)))throw new Error('Synthetic optional expiry cleanup rejected');}});
    const optionalPages=preparedModule.createPreparedPageJournal({area:()=>optional.area,now}),optionalReceipts=dispatchModule.createDispatchJournal({area:()=>optional.area,now});
    for(const owner of [expired,active]){
      await optionalPages.record(owner.id,'page',sourcePage(owner.id));await optionalReceipts.record(owner.id,'page',{operationId:'optional-'+owner.id,ids:['u1']});
    }
    const optionalStore=storeModule.createTranslationSessionStore({area:()=>optional.area,now});
    assert.deepEqual((await optionalStore.list()).map(row=>row.id),[active.id],'Optional cleanup failure must not reject recovery of a retained active owner');
    assert.equal((await optionalStore.get(active.id)).id,active.id,'Loaded promise must remain usable after optional cleanup rejection');
    await optionalStore.update(active.id,row=>({...row,continued:true}));assert.equal((await optionalStore.get(active.id)).continued,true);
    assert.equal(optional.family(preparedPrefix).length,2);assert.equal(optional.family(dispatchPrefix).length,2);
    rejectExpiredCleanup=false;
    await storeModule.createTranslationSessionStore({area:()=>optional.area,now:()=>clock+6*60*60*1000+1}).list();
    assert.equal(optional.family(preparedPrefix).length,0);assert.equal(optional.family(dispatchPrefix).length,0);
    for(const [key,value] of Object.entries(protectedValues))assert.deepEqual(optional.saved[key],value);
    cleanupChecks.push('Optional expiry-cleanup failure preserves active recovery and subsequent durable writes; later original TTL cleanup succeeds');

    // A rejected owner deletion cannot retire its still-durable source. After
    // a committed deletion, failed cleanup retains source until original TTL.
    let failOwner=false,failCleanup=false,rejectedCleanupCalls=0,rejectedCleanup;
    const rejectedCleanupPromise=new Promise(resolve=>rejectedCleanup=resolve);
    const failures=memoryArea(protectedValues,{set:async patch=>{
      if(failOwner&&Object.values(patch).some(value=>value?.deleted===true))throw new Error('Synthetic owner deletion rejected');
    },remove:async keys=>{
      if(failCleanup&&keys.some(key=>key.startsWith(preparedPrefix)||key.startsWith(dispatchPrefix))){
        rejectedCleanupCalls++;rejectedCleanup();throw new Error('Synthetic journal cleanup rejected');
      }
    }});
    const failedStore=storeModule.createTranslationSessionStore({area:()=>failures.area,now});
    const failurePages=preparedModule.createPreparedPageJournal({area:()=>failures.area,now}),failureReceipts=dispatchModule.createDispatchJournal({area:()=>failures.area,now});
    await failedStore.update('remove-owner',()=>({createdAt:clock,phase:'unavailable',marker:'must remain'}));
    await failurePages.record('remove-owner','page',sourcePage('remove-owner'));await failureReceipts.record('remove-owner','page',{operationId:'remove-operation',ids:['u1']});
    failOwner=true;await assert.rejects(failedStore.remove('remove-owner'),/Synthetic owner deletion rejected/);
    assert.equal((await failedStore.get('remove-owner')).marker,'must remain');
    assert.equal(failures.family(preparedPrefix).length,1);assert.equal(failures.family(dispatchPrefix).length,1);
    failOwner=false;failCleanup=true;await failedStore.remove('remove-owner');
    // A remove() receipt confirms the owner commit before best-effort journal
    // cleanup. Observe the actual rejected hook, then queue same-owner work to
    // prove that retirement completed before disabling failure injection.
    await rejectedCleanupPromise;
    await failedStore.update('remove-owner',()=>{
      assert.equal(rejectedCleanupCalls,1,'The post-commit journal cleanup must actually reject');
      assert.equal(failCleanup,true,'Failure injection must remain active through the completed retirement');
      assert.equal(failures.family(preparedPrefix).length,1);assert.equal(failures.family(dispatchPrefix).length,1);
      return null;
    });
    assert.equal(failures.family(preparedPrefix).length,1);assert.equal(failures.family(dispatchPrefix).length,1);
    failCleanup=false;await storeModule.createTranslationSessionStore({area:()=>failures.area,now:()=>clock+6*60*60*1000+1}).list();
    assert.equal(failures.family(preparedPrefix).length,0);assert.equal(failures.family(dispatchPrefix).length,0);
    assert(!(storeModule.translationSessionRunKey('remove-owner') in failures.saved));
    for(const [key,value] of Object.entries(protectedValues))assert.deepEqual(failures.saved[key],value);
    cleanupChecks.push('Rejected owner deletion preserves recovery; the actual post-commit cleanup rejection retains source until expiry recovery');

    let gateDeletion=false,entered,release;const enteredPromise=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    const concurrent=memoryArea(protectedValues,{set:async patch=>{
      if(gateDeletion&&patch[storeModule.translationSessionRunKey('retired-owner')]?.deleted){entered();await gate;}
    }});
    const concurrentStore=storeModule.createTranslationSessionStore({area:()=>concurrent.area,now});
    const concurrentPages=preparedModule.createPreparedPageJournal({area:()=>concurrent.area,now}),concurrentReceipts=dispatchModule.createDispatchJournal({area:()=>concurrent.area,now});
    for(const id of ['retired-owner','live-owner']){
      await concurrentStore.update(id,()=>({createdAt:clock,phase:'collecting',accepted:0}));
      await concurrentPages.record(id,'page',sourcePage(id));await concurrentReceipts.record(id,'page',{operationId:'operation-'+id,ids:['u1']});
    }
    gateDeletion=true;const removing=concurrentStore.remove('retired-owner');await enteredPromise;
    const updating=concurrentStore.update('live-owner',row=>({...row,accepted:1}));
    let timeout;try{await Promise.race([updating,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Unrelated active owner serialized behind retirement')),1000);})]);}
    finally{clearTimeout(timeout);release();}
    await removing;
    assert.equal((await concurrentStore.get('live-owner')).accepted,1);
    assert.equal(concurrent.family(preparedPrefix).length,1);assert.equal(concurrent.family(preparedPrefix)[0][1].runId,'live-owner');
    assert.equal(concurrent.family(dispatchPrefix).length,1);assert.equal(concurrent.family(dispatchPrefix)[0][1].runId,'live-owner');
    for(const [key,value] of Object.entries(protectedValues))assert.deepEqual(concurrent.saved[key],value);
    cleanupChecks.push('One owner retirement preserves concurrent active-owner progress and journals without serializing its write');

    // Persisted owner rechecks must cover both journal cleanup and the final
    // tombstone deletion. Simulate a fresh durable owner arriving while the
    // older retirement is paused, without relying on a number of event turns.
    let pauseRetirement=false,readEntered,releaseRead;
    const readEnteredPromise=new Promise(resolve=>readEntered=resolve),readGate=new Promise(resolve=>releaseRead=resolve);
    const future=memoryArea(protectedValues,{get:async keys=>{
      if(pauseRetirement&&keys===null){pauseRetirement=false;readEntered();await readGate;}
    }});
    const futureStore=storeModule.createTranslationSessionStore({area:()=>future.area,now});
    const futurePages=preparedModule.createPreparedPageJournal({area:()=>future.area,now}),futureReceipts=dispatchModule.createDispatchJournal({area:()=>future.area,now});
    const futureId='recreated-owner';await futureStore.update(futureId,()=>({createdAt:clock,phase:'collecting'}));
    await futurePages.record(futureId,'page',sourcePage(futureId));await futureReceipts.record(futureId,'page',{operationId:'old-operation',ids:['u1']});
    pauseRetirement=true;const retiring=futureStore.remove(futureId);await readEnteredPromise;
    const fresh={id:futureId,createdAt:clock+1,updatedAt:clock+1,phase:'collecting',fresh:true};
    await future.area.set({[storeModule.translationSessionRunKey(futureId)]:{version:1,row:fresh}});
    releaseRead();await retiring;
    // Same-owner work queues behind the earlier retirement drain. Inspect the
    // durable owner before this reducer can publish anything of its own.
    await futureStore.update(futureId,()=>{
      assert.deepEqual(future.saved[storeModule.translationSessionRunKey(futureId)]?.row,fresh,'Old retirement must never delete a newly restored durable owner');
      return fresh;
    });
    assert.equal(future.family(preparedPrefix).length,1);assert.equal(future.family(dispatchPrefix).length,1);
    cleanupChecks.push('Fresh durable owner wins over an older paused retirement, including final tombstone deletion');
  }
  const hashes={};for(const relative of ['src/background/translation-session-store.js','src/background/repair/prepared-page-journal.js','src/background/repair/dispatch-journal.js','src/background/repair/page-checkpoint.js'])
    hashes[relative]=createHash('sha256').update(await readFile(new URL(relative,root))).digest('hex');
  outputs.push({version,expiration,eviction,compaction,cleanupChecks,hashes});
}
const report={scope:requireCleanup?'Selected production modules, synthetic storage and captured Lens decode. Test-only changes; no native browser quota measurement or provider calls.':'Immutable .44 and delivered .52 production modules, synthetic storage and captured Lens decode. No native browser quota measurement, provider calls or production changes.',
  bytesMeaning:'All byte fields measure UTF8 JSON only. Chrome storage.session uses estimated dynamically allocated memory for keys/values; these are not exact native quota figures.',
  passed:true,requireCleanup,versions:outputs};
if(process.env.TP_STORAGE_REPORT)await writeFile(resolve(process.env.TP_STORAGE_REPORT),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
console.log('PASS storage retirement, unknown-dispatch preservation and complete/partial erase geometry');
