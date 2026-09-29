import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if (!process.env.TP_READER_TEST_STAGE) {
  const dir=mkdtempSync(join(tmpdir(),'tp-reader-restart-'));
  const file=join(dir,'session.json');
  try {
    writeFileSync(file,'{}');
    for (const stage of ['before_restart','after_restart']) {
      const child=spawnSync(process.execPath,[new URL(import.meta.url).pathname],{
        env:{...process.env,TP_READER_TEST_STAGE:stage,TP_READER_TEST_STORE:file},
        encoding:'utf8',timeout:12000,
      });
      assert.equal(child.status,0,`${stage}: ${child.stdout}\n${child.stderr}`);
    }
    console.log('PASS completed reader restores pending placement after worker restart and clears the checkpoint on final ACK');
  } finally {rmSync(dir,{recursive:true,force:true});}
} else {
  const file=process.env.TP_READER_TEST_STORE;
  const fetch=()=>JSON.parse(readFileSync(file,'utf8'));
  globalThis.chrome={
    runtime:{id:'test-extension',sendMessage(_msg,cb){cb?.();},get lastError(){return null;}},
    tabs:{sendMessage(_id,_msg,_options,cb){cb?.({ok:true});}},
    storage:{session:{
      get(key,cb){return new Promise(resolve=>setTimeout(()=>{
        const value={[key]:fetch()[key]};cb?.(value);resolve(value);
      },35));},
      set(patch,cb){writeFileSync(file,JSON.stringify({...fetch(),...patch}));cb?.();return Promise.resolve();},
    }},
  };
  const batches=await import('../src/background/batches.js');
  const key='tpBatchProgressV1';
  if (process.env.TP_READER_TEST_STAGE==='before_restart') {
    await batches.restorePersistedBatches();
    await chrome.storage.session.set({tpTabSessionsV1:[{tabId:17,id:'tab-session',
      href:'https://example.invalid/chapter',ts:Date.now()}]});
    const batch=batches.ensureBatch('reader-pending-ack',17,0);
    for(const page of ['1','2']) {
      const payload={src:`https://example.invalid/p${page}.jpg`,reader:{runId:'reader-r',pageId:page},
        generation:{pageInstanceId:'page-generation'},context:{page_index:Number(page)-1,tp_tab_session:'tab-session'},
        imageBytes:'data:image/jpeg;base64,THIS_MUST_NOT_PERSIST'};
      batches.registerBatchPayload(batch,payload,page);
      batches.batchMark(batch.id,page,{phase:'done',status:'done'});
    }
    batches.updateImagePresentation(batch.id,'1',{placementPending:false,
      insertionAck:{present:true}});
    batches.updateImagePresentation(batch.id,'2',{placementPending:true});
    batch.reader.processingComplete=true;batch.reader.released=true;
    batch.lifecycle='completed';batch.completedAt=Date.now();
    assert.equal(await batches.persistBatchProgressNow(),true);
    const persisted=fetch()[key];
    assert.equal(persisted.length,1,'completed readers must retain pending placement metadata');
    assert.equal(persisted[0].items.length,2);
    assert.equal(JSON.stringify(persisted).includes('THIS_MUST_NOT_PERSIST'),false);
    assert.ok(JSON.stringify(persisted).length<25000);
  } else {
    // The first receipt arrives while the new worker is still restoring storage.
    const {handleReaderReceipt}=await import('../src/background/reader-events.js');
    const ack=await handleReaderReceipt({type:'TP_READER_PLACED',readerRunId:'reader-r',
      pageInstanceId:'page-generation',pageId:'2',kind:'OVERLAY_HTML',drawn:true},
    {tab:{id:17},frameId:0},()=>{});
    assert.equal(ack?.ok,true,'reader ACK must wait for worker restoration');
    const batch=batches.getBatch('reader-pending-ack');
    assert.equal(batches.batchProgressSnapshot(batch).placement.waiting,0);
    assert.equal(batches.batchProgressSnapshot(batch).placement.placed,2);
    assert.deepEqual(fetch()[key],[],
      'completed reader metadata must be removed as soon as the final page is placed');
  }
}
