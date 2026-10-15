/** Production repair executor + native SQLite ledger; no external AI.
 * Mocked direct-local receipts carry Paid identities only to test fencing.
 * Actual Paid HTTP and financial settlement are tested separately.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
globalThis.crypto ||= webcrypto;
const project=pathToFileURL(`${process.env.TP_TEST_ROOT||process.cwd()}/`);
const from=p=>import(new URL(p,project));
const {makePageCheckpoint}=await from('src/background/repair/page-checkpoint.js');
const {executeRepairPool}=await from('src/background/repair/executor.js');
const {translationUnits}=await from('src/shared/lens-document.js');
function bridge(){
  const child=spawn('python',['-u','scripts/repair-ledger-fixture.py'],{cwd:project,stdio:['pipe','pipe','inherit']});
  const queue=[];
  createInterface({input:child.stdout}).on('line',text=>{
    const waiting=queue.shift(),reply=JSON.parse(text);
    reply.ok?waiting.resolve(reply.value):waiting.reject(Object.assign(new Error(reply.code),reply));
  });
  child.on('error',error=>{for(const waiting of queue.splice(0))waiting.reject(error);});
  child.on('exit',code=>{for(const waiting of queue.splice(0))waiting.reject(new Error(`Ledger exited ${code}`));});
  return{api(run,action='',body){return new Promise((resolve,reject)=>{
    queue.push({resolve,reject});child.stdin.write(JSON.stringify({run,action,body})+'\n');
  });},close(){child.stdin.end();}};
}
function source(){return{backgroundMode:'boxes',layout:{relayout_translated:false},
  lensDocument:{schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},
    paragraphs:[0,1].map(i=>({id:`p${i}`,sourceText:`Source ${i}`,items:[]}))},
  eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[0,1].map(i=>({l:.1,t:.1+i*.2,w:.3,h:.1,p:`p${i}`}))}};}
const credential=wallet=>`synthetic-credential-${wallet}`;
async function runCase(spec){
const [code,status,dispatched]=spec;
const ledger=bridge(),run={id:`test:${crypto.randomUUID()}`,token:'a'.repeat(64)};
const failReasons=[],calls=[],checkpoints=[],applications=[],progress=[],credentials=new Map(),pages=new Map();
let exhausted=false,callsAfterExhaustion=0,active=0,peak=0,capacityTail=Promise.resolve();
try{
  // Two model groups share wallet A; a third uses unrelated wallet B.
  for(let i=0;i<6;i++){
    const wallet=i<4?'A':'B',model=i<2?'qa/a':i<4?'qa/b':'qa/c',id=`page-${i}`,result=source();
    const page=await makePageCheckpoint({payload:{metadata:{image_id:id},lang:'th'},result,
      units:translationUnits(result.lensDocument),ctx:{jobId:`generation:${id}`},operationId:`initial:${id}`,
      plan:{route:'direct-local',ai:{provider:'paid',model,api_key:credential(wallet),thinking:'minimum',
        translation_mode:'conversation',conversation:{documentId:'synthetic-repair-document',owner:'synthetic-owner',
          pageId:id,pageOrder:i+1,pageIndex:i}}}});
    pages.set(page.pageId,page);credentials.set(page.pageId,credential(wallet));
  }
  await ledger.api(run,'register',{manifest:[...pages.keys()]});
  for(const page of pages.values())await ledger.api(run,'pages',{pageId:page.pageId,generationId:page.generationId,
    groupKey:page.groupKey,status:'finished',initialAccepted:0,
    failed:page.units.map(unit=>({id:unit.id,text:unit.text,sourceHash:unit.sourceHash,reason:'missing'}))});
  const final=await executeRepairPool({run,snapshot:await ledger.api(run,'seal',{}),executor:'synthetic-worker',
    signal:new AbortController().signal,api:async(...args)=>{if(args[1]?.includes('fail'))failReasons.push(args[2]?.reason);return ledger.api(...args);},getPage:async id=>pages.get(id),
    resolveAi:async page=>({...page.ai,api_key:credentials.get(page.pageId)}),
    checkpointTask:async task=>checkpoints.push(task),onProgress:event=>progress.push(event),
    applyResults:async rows=>applications.push(rows),
    // One slot forces sibling plans to wait, exercising pre-dispatch fencing.
    withCapacity:async(_page,_ai,_signal,work)=>{
      const prior=capacityTail;let release;capacityTail=new Promise(resolve=>release=resolve);
      await prior;active++;peak=Math.max(peak,active);
      try{return await work();}finally{active--;release();}
    },
    planner:{open:async()=>({nextRepair(rows){return this.next(rows);},next:rows=>({units:rows.slice(0,1),
      estimate:{predictedOutput:128,reasoningReserve:0,estimatedInput:128,completionAvailable:8192}}),
      observe:()=>({outcome:'ignored'})})},
    translate:async(units,options)=>{
      const wallet=options.ai.api_key===credential('A')?'A':'B';
      if(wallet==='A'&&exhausted)callsAfterExhaustion++;
      calls.push({wallet,model:options.ai.model,operationId:options.operationId,units:units.map(u=>u.id)});
      assert.ok(options.operationId.startsWith(`repair:${run.id}:`),'dispatch owns its repair operation');
      if(wallet==='A'&&calls.filter(call=>call.wallet==='A').length===2){
        exhausted=true;throw Object.assign(new Error('Synthetic budget rejection'),{
          code,status,httpStatus:status,...(dispatched?{upstreamStatus:402}:{}),requestDispatched:dispatched,
          providerAttempts:dispatched?1:0,generationAttempts:0});
      }
      return{translations:units.map(unit=>({id:unit.id,text:'คำแปลที่เสร็จแล้ว'})),
        meta:{provider:'paid',model:options.ai.model,providerAttempts:1,generationAttempts:1}};
    },
  });
  assert.equal(callsAfterExhaustion,0,'same wallet must not invoke translate after its first budget/credit rejection');
  assert.equal(calls.filter(call=>call.wallet==='A').length,2,'one success and one exhaustion response');
  assert.equal(calls.filter(call=>call.wallet==='B').length,4,'unrelated wallet finishes every unit');
  assert.equal(new Set(calls.map(call=>call.operationId)).size,calls.length,'operation IDs remain distinct');
  assert.equal(peak,1);assert.equal(active,0);
  assert.equal(final.phase,'done');assert.equal(final.repaired,5);assert.equal(final.unresolved,7);
  assert.equal(applications.length,1,'one final apply preserves successes and unresolved units');
  assert.equal(applications[0].length,5);assert.ok(applications[0].every(row=>row.translation==='คำแปลที่เสร็จแล้ว'));
  assert.equal(checkpoints.filter(task=>task.state==='dispatched').length,calls.length,
    'fenced claims must not invent provider dispatches');
  assert.ok(progress.some(event=>event.phase==='repair_circuit_open'));
  assert.ok(failReasons.length>0);
  assert.ok(failReasons.every(reason=>reason===code),'Every failed/fenced task must preserve its original reason');
  const circuitReasons=progress.filter(e=>e.phase==='repair_circuit_open').map(e=>e.reason);
  assert.ok(circuitReasons.length>0);
  assert.ok(circuitReasons.every(reason=>reason===code),'Every closed repair group must preserve its original reason');
  return {schema:'tp.qa.wallet-repair/1',passed:true,evidence:dispatched?'upstream':'admission',reason:code,
    scope:'ProductionRepairExecutor+nativeSQLiteLedger;mockedDirectLocalReceiptPathWithPaidIdentity',
    walletATransportCalls:2,walletBTransportCalls:4,transportCallsAfterRejection:0,preservedAcceptedUnits:5,
    terminalUnresolvedUnits:7,maximumProviderOverlap:peak,failReasons,circuitReasons};
}finally{ledger.close();}
}
const reports=[];
// 10491: paid_provider_capacity is transient and no longer fences a wallet (see test-paid-quote-failure-no-block-10491.mjs).
for(const spec of [['paid_provider_key_limit',503,true],['paid_provider_balance',502,true],['paid_insufficient_credits',402,false],['paid_provider_key_limit',503,false],['paid_provider_balance',502,false]]){
 try{reports.push(await runCase(spec));}catch(error){reports.push({passed:false,evidence:spec[2]?'upstream':'admission',reason:spec[0],failure:String(error.message).slice(0,220)});}
}
const failed=reports.filter(r=>!r.passed);
console.log(JSON.stringify({schema:'tp.qa.billing-repair/1',cases:reports,total:reports.length,passed:reports.length-failed.length,failed:failed.length},null,2));
if(failed.length)process.exitCode=1;
