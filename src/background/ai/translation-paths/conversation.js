import {withLocalHistory} from "./local-history.js";
import {prepareConversation,appendPreparedMessages} from "../../../shared/ai/conversation/prompt.js";
import {localProviderContinuationStrategy} from "../../../shared/ai/providers/local-registry.js";
const RESPONSE_ID=/^resp_[A-Za-z0-9_-]{1,256}$/;
function invalidProviderState(code,message){
  return Object.assign(new Error(message),{code,requestDispatched:false,providerAttempts:0,generationAttempts:0});
}
function canonicalHistoryAssistant(prepared,units,translations,diagnostics,origins){
  const malformed=diagnostics?.malformedMarkerIds||[];
  if(!diagnostics?.redundantClosingDelimiterChars&&(!malformed.length||diagnostics?.malformedMarkersRecoverable!==true))return prepared.answer;
  const wireIds=(origins||[]).flatMap(page=>Array.isArray(page?.unitIds)?page.unitIds.map(String):[]);
  const ids=wireIds.length===units.length?wireIds:units.map((_,index)=>`P${index}`);
  const byId=new Map((translations||[]).map(row=>[String(row.id),String(row.text||"")]));
  return units.map((unit,index)=>{
    const value=(byId.get(String(unit.id))||"").replace(/\s+/gu," ").trim();
    if(!value)return "";
    const id=String(ids[index]);
    const open=id.startsWith("I")?`<<${id}`:`<<TP_${id}`;
    return `${open}:${value}>>`;
  }).filter(Boolean).join("\n");
}
export async function conversationTranslation(dispatch, units, options) {
  if(options.route!=="direct-local") return dispatch(units,options); // API is the only Cloud history owner.
  return withLocalHistory(options.ai,options.targetLang,options.sourceLang,options.signal,async state=>{
    let prepared,providerResultReturned=false;
    const emit=()=>{
      if(!prepared)return;
      try {options.trace?.("AI conversation path",prepared.evidence);}
      catch(error) {prepared.evidence.traceHookErrorCode=String(error?.code||error?.name||'trace_failed');}
    };
    const context={
      async prepare(input){
        const strategy=localProviderContinuationStrategy(options.ai?.provider);
        if(strategy==="native_response_cursor"&&input.protocol!=="lmstudio_native")
          throw invalidProviderState("ai_conversation_native_endpoint_mismatch",
            "The selected Local provider's retained Conversation endpoint is unavailable; check its adapter and endpoint");
        const native=strategy==="native_response_cursor";
        if(native&&!state.scope) throw invalidProviderState("ai_conversation_scope_missing",
          "LM Studio Conversation requires a document and owner scope before sending a request");
        prepared=await prepareConversation({...input,state,ai:options.ai});
        if(native){
          // A trimmed history is not the same provider thread. Create a new
          // anchor instead of sending a truncated logical context with an old ID.
          if(["context_budget","history_storage_budget"].includes(prepared.evidence.rolloverReason)){
            const {rolloverReason,trimmedTurns}=prepared.evidence;
            prepared=await prepareConversation({...input,state:{...state,history:[],prefix:""},ai:options.ai});
            Object.assign(prepared.evidence,{rolloverReason,trimmedTurns,providerThreadRollover:true});
          }
          const last=prepared.turns.at(-1);
          if(last&&!RESPONSE_ID.test(String(last.providerResponseId||"")))
            throw invalidProviderState("ai_conversation_state_missing",
              "LM Studio retained thread is unavailable for the last accepted turn; reset the Conversation scope");
          prepared.providerConversation={enabled:true,historyTurns:prepared.turns.length,
            previousResponseId:last?.providerResponseId||""};
          prepared.evidence.providerMemory=last?"continued_thread":"new_thread";
        }
        // Branch selection is speculative until the new answer is accepted.
        // Persisting it here could overwrite another worker's pending marker.
        await state.begin();
        prepared.evidence.continuationTransport=strategy;
        emit();return prepared;},
      messages:appendPreparedMessages,
      capture(text,responseId){if(prepared){prepared.answer=String(text||"");if(prepared.providerConversation)prepared.responseId=responseId;}}
    };
    try {
      const result=await dispatch(units,{...options,conversationContext:context});
      providerResultReturned=true;
      if(!prepared) throw new Error("Conversation route did not assemble history");
      const e=prepared.evidence,u=result.meta?.usage||{},d=result.meta?.contractDiagnostics||{};
      const cache=Number.isSafeInteger(u.cachedInputTokens)?u.cachedInputTokens:null;
      Object.assign(e,{cachedInputTokens:cache,actualInputTokens:u.inputTokens??null,actualOutputTokens:u.outputTokens??null,
        providerCacheStatus:cache===null?"not_reported":cache>0?"reported_hit":"reported_zero",
        providerCallsAdded:Math.max(1,Number(result.meta?.generationAttempts||result.meta?.providerAttempts)||1)});
      const ids=new Set(units.map(x=>String(x.id))),seen=new Set();
      // History preserves the exact provider-visible transcript for cache continuity.
      // Missing/wrong-language units are page-quality defects and already flow into
      // checkpoint + repair; they must not invalidate an otherwise usable chat turn.
      const translations=result.translations||[];
      const malformed=d.malformedMarkerIds||[];
      const structuralUsable=result.meta?.terminalCompleted===true&&
        ["duplicateIds","ignoredUnknownIds"].every(k=>!(d[k]||[]).length)&&
        (!malformed.length||!prepared.providerConversation&&d.malformedMarkersRecoverable===true)&&
        (!prepared.providerConversation||!d.redundantClosingDelimiterChars&&RESPONSE_ID.test(String(prepared.responseId||"")))&&
        !(d.unexpectedProseChars ?? (d.ignoredProse ? 1 : 0))&&
        translations.some(t=>ids.has(String(t.id))&&String(t.text||"").trim())&&translations.every(t=>{
          const id=String(t.id);if(!ids.has(id)||seen.has(id))return false;seen.add(id);return true;});
      Object.assign(e,{formattingWhitespaceChars:d.formattingWhitespaceChars||0,unexpectedProseChars:d.unexpectedProseChars||0,redundantClosingDelimiterChars:d.redundantClosingDelimiterChars||0});
      e.commitStatus=options.signal?.aborted?"not_committed_cancelled":!structuralUsable?"not_committed_invalid_output":"pending_commit";
      if(e.commitStatus!=="pending_commit") await state.rollback();
      if(e.commitStatus==="pending_commit"){
        const historyAssistant=canonicalHistoryAssistant(prepared,units,translations,d,options.ai.conversation?.origins||[]);
        try {
          const storage=await state.save({history:[...prepared.turns,{pages:options.ai.conversation?.origins||[],user:prepared.current,anchor:prepared.turns.length===0,assistant:historyAssistant,image:prepared.image,
            pageId:options.ai?.conversation?.pageId||"",pageIndex:options.ai?.conversation?.pageIndex,
            ...(prepared.providerConversation?{providerResponseId:prepared.responseId}:{})}],
            prefix:prepared.prefix,revision:state.revision+1});
          e.storage=storage;
          e.commitStatus=storage==="ephemeral"||storage==="local_memory"?"ephemeral_not_retained":
            storage==="history_storage_limit"?"history_storage_limit":"committed";
        } catch(error) {
          if(error?.code!=="ai_conversation_storage_unavailable")throw error;
          // The provider already completed this generation. Preserve its
          // translated result and usage receipt; fence later turns before
          // another provider call until a fresh Conversation scope starts.
          e.storage="unavailable";
          e.storageErrorCode=error.code;
          e.commitStatus="not_committed_storage_unavailable";
        }
      }
      result.meta={...result.meta,translationMode:"conversation",conversation:e,promptLayoutScope:"effective_provider_request"};
      e.phase="finished";emit();
      try {await options.wireTrace?.("timing",{conversation:e});}
      catch(error) {e.wireTraceErrorCode=String(error?.code||error?.name||'wire_trace_failed');}
      return result;
    } catch(error){
      if(!providerResultReturned)try {await state.rollback();} catch(rollbackError) {
        error.diagnostics={...(error.diagnostics||{}),historyRollbackErrorCode:rollbackError?.code||'unknown'};
      }
      if(prepared){prepared.evidence.phase="failed";prepared.evidence.commitStatus=options.signal?.aborted?"not_committed_cancelled":"not_committed_failed";
        prepared.evidence.providerCallsAdded=error?.requestDispatched===true||Number(error?.generationAttempts||error?.providerAttempts)>0?Math.max(1,Number(error?.generationAttempts||error?.providerAttempts)||1):0;emit();
        error.diagnostics={...(error.diagnostics||{}),conversation:prepared.evidence};
        try {await options.wireTrace?.("timing",{conversation:prepared.evidence});}
        catch(wireError) {prepared.evidence.wireTraceErrorCode=String(wireError?.code||wireError?.name||'wire_trace_failed');}}
      throw error;
    }
  });
}
