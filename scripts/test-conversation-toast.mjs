import assert from 'node:assert/strict';
const packets=[];
globalThis.chrome={
  runtime:{lastError:null,sendMessage:(_m,cb)=>cb?.(),getManifest:()=>({version:'test'})},
  tabs:{sendMessage:(tab,msg,opt,cb)=>{packets.push({tab,msg,opt});cb?.({ok:true});}},
  storage:{local:{get:(_k,cb)=>cb({}),set:(_v,cb)=>cb?.()},session:{get:(_k,cb)=>cb({}),set:(_v,cb)=>cb?.()}},
};
const {ensureBatch,updateImagePresentation,batchUpdateToast}=await import('../src/background/batches.js');
const b=ensureBatch('conv-toast',9,0);b.total1=3;
for(let i=0;i<3;i++)b.items.set(`p${i}`,{attempt:1,status:'processing',phase:i===0?'ai_generating':'ai_queued',phaseAt:Date.now(),payload:{context:{page_index:i}},presentation:{translationMode:'conversation'}});
updateImagePresentation(b.id,'p0',{translationMode:'conversation',conversation:{phase:'translating',turn:2,pageCount:2,unitCount:19,readyPageCount:5,queuedPageCount:3,cacheConfirmed:true,cacheRatio:.8,previousUpstreamProvider:'together',previousProviderMs:10600,updatedAt:Date.now()}});
batchUpdateToast(b,'',true);
const toast=packets.filter(x=>x.msg?.type==='BATCH_STATUS_UPDATE').at(-1)?.msg?.batch?.message||'';
assert.match(toast,/Conversation turn 2/);
assert.match(toast,/2 pages \/ 19 units/);
assert.match(toast,/3 pages ready next/);
assert.match(toast,/prev cache 80%/,'active translation should preserve prior-turn cache evidence without claiming a live cache wait');
assert.match(toast,/upstream together/);
assert.match(toast,/prev AI 11s/);
assert.doesNotMatch(toast,/waiting (?:for|on) cache|cache waiting/i,'cache telemetry must not be presented as a blocking stage');
assert.doesNotMatch(toast,/AI \d+ active|waiting for AI/i);

updateImagePresentation(b.id,'p0',{translationMode:'conversation',conversation:{phase:'anchor_recovering',turn:1,pageCount:1,unitCount:9,updatedAt:Date.now()}});
batchUpdateToast(b,'',true);
const recovery=packets.filter(x=>x.msg?.type==='BATCH_STATUS_UPDATE').at(-1)?.msg?.batch?.message||'';
assert.match(recovery,/recovering first anchor/i);
updateImagePresentation(b.id,'p0',{translationMode:'conversation',conversation:{phase:'turn_complete',turn:2,cachedInputTokens:800,actualInputTokens:1000,upstreamProvider:'together',providerMs:10600,updatedAt:Date.now()}});
batchUpdateToast(b,'',true);
const complete=packets.filter(x=>x.msg?.type==='BATCH_STATUS_UPDATE').at(-1)?.msg?.batch?.message||'';
assert.match(complete,/prompt cache hit 80%/);
assert.match(complete,/upstream together/);
assert.match(complete,/AI 11s/);
console.log('PASS Conversation batch status preserves previous cache/upstream/latency evidence without mislabeling cache as a live blocking stage');
