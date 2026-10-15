/** Production ReadyQueue Paid wallet fencing; synthetic provider only. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
globalThis.crypto ||= webcrypto;
const project=pathToFileURL(`${process.env.TP_TEST_ROOT||process.cwd()}/`);
const {createReadyQueue}=await import(new URL('src/background/ai/translation-paths/ready-queue.js',project));
const {reserveConversationJob,finishConversationJob}=await import(new URL('src/background/ai/translation-paths/order.js',project));
const credential=wallet=>`synthetic-credential-${wallet}`;
function page(index,document='wallet-sequence',wallet='A',model='qa/a'){
  const payload={source:'ai',lang:'th',context:{page_url:document,tp_tab_session:'synthetic-tab',page_index:index},
    metadata:{image_id:`${document}-${index}`,batch_id:'synthetic-batch'},
    ai:{provider:'paid',model,api_key:credential(wallet),translation_mode:'conversation',thinking:'minimum'}};
  reserveConversationJob(payload,1);
  return{payload,ai:payload.ai,imageId:payload.metadata.image_id,targetLang:'th',sourceLang:'en',route:'server',sourceFingerprint:'a'.repeat(64)};
}
let walletACalls=0,walletBCalls=0,unblock,started=false;
const queue=createReadyQueue({choose:async rows=>({units:rows.slice(0,1),splitReason:'bounded_synthetic'}),
  dispatch:async(units,options)=>{
    const wallet=options.ai.api_key===credential('A')?'A':'B';
    if(wallet==='A'){
      walletACalls++;if(walletACalls===1){started=true;await new Promise(resolve=>unblock=resolve);}
      if(walletACalls===3)throw Object.assign(new Error('Eligible credits are zero'),{code:'paid_insufficient_credits',
        httpStatus:402,status:402,requestDispatched:false,providerAttempts:0,generationAttempts:0});
    }else walletBCalls++;
    return{translations:units.map(unit=>({id:unit.id,text:'คำแปลเสร็จแล้ว'})),
      meta:{conversation:{commitStatus:'committed',historyTurns:wallet==='A'?walletACalls:walletBCalls}}};
  }});
const pages=Array.from({length:24},(_,index)=>page(index));
const otherModel=page(0,'other-document','A','qa/b'),otherCredential=page(0,'other-wallet','B');
try{
  const tasks=[queue.submit([{id:'P0',text:'Source 0'}],pages[0])];tasks[0].catch(()=>{});
  for(let tries=0;tries<100&&!started;tries++)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(started);
  for(const current of pages.slice(1)){const task=queue.submit([{id:'P0',text:'Source'}],current);task.catch(()=>{});tasks.push(task);}
  unblock();const outcomes=await Promise.allSettled(tasks);
  assert.equal(walletACalls,3);assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,2);
  for(const value of outcomes.slice(0,2)){
    assert.equal(value.value.translations[0].text,'คำแปลเสร็จแล้ว');
    assert.equal(value.value.meta.sharedRequestRefs.length,1);
    assert.equal(value.value.meta.usage,undefined,'page projections never duplicate full request usage');
  }
  for(const value of outcomes.slice(3)){
    assert.equal(value.status,'rejected');assert.equal(value.reason.requestDispatched,false);
    assert.equal(value.reason.providerAttempts,0);assert.equal(value.reason.generationAttempts,0);
  }
  const blocked=await queue.submit([{id:'P0',text:'Other model'}],otherModel).catch(error=>error);
  assert.equal(blocked.requestDispatched,false);assert.equal(blocked.providerAttempts,0);assert.equal(walletACalls,3);
  const unaffected=await queue.submit([{id:'P0',text:'Other wallet'}],otherCredential);
  assert.equal(unaffected.translations[0].text,'คำแปลเสร็จแล้ว');assert.equal(walletBCalls,1);
  console.log(JSON.stringify({schema:'tp.qa.wallet-initial/1',passed:true,
    scope:'ProductionReadyQueue24pages+twoCredentialDocuments;syntheticProviderOnly',
    walletADispatches:3,walletBDispatches:1,preservedFinishedPages:2,fencedUnsentPages:22,
    duplicatedFullUsage:0,otherCredentialUnaffected:true}));
}finally{for(const current of [...pages,otherModel,otherCredential])finishConversationJob(current.payload);queue.close();}
