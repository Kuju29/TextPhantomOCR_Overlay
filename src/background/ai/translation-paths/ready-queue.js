// Collect READY source units, not provider requests. No timer, debounce or warmup.
// Each output is projected back to its page; accounting stays inside dispatch.
import {createStreamRecords} from './stream-records.js';
import {checkedOrigins} from '../../../shared/ai/conversation/origins.js';
import {conversationTicket,conversationTickets,onConversationReady,fenceConversationBilling} from './order.js';
import {isProviderBillingFailure} from '../../../shared/error-contract.js';
const abortError=()=>new DOMException('Conversation page cancelled','AbortError');
export function createReadyQueue({choose,dispatch,trace=()=>{}}) {
  const groups=new Map(); let scheduled=false;
  const wake=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;for(const g of groups.values())pump(g);});};
  const detach=onConversationReady(wake);
  function waiting(e,reason) {
    const now=performance.now();
    if(e.waitReason===reason)return;
    if(e.waitReason==='waiting_for_previous_turn')e.previousWait+=now-e.waitSince;
    if(e.waitReason==='waiting_for_source_order')e.sourceWait+=now-e.waitSince;
    e.waitReason=reason;e.waitSince=now;
    if(reason)trace({schema:'tp.conversation_batch/1',phase:'queued',planner:'conversation_cross_page',
      queueReason:reason,pageCount:1,unitCount:e.units.length-e.offset,firstOrder:e.ticket.order,lastOrder:e.ticket.order,
      legacyFallback:false,providerCallsAdded:0},e.options);
  }
  function finish(entry,error) {
    if(entry.settled)return;waiting(entry,'');entry.settled=true;
    if(error)entry.cancelShared?.();entry.ticket.consumed=true;
    entry.signal?.removeEventListener('abort',entry.abort);
    entry.group.entries.delete(entry.ticket);
    if(error)entry.reject(error);
    else (entry.provisionalTask || Promise.resolve()).then(()=>entry.resolve({schema:'tp.ai.result/1',translations:entry.units.flatMap(u=>entry.translated.has(String(u.id))?[{id:u.id,text:entry.translated.get(String(u.id))}]:[]),
      missing:entry.units.filter(u=>!entry.translated.has(String(u.id))).map(u=>String(u.id)),
      memoryDelta:{characters:[],glossary:[]},meta:{route:entry.options.route,translationMode:'conversation',
        planner:'conversation_cross_page',usageScope:'shared_request_references',sharedRequestRefs:entry.refs,
        // No full-request usage in a page projection. The transport committed it once.
        generationAttempts:entry.refs.length,providerAttempts:entry.refs.length,omittedIds:[],declinedIds:[],
        conversation:entry.conversation,streamFailure:entry.streamFailure||null,automaticContentRetry:false}}));
    wake();
  }
  async function pump(g) {
    for(const e of g.entries.values()) {
      if(e.ticket.done&&!e.settled)finish(e,abortError());
      else if(e.ticket.billingFailure&&!e.inFlight&&!e.settled)finish(e,e.ticket.billingFailure);
    }
    if(g.running){for(const e of g.entries.values())if(!e.inFlight&&!e.settled)waiting(e,'waiting_for_previous_turn');return;}
    // OCR stays parallel. Dispatch the contiguous ready prefix in webpage order;
    // a terminal reservation disappears, so cancelled/no-text pages cannot block it.
    const candidates=[...g.entries.values()].filter(e=>!e.settled);
    const ready=[];g.waitReason="ready";
    for(const ticket of conversationTickets(g.key)){
      const e=g.entries.get(ticket);
      if(!e){g.waitReason='waiting_for_source_order';break;}
      if(e.signal?.aborted){finish(e,abortError());continue;}
      if(!e.units.length){finish(e);continue;}
      if(ready.length && (e.compat!==ready[0].compat || e.options.imageDataUri || ready[0].options.imageDataUri)){g.waitReason=e.compat!==ready[0].compat?'context_boundary':'image_boundary';break;}
      if(ready.some(r=>r.pageId===e.pageId)){g.waitReason='repeated_page_boundary';break;}
      ready.push(e);
    }
    for(const e of candidates)if(!ready.includes(e)&&!e.settled)waiting(e,g.waitReason==='waiting_for_source_order'?g.waitReason:'waiting_for_previous_turn');
    if(!ready.length){if(!g.entries.size)groups.delete(g.key);return;}
    g.running=true;let cleanup=()=>{};
    try {
      const rows=ready.flatMap(e=>e.units.slice(e.offset).map((u,localIndex)=>({
        entry:e, originalId:String(u.id), text:String(u.text||''),
        // Stable for the life of this document Conversation. The image ordinal
        // comes from the reserved document order, never from the current request.
        id:`I${e.ticket.order}_P${e.offset+localIndex}`
      })));
      const mapped=rows;
      const pageSizes=ready.map(e=>e.units.length-e.offset);
      const planningStarted=performance.now();
      const plan=await choose(mapped,{...ready[0].options,
        conversationContinuation:g.hasCommittedTurn,conversationCacheConfirmed:g.cacheConfirmed===true,
        conversationCacheRatio:Number(g.cacheRatio)||0,conversationCacheMissStreak:Number(g.cacheMissStreak)||0,
        conversationPreviousUnitCount:Number(g.lastCommittedUnits)||0,conversationPreviousTurnMs:Number(g.lastTurnMs)||0,
        conversationPageSizes:pageSizes});
      const planningMs=performance.now()-planningStarted;
      if(!plan?.units?.length)throw Object.assign(new Error('Conversation planner selected no units'),{code:'ai_conversation_empty_batch'});
      const picked=plan.units.map(u=>mapped.find(r=>r.id===u.id));
      if(picked.some(r=>!r))throw new Error('Conversation planner lost unit ownership');
      const pages=[...new Set(picked.map(r=>r.entry))];
      if(pages.some(e=>e.settled||e.signal?.aborted||e.ticket.billingFailure)){await plan.session?.flush?.();return;} // Re-select before dispatch; no source loss.
      for(const e of pages){waiting(e,'');e.inFlight=true;}
      for(const e of g.entries.values())if(!pages.includes(e)&&!e.settled)waiting(e,'waiting_for_previous_turn');
      const controller=new AbortController();
      const cancel=()=>{if(pages.every(e=>e.signal?.aborted||e.settled))controller.abort();};
      for(const e of pages){e.cancelShared=cancel;e.signal?.addEventListener('abort',cancel);}
      cleanup=()=>{for(const e of pages){e.inFlight=false;e.cancelShared=null;e.signal?.removeEventListener('abort',cancel);}};
      const batchId=crypto.randomUUID(),started=performance.now();
      let checkpointBeforeMs=0,providerRoundTripMs=0,projectionStarted=0;
      g.turnIndex=(Number(g.turnIndex)||0)+1;
      try{ready[0].options.onConversationStatus?.({phase:'translating',turn:g.turnIndex,
        pageCount:pages.length,unitCount:picked.length,readyPageCount:ready.length,readyUnitCount:mapped.length,
        queuedPageCount:Math.max(0,ready.length-pages.length),cacheConfirmed:g.cacheConfirmed===true,
        cacheRatio:Number(g.cacheRatio)||0,previousUpstreamProvider:String(g.upstreamProvider||''),
        previousProviderMs:Number(g.lastTurnMs)||0,updatedAt:Date.now()});}catch{}
      const origins=checkedOrigins(pages.map(e=>({pageId:e.pageId,pageIndex:e.pageIndex,pageOrder:e.ticket.order,
        sourceFingerprint:e.sourceFingerprint,unitIds:picked.filter(r=>r.entry===e).map(r=>r.id),originalIds:picked.filter(r=>r.entry===e).map(r=>r.originalId)})), picked.map(r=>r.id));
      const evidence={schema:'tp.conversation_batch/1',mappingStatus:'validated',idPolicy:'conversation_image_unit_v1',planner:'conversation_cross_page',phase:'dispatch',batchId,
        pageCount:pages.length,unitCount:picked.length,readyPageCount:ready.length,readyUnitCount:mapped.length,
        splitReason:plan.splitReason==='end_of_page'?'ready_queue_drained':plan.splitReason,
        schedulingPolicy:'webpage_order',queueReason:g.waitReason||'ready',firstOrder:pages[0].ticket.order,lastOrder:pages.at(-1).ticket.order,
        estimatedInput:plan.estimate?.estimatedInput,predictedOutput:plan.estimate?.predictedOutput,
        conversationCapacity:plan.estimate?.conversationCapacity,cacheConfirmed:g.cacheConfirmed===true,cacheRatio:Number(g.cacheRatio)||0,
        previousUpstreamProvider:String(g.upstreamProvider||''),previousProviderMs:Number(g.lastTurnMs)||0,
        legacyFallback:false,providerCallsAdded:0,planningMs,readyQueueWaitMs:Math.max(...pages.map(e=>e.sourceWait+e.previousWait)),
        previousTurnWaitMs:Math.max(...pages.map(e=>e.previousWait)),sourceOrderWaitMs:Math.max(...pages.map(e=>e.sourceWait))};
      trace(evidence,ready[0].options);
      const checkpointStarted=performance.now();
      await Promise.all(pages.map(e=>e.options.beforeBatchDispatch?.({batchId,estimate:plan.estimate,
        units:picked.filter(r=>r.entry===e).map(r=>({id:r.originalId,text:r.text}))})));
      checkpointBeforeMs=performance.now()-checkpointStarted;
      if(pages.some(e=>e.signal?.aborted||e.settled||e.ticket.billingFailure)){
        for(const e of pages){e.inFlight=false;e.signal?.removeEventListener('abort',cancel);}
        await plan.session?.flush?.();return;
      }
      let answer,error;
      const stream=createStreamRecords(picked.map(({id,text})=>({id,text})));
      const provisionalTasks=new Map(),provisionalShown=new Set();
      const publish=(values,terminal=false,failure=null)=>{
        for(const e of pages){
          if(e.signal?.aborted||e.settled)continue;
          const merged=new Map(e.translated);
          for(const r of picked.filter(r=>r.entry===e)){
            if(values.get(r.id)?.trim())merged.set(r.originalId,values.get(r.id));
            else merged.delete(r.originalId);
          }
          const complete=e.units.every(u=>merged.has(String(u.id)));
          if(!complete&&!provisionalShown.has(e))continue;
          const translations=[...merged].map(([id,text])=>({id,text}));
          const signature=JSON.stringify(translations);
          if(e.provisionalSignature===signature&&!failure)continue;
          e.provisionalSignature=signature;provisionalShown.add(e);
          const recordsCompleteAt=complete?Date.now():null;
          if(complete)trace({schema:'tp.audit/1',event:'page_stream_timing',reason:'records_complete',
            operationId:batchId,imageId:e.options.imageId,pageId:e.pageId,pageOrder:e.ticket.order,
            unitCount:e.units.length,recordsCompleteAt,streamRevision:stream.revision},e.options);
          const data={batchId,translations,units:e.units,complete,terminal,failure,
            streamTiming:{operationId:batchId,imageId:e.options.imageId,pageId:e.pageId,pageOrder:e.ticket.order,recordsCompleteAt,streamRevision:stream.revision},
            missing:e.units.filter(u=>!merged.has(String(u.id))).map(u=>String(u.id))};
          const previous=provisionalTasks.get(e)||Promise.resolve();
          const task=previous.then(()=>{
            if(!e.signal?.aborted&&!e.settled)return e.options.onProvisionalResult?.(data);
          }).catch(err=>{e.provisionalError=err;trace({...evidence,phase:'failed',failureCode:'provisional_render_failed'},e.options);});
          provisionalTasks.set(e,task);e.provisionalTask=task;
        }
      };
      const providerStarted=performance.now();
      try {answer=await dispatch(picked.map(({id,text})=>({id,text})),ready[0].options,{...plan,batchId,origins,signal:controller.signal,
        onProgress:p=>{
          if(p?.state==='translation_delta'){const before=stream.revision;stream.push(p.text);if(stream.revision!==before)publish(stream.accepted);}
          else pages.forEach(e=>e.options.onProgress?.(p));
        }});}
      catch(e){error=e;}
      finally{providerRoundTripMs=performance.now()-providerStarted;for(const e of pages){e.inFlight=false;e.signal?.removeEventListener('abort',cancel);}}
      stream.finish();
      projectionStarted=performance.now();
      if(error) trace({...evidence,phase:'failed',apiHttpStatus:Number.isInteger(error.status)?error.status:null,
        validationField:error.validation?.field,validationReason:error.validation?.reason,
        failureCode:['ai_conversation_origin_invalid','invalid_request'].includes(error.code)?error.code:'other',
        failureStage:error.stage==='conversation_mapping'?'conversation_mapping':error.requestDispatched===false?'api_request_validation':error.requestDispatched===true?'provider':'unknown',
        mappingStatus:error.code==='ai_conversation_origin_invalid'?'rejected':'validated',
        requestDispatched:typeof error.requestDispatched==='boolean'?error.requestDispatched:null,
        providerCallsAdded:error.requestDispatched===true||Number(error.generationAttempts||error.providerAttempts)>0?Math.max(1,Number(error.generationAttempts||error.providerAttempts)||1):0,
        providerRequestCount:Number.isInteger(error.providerAttempts)?error.providerAttempts:null,checkpointBeforeMs,providerRoundTripMs,
        batchTotalMs:performance.now()-started},ready[0].options);
      if(isProviderBillingFailure(error)) {
        fenceConversationBilling(pages.find(e=>!e.settled&&!e.ticket.done)?.ticket);
        for(const e of [...g.entries.values()]) {
          if(pages.includes(e))finish(e,error);
          else if(e.ticket.billingFailure)finish(e,e.ticket.billingFailure);
        }
        return;
      }
      if(error?.requestDispatched===false||error?.name==='AbortError'){
        for(const e of pages)finish(e,error);return;
      }
      let recoverable=error&&(error.requestDispatched===true||Number(error.generationAttempts||error.providerAttempts)>0)&&
        /invalid_model_output|output_budget_exhausted|wrong_language|output_contract|invalid_result_schema/i.test(String(error.code||''));
      if(error&&stream.revision>0){
        answer={translations:[...stream.accepted].map(([id,text])=>({id,text})),meta:{streamFailure:{code:String(error.code||'provider_stream_failed'),message:String(error.message||error)}}};
        recoverable=true;
      }
      const conversationState=answer?.meta?.conversation||error?.generationMeta?.conversation||error?.structuralDetails?.generationMeta?.conversation||error?.diagnostics?.conversation||{};
      const committed=conversationState.historyTurns>0 || ["pending_commit","committed","ephemeral_not_retained"].includes(conversationState.commitStatus);
      if(committed){
        g.hasCommittedTurn=true;
        g.lastCommittedUnits=picked.length;
        // Capacity should react to AI/transport time, not storage/projection overhead.
        g.lastTurnMs=Math.max(0,providerRoundTripMs);
      }
      // Never retry an entire anchor merely because a few units are missing or fail
      // target-script validation.  The Conversation owner now commits structurally
      // usable provider replies and page defects flow to the normal repair pool.
      // If a truly malformed anchor cannot be committed, distribute/fail only this
      // request and let the next source page establish a fresh anchor; never cascade
      // one page failure across every queued page.
      const actualInput=Number(conversationState.actualInputTokens),cachedInput=Number(conversationState.cachedInputTokens);
      const resolvedUpstream=String(conversationState.resolvedUpstreamProvider||'').trim();
      if(resolvedUpstream)g.upstreamProvider=resolvedUpstream;
      if(Number.isFinite(actualInput)&&actualInput>0&&Number.isFinite(cachedInput)&&cachedInput>0){
        g.cacheConfirmed=true;g.cacheRatio=Math.max(0,Math.min(1,cachedInput/actualInput));g.cacheMissStreak=0;
      }else if(g.hasCommittedTurn&&Number.isFinite(actualInput)&&actualInput>0){
        g.cacheMissStreak=(Number(g.cacheMissStreak)||0)+1;
      }
      try{ready[0].options.onConversationStatus?.({phase:error?'turn_failed':'turn_complete',turn:g.turnIndex,
        pageCount:pages.length,unitCount:picked.length,readyPageCount:ready.length,readyUnitCount:mapped.length,
        cacheConfirmed:g.cacheConfirmed===true,cacheRatio:Number(g.cacheRatio)||0,cachedInputTokens:Number.isFinite(cachedInput)?cachedInput:null,
        actualInputTokens:Number.isFinite(actualInput)?actualInput:null,upstreamProvider:String(g.upstreamProvider||''),
        providerMs:Number(g.lastTurnMs)||0,updatedAt:Date.now()});}catch{}
      const returned=new Map(), duplicates=new Set();
      for(const t of answer?.translations||[]){const id=String(t.id);if(returned.has(id))duplicates.add(id);returned.set(id,String(t.text||''));}
      for(const id of [...duplicates,...stream.invalid])returned.delete(id);
      publish(returned,true,error||null);
      let applied=0,cancelled=0;
      const projections=[];
      for(const e of pages){
        const own=picked.filter(r=>r.entry===e);e.offset+=own.length;
        e.refs.push({operationId:batchId,requestUnits:picked.length,pageUnits:own.length,receiptShared:pages.length>1});
        e.conversation=answer?.meta?.conversation;
        if(answer?.meta?.streamFailure)e.streamFailure=answer.meta.streamFailure;
        if(e.signal?.aborted||e.settled){cancelled+=own.length;finish(e,abortError());continue;}
        if(!error||recoverable)for(const r of own){if(!duplicates.has(r.id)&&returned.get(r.id)?.trim()){e.translated.set(r.originalId,returned.get(r.id));applied++;}}
        if(error&&!answer&&!recoverable){finish(e,error);continue;}
        const data={batchId,translations:own.flatMap(r=>e.translated.has(r.originalId)?[{id:r.originalId,text:e.translated.get(r.originalId)}]:[]),
          streamFailure:answer?.meta?.streamFailure||null,missing:own.filter(r=>!e.translated.has(r.originalId)).map(r=>r.originalId),units:own.map(r=>({id:r.originalId,text:r.text}))};
        // Pages in one Conversation request are independent projections of the
        // same provider response. Run their durable progress checkpoints together
        // so the per-run session store can coalesce the burst into one write
        // instead of serially paying one storage round-trip per page.
        projections.push((async()=>{
          try{await e.options.afterBatchResult?.(data);return {e,failure:null};}
          catch(failure){return {e,failure};}
        })());
      }
      const projectionResults=await Promise.all(projections);
      const batchTotalMs=performance.now()-started;
      trace({...evidence,phase:'distributed',mappedUnits:applied,cancelledUnits:cancelled,missingUnits:picked.length-applied-cancelled,
        providerCallsAdded:1,requestMs:batchTotalMs,batchTotalMs,checkpointBeforeMs,providerRoundTripMs,
        projectionMs:Math.max(0,performance.now()-projectionStarted),usageOwner:'provider_request',providerRequestCount:1},ready[0].options);
      for(const {e,failure} of projectionResults){
        if(failure)finish(e,failure);
        else if(e.offset===e.units.length)finish(e);
      }
    } catch(error) {finish(ready[0],error);}
    finally{cleanup();g.running=false;wake();}
  }
  return {
    submit(units,options) {
      const ticket=conversationTicket(options.payload);
      if(!ticket)return Promise.reject(Object.assign(new Error('Conversation source has no owner/document reservation'),{code:'ai_conversation_scope_missing',requestDispatched:false}));
      if(ticket.billingFailure){ticket.consumed=true;return Promise.reject(ticket.billingFailure);}
      let group=groups.get(ticket.key);if(!group){group={key:ticket.key,entries:new Map(),running:false,readySequence:0,hasCommittedTurn:false,cacheConfirmed:false,cacheRatio:0,cacheMissStreak:0,turnIndex:0,lastCommittedUnits:0,lastTurnMs:0,upstreamProvider:''};groups.set(ticket.key,group);}
      if(group.entries.has(ticket))return Promise.reject(new Error('Page already queued for conversation'));
      return new Promise((resolve,reject)=>{
        const e={ticket,group,units,options,resolve,reject,signal:options.signal,offset:0,translated:new Map(),refs:[],settled:false,
          pageId:String(options.imageId||''),pageIndex:options.ai.conversation?.pageIndex,
          waitReason:'',waitSince:performance.now(),sourceWait:0,previousWait:0,inFlight:false,
          sourceFingerprint:options.sourceFingerprint||'',readyOrder:++group.readySequence,compat:JSON.stringify([options.route,options.targetLang,options.sourceLang,
            options.ai.glossary,options.ai.characters,options.ai.series_state,options.ai.prev_context,options.ai.speakers,
            options.ai.source_context,options.ai.context_frozen,options.ai.output_contract,options.ai.model_capabilities]),created:performance.now()};
        e.abort=()=>finish(e,abortError());group.entries.set(ticket,e);
        if(e.signal?.aborted)e.abort();else e.signal?.addEventListener('abort',e.abort,{once:true});
        wake();
      });
    },
    close(){detach();for(const g of groups.values())for(const e of g.entries.values())finish(e,abortError());groups.clear();}
  };
}
