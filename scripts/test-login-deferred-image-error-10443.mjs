import assert from 'node:assert/strict';
import {createRepairCoordinator} from '../src/background/repair/coordinator.js';
import {createTranslationSessionStore} from '../src/background/translation-session-store.js';
import {createResultDelivery} from '../src/background/jobs/result-delivery.js';
import {imageErrorMessage} from '../src/background/error-message.js';
import {ensureBatch,batchMark,markImagePhase} from '../src/background/batches.js';

const noop=()=>{},clone=structuredClone,checks=[];
async function fixture({checkpoint=true,unavailable=false,cancel=false,repaired=false,ack=true,unpinned=false,foreign=false}={}){
 let stored={},epoch=7;const inserted=[],events=[],reports=[];
 const area={get:async key=>key==null?clone(stored):({[key]:clone(stored[key])}),set:async patch=>Object.assign(stored,clone(patch)),remove:async keys=>{for(const key of(Array.isArray(keys)?keys:[keys]))delete stored[key];}};
 const sessions=createTranslationSessionStore({area:()=>area});
 const batch=ensureBatch(crypto.randomUUID(),70443,0),pageId='failure-page',jobId='failure-job';
 const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'https://fixture.invalid/failure-page.png',metadata:{image_id:pageId}};
 batch.items.set(pageId,{attempt:1,status:'processing',phase:'ai_generating',payload,presentation:{repairPhase:'collecting'}});batch.total1=1;
 const ctx={jobId,batchId:batch.id,imageKey:pageId,tabId:70443,frameId:0,imgUrl:payload.src,sessionId:'fixture-tab',settingsEpoch:7,mode:'lens_text',source:'ai',aiGenerationAttempted:true,generation:{pageInstanceId:'fixture-document',targetKey:payload.src,targetInstanceId:'fixture-target',targetRevision:0}};
 const coordinator=createRepairCoordinator({sessions,currentEpoch:()=>epoch,currentSession:()=> 'fixture-tab',getBase:async()=> 'http://fixture.invalid',getContext:()=>ctx,getCapabilitiesFor:async()=>({}),emit:(event,data)=>events.push({event,data}),
  api:async(_run,action,body)=>{if(action==='pages')reports.push(...body.pages);return action==='seal'?{phase:'done',tasks:[],results:[],unresolved:checkpoint&&!repaired?1:0,unavailablePages:checkpoint?0:1}:{};},
  insert:async(_tab,message)=>{inserted.push(message);return {ok:true,applied:ack};},
  execute:async()=>{throw Error('An empty terminal repair pool must not dispatch another provider.');},
 });
 const run=await coordinator.registerBatch(batch,[payload]);
 if(checkpoint){
  const doc={schema:'tp.lens-document/1',image:{width:100,height:100},languages:{source:'en',target:'th'},paragraphs:[{id:'p0',sourceText:'Hello there',items:[]}]};
  await coordinator.capture(batch.id,{stage:'prepared',payload,result:{lensDocument:doc,eraseBoxes:{schema:'tp.erase-boxes/1',boxes:[]}},plan:{route:'server',ai:{provider:'login',translation_mode:'independent'}},units:[{id:'g0',text:'Hello there',translatable:true,paragraphIds:['p0']}],jobId});
  await coordinator.capture(batch.id,{stage:'finished',payload,jobId,accepted:[],failures:[{id:'g0',reason:'missing'}]});
 }
 // Use the actual initial-error owner gate and actual result consumer. A
 // terminal receipt cannot paint an Error while its repair owner is active.
 const pending=new Map([[jobId,ctx]]),delivery=createResultDelivery({pendingByJob:pending,getTabSessionId:()=> 'fixture-tab',getSettingsEpoch:()=>epoch,ensureBatch:()=>batch,classifyJobError:()=>({permanent:true}),imageErrorMessage,sendToTab:(_tab,message)=>inserted.push(message),removeJob:id=>pending.delete(id),markImagePhase,batchUpdateToast:noop,finalizeBatch:noop,isUrlOnlyPayload:()=>false,log:{warn:noop},shouldDeferImageError:({batch,imageKey,terminalAiError})=>terminalAiError&&coordinator.ownsInitialFailure(batch.id,imageKey),accountingQueue:{enqueue:async()=>{},flush:async()=>{},describe:()=>({})}});
 inserted.length=0;delivery.handleJobError(jobId,{code:'AI_OUTPUT_INVALID',message:'AI returned no usable translations',stage:'ai'});
 assert.equal(inserted.length,0,'Active repair must defer the initial error.');assert.equal(batch.items.get(pageId).deferredImageError?.type,'IMAGE_ERROR');
 if(unpinned)delete batch.items.get(pageId).deferredImageError.generation;
 if(foreign)batch.items.get(pageId).deferredImageError.original='https://fixture.invalid/foreign.png';
 if(repaired)await sessions.update(run.id,current=>{current.pages[pageId].delivered=true;return current;});
 if(unavailable)await sessions.update(run.id,current=>({...current,phase:'unavailable',lastError:'session_storage_unavailable'}));
 if(cancel){epoch++;await coordinator.cancelBatch(batch.id,'settings_changed');}
 await coordinator.finishInitial(batch);await sessions.flush();
 const errors=inserted.filter(message=>message.type==='IMAGE_ERROR');
 if(cancel||repaired||unpinned||foreign)assert.equal(errors.length,0,'Cancellation, confirmed placement and unowned fallback targets must never publish an error.');
 else{assert.equal(errors.length,1,'A terminal/unavailable repair must publish the saved image error: '+JSON.stringify({checkpoint,unavailable,phase:(await sessions.get(run.id))?.phase}));assert.equal(errors[0].error.code,'AI_OUTPUT_INVALID');assert.deepEqual(errors[0].generation,ctx.generation);}
 if(ack||cancel||repaired){await coordinator.finishInitial(batch);assert.equal(inserted.filter(message=>message.type==='IMAGE_ERROR').length,errors.length,'An acknowledged error is not republished on another terminal finish.');}
 return{coordinator,batch,sessions,inserted,run,events,reports,errors};
}
for(const[name,options]of[['terminal existing source',{}],['terminal missing checkpoint',{checkpoint:false}],['unavailable after initial deferral',{unavailable:true}],['unavailable missing checkpoint',{checkpoint:false,unavailable:true}],['settings cancellation',{cancel:true}],['confirmed placement',{repaired:true}],['missing checkpoint cannot paint unpinned legacy notice',{checkpoint:false,unpinned:true}],['missing checkpoint cannot paint foreign source',{checkpoint:false,foreign:true}]]){await fixture(options);checks.push(name);}
const unacknowledged=await fixture({ack:false});assert.equal(unacknowledged.batch.items.get('failure-page').deferredImageError?.type,'IMAGE_ERROR','Unconfirmed delivery retains the safe notice rather than claiming it was displayed.');checks.push('unacknowledged delivery retained');
console.log(JSON.stringify({passed:true,scope:'Actual repair coordinator registration/ownership + result delivery + terminal finish',count:checks.length,checks}));
