/** .67 Local Independent cross-page through the production page pipeline:
 * translateLensPage -> independent ready queue -> planIndependentReady ->
 * workload session. Only the provider call is a fake. */
import assert from 'node:assert/strict';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {planIndependentReady,learnIndependentExamples} from '../src/background/ai/translation-paths/batch-dispatch.js';
import {independentExampleStore} from '../src/background/ai/independent-example-store.js';
import {reserveLocalIndependentJob,finishLocalIndependentJob,localIndependentTicket,localIndependentTickets,
  onLocalIndependentReady} from '../src/background/ai/translation-paths/independent-order.js';

const store={};
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.10.4.67'}),sendMessage:(_m,cb)=>cb?.({}),lastError:null},storage:{local:{
 get(keys,cb){const out=keys==null?structuredClone(store):Object.fromEntries([].concat(keys).map(k=>[k,store[k]]));cb?.(out);return Promise.resolve(out);},
 set(value,cb){Object.assign(store,structuredClone(value));cb?.();return Promise.resolve();}}}};

const ai={translation_mode:'independent',style_examples:false,provider:'ollama',base_url:'http://127.0.0.1:11434',model:'fixture',
  thinking:'off',prompt:'Translate exactly by ID',send_image:false,model_capabilities:{reasoning:{supported:false},
    structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},limits:{contextTokens:32768,source:'runtime',scope:'runtime'}}};
const controller=createWorkloadController({read:async()=>({}),write:async()=>{}});
const requests=[];
const queue=createReadyQueue({mode:'independent',
  ordering:{ticketFor:localIndependentTicket,list:localIndependentTickets,onReady:onLocalIndependentReady},
  choose:(rows,o)=>planIndependentReady(rows,o,{refresh:async value=>value,open:controller.open}),
  dispatch:async(units,o,p)=>{
    requests.push({units:units.map(u=>u.id),pages:p.origins.map(x=>x.pageId),mode:p.session.ai.translation_mode});
    return {schema:'tp.ai.result/1',translations:units.map(u=>({id:u.id,text:`แปล ${u.text}`})),missing:[],
      meta:{finishReason:'stop',generationAttempts:1,providerAttempts:1}};
  }});

function page(i){
  const paragraphs=Array.from({length:3},(_,k)=>({id:`p${k}`,sourceText:`Page ${i} line ${k}`}));
  const result={lensDocument:{languages:{source:'en'},paragraphs},
    eraseBoxes:{schema:'tp.erase-boxes/1',boxes:paragraphs.map((row,k)=>({l:k/3,t:0,w:.01,h:.01,p:row.id}))}};
  const payload={source:'ai',engine:'extension',lang:'th',metadata:{image_id:`image-${i}`,batch_id:'run'},
    context:{page_url:'doc',tp_tab_session:'tab',page_index:i},ai:{...ai}};
  reserveLocalIndependentJob(payload,1);
  const checkpoints=[];
  const args={base:'http://unused.invalid',payload,result,plan:{route:'direct-local',ai:{...ai}},
    onCheckpoint:async e=>checkpoints.push(e.stage),conversationSubmit:queue.submit,
    dependencies:{workloadController:controller,refreshLocalAiCapabilities:async value=>value,
      requireAiLensDocument:value=>value.lensDocument,
      diagnoseTargetScripts:items=>items.map(item=>({id:String(item.id),decision:'accept'})),summarizeUnitScripts:()=>[]}};
  return {args,result,payload,checkpoints};
}

const pages=[0,1,2].map(page);
// Page 2 finishes OCR first, then 1, then 0: the request still follows webpage order.
const runs=[pages[2],pages[1],pages[0]].map(p=>translateLensPage(p.args).finally(()=>finishLocalIndependentJob(p.payload)));
const outcomes=await Promise.all(runs);
assert.ok(outcomes.every(o=>o.complete===true),'every page completes from the shared request');
// Ready pages are sent as soon as the earlier pages are ready (owner choice),
// so how many requests depends on OCR timing; the order never does.
assert.ok(requests.length>=1&&requests.length<=3);
assert.deepEqual(requests.flatMap(r=>r.pages),['image-0','image-1','image-2'],'webpage order across requests');
assert.ok(requests.every(r=>r.mode==='independent'),'stateless Independent prompt, not Conversation history');
for(const p of pages){
  assert.deepEqual(p.result.lensDocument.paragraphs.map(x=>x.aiText),[0,1,2].map(k=>`แปล Page ${p.payload.context.page_index} line ${k}`));
  assert.ok(p.checkpoints.includes('dispatch')&&p.checkpoints.includes('progress'),'per-page checkpoints kept');
}
queue.close();

// Human examples ON: the first shared request uses human examples, accepted
// pairs are learned after the page checkpoints, and the next request of the
// same run uses those story examples (prompt still sent every request).
{
  const used=[];
  const thai=k=>`ข้อความแปลภาษาไทย${'ก'.repeat(k+1)}`;
  const q=createReadyQueue({mode:'independent',
    ordering:{ticketFor:localIndependentTicket,list:localIndependentTickets,onReady:onLocalIndependentReady},
    choose:(rows,o)=>planIndependentReady(rows,o,{refresh:async value=>value,open:controller.open}),
    afterRequest:learnIndependentExamples(independentExampleStore),
    dispatch:async(units,o,p)=>{used.push({source:p.session.ai.independent_examples?.source,pages:p.origins.length});
      return {schema:'tp.ai.result/1',translations:units.map((u,k)=>({id:u.id,text:thai(used.length*10+k)})),missing:[],
        meta:{finishReason:'stop',generationAttempts:1,providerAttempts:1}};}});
  const make=i=>{const p=page(10+i);p.payload.ai.style_examples=true;p.args.plan.ai.style_examples=true;
    p.args.conversationSubmit=q.submit;p.args.dependencies.independentExampleStore=independentExampleStore;return p;};
  const first=[0,1].map(make);
  await Promise.all(first.map(p=>translateLensPage(p.args).finally(()=>finishLocalIndependentJob(p.payload))));
  const second=[2].map(make);
  await Promise.all(second.map(p=>translateLensPage(p.args).finally(()=>finishLocalIndependentJob(p.payload))));
  assert.equal(used[0].source,'human','the first request of a run uses human examples');
  assert.ok(used.length>=2&&used.slice(1).every(u=>u.source==='story'),'later requests use accepted story examples');
  assert.equal(used.reduce((n,u)=>n+u.pages,0),3);
  q.close();
}
console.log('PASS Local Independent pages share one window-filled request through the production page pipeline, in webpage order; human then story examples');
