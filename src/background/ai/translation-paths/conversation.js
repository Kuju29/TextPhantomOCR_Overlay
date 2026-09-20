import {withLocalHistory} from "./local-history.js";
import {prepareConversation,appendPreparedMessages} from "../../../shared/ai/conversation/prompt.js";
function canonicalHistoryAssistant(prepared,units,translations,diagnostics,origins){
  const malformed=diagnostics?.malformedMarkerIds||[];
  if(!malformed.length||diagnostics?.malformedMarkersRecoverable!==true)return prepared.answer;
  const wireIds=(origins||[]).flatMap(page=>Array.isArray(page?.unitIds)?page.unitIds.map(String):[]);
  const ids=wireIds.length===units.length?wireIds:units.map((_,index)=>`P${index}`);
  return units.map((_,index)=>{
    const value=String(translations?.[index]?.text||"").replace(/\s+/gu," ").trim();
    if(!value)return "";
    const id=String(ids[index]);
    const open=id.startsWith("I")?`<<${id}`:`<<TP_${id}`;
    return `${open}:${value}>>`;
  }).filter(Boolean).join("\n");
}
export async function conversationTranslation(dispatch, units, options) {
  if(options.route!=="direct-local") return dispatch(units,options); // API is the only Cloud history owner.
  return withLocalHistory(options.ai,options.targetLang,options.sourceLang,options.signal,async state=>{
    let prepared;
    const emit=()=>{if(prepared) options.trace?.("AI conversation path",prepared.evidence);};
    const context={
      async prepare(input){prepared=await prepareConversation({...input,state,ai:options.ai});
        if(prepared.automaticBranch){await state.save({history:prepared.turns,prefix:prepared.prefix,revision:state.revision+1});}
        emit();return prepared;},
      messages:appendPreparedMessages,
      capture(text){if(prepared)prepared.answer=String(text||"");}
    };
    try {
      const result=await dispatch(units,{...options,conversationContext:context});
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
        (!malformed.length||d.malformedMarkersRecoverable===true)&&!(d.unexpectedProseChars ?? (d.ignoredProse ? 1 : 0))&&
        translations.some(t=>ids.has(String(t.id))&&String(t.text||"").trim())&&translations.every(t=>{
          const id=String(t.id);if(!ids.has(id)||seen.has(id))return false;seen.add(id);return true;});
      Object.assign(e,{formattingWhitespaceChars:d.formattingWhitespaceChars||0,unexpectedProseChars:d.unexpectedProseChars||0});
      e.commitStatus=options.signal?.aborted?"not_committed_cancelled":!structuralUsable?"not_committed_invalid_output":"pending_commit";
      if(e.commitStatus==="pending_commit"){
        const historyAssistant=canonicalHistoryAssistant(prepared,units,translations,d,options.ai.conversation?.origins||[]);
        const storage=await state.save({history:[...prepared.turns,{pages:options.ai.conversation?.origins||[],user:prepared.current,anchor:prepared.turns.length===0,assistant:historyAssistant,image:prepared.image,
          pageId:options.ai?.conversation?.pageId||"",pageIndex:options.ai?.conversation?.pageIndex}],prefix:prepared.prefix,revision:state.revision+(prepared.automaticBranch?2:1)});
        e.storage=storage;
        e.commitStatus=storage==="ephemeral"?"ephemeral_not_retained":storage==="history_storage_limit"?"history_storage_limit":"committed";
      }
      result.meta={...result.meta,translationMode:"conversation",conversation:e,promptLayoutScope:"effective_provider_request"};
      e.phase="finished";emit();await options.wireTrace?.("timing",{conversation:e});return result;
    } catch(error){
      if(prepared){prepared.evidence.phase="failed";prepared.evidence.commitStatus=options.signal?.aborted?"not_committed_cancelled":"not_committed_failed";
        prepared.evidence.providerCallsAdded=error?.requestDispatched===true||Number(error?.generationAttempts||error?.providerAttempts)>0?Math.max(1,Number(error?.generationAttempts||error?.providerAttempts)||1):0;emit();
        error.diagnostics={...(error.diagnostics||{}),conversation:prepared.evidence};
        await options.wireTrace?.("timing",{conversation:prepared.evidence});}
      throw error;
    }
  });
}
