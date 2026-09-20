import {branchHistory,pageBoundaries,checkedOrigins} from "./origins.js";
// Pure history assembly. It never dispatches, retries, changes old prompts or updates UI.
import {estimateProviderInput} from "../workload/budget.js";
import {planOllamaContext} from "../providers/ollama-context.js";
const POLICY="conversation-image-records-2026.9.15.5";
const INTRO={
 th:"นี่คือการแปลต่อเนื่องในเอกสารเดียวกัน ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุด หากมีคำแปลก่อนหน้าที่สำเร็จอยู่ในประวัตินี้ ให้ใช้เป็นหลักเพื่อคงศัพท์ น้ำเสียง และรูปแบบให้ต่อเนื่อง แต่ต้นฉบับปัจจุบันที่ชัดเจนมีน้ำหนักเหนือกว่าเสมอ",
 ja:"同じ文書の翻訳を続けます。最後のユーザーメッセージのIDだけを返してください。この履歴に成功した以前の訳がある場合だけ、用語・口調・表現の一貫性の主な基準として使い、現在の明確な原文を常に優先してください。",
 en:"Continue translating this document. Return only IDs in the latest user message. When successful prior translations are present in this history, use them as the primary consistency reference for terminology, voice and phrasing, while always giving clear current source text precedence."
};
const REPAIR_NOTE={
 th:"นี่คือรอบซ่อมของเอกสารเดียวกัน ตอบเฉพาะ ID ในข้อความผู้ใช้ล่าสุด ใช้ประวัติคำแปลก่อนหน้าก็ต่อเมื่อมีอยู่จริงในคำขอนี้ มิฉะนั้นให้ยึดบริบทที่แนบและต้นฉบับปัจจุบัน ห้ามสมมติว่ามีประวัติที่ไม่ได้ส่งมา ID ที่ส่งมาซ่อมอาจมีเลขขาดช่วง ให้คัดลอก ID แต่ละรายการตามต้นฉบับและแปลเฉพาะข้อความที่อยู่ใน marker เดียวกัน ห้ามเรียงเลขใหม่ ห้ามเลื่อนคำแปลไปเติมช่องว่าง และห้ามนำข้อความบริบทมาเป็นรายการคำตอบ หากแปลรายการใดไม่ได้ ให้คง ID เดิมและตอบว่างเฉพาะรายการนั้น",
 ja:"同じ文書の修復要求です。最後のユーザーメッセージのIDだけを返してください。以前の訳はこの要求に実際に含まれている場合だけ参照し、なければ添付された文脈と現在の原文を基準にしてください。送られていない履歴を仮定しないでください。 修復対象のIDは連番とは限りません。各IDをそのままコピーし、同じマーカー内の原文だけを訳してください。番号の振り直し、欠番を埋めるための訳の移動、文脈を回答対象にすることは禁止です。訳せない項目は同じIDで空欄にしてください。",
 en:"This is a repair request for the same document. Return only IDs in the latest user message. Use prior translations only when they are actually present in this request; otherwise rely on the supplied context and current source. Do not assume unseen translation history. Repair IDs may have gaps. Copy each ID exactly and translate only the source inside that same marker. Never renumber, shift translations to fill gaps, or return context as target records. When an item cannot be translated, keep its original ID with an empty value."
};
async function hash(v){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");}
export async function prepareConversation({state,ai,layout,system,user,schema,imageDataUri,outputReserve,executedModel,protocol,selectedContract}) {
 const origins=checkedOrigins(ai.conversation?.origins);
 const chars=Array.from(user), fullStaticChars=layout.userStaticChars, persistentChars=Math.min(fullStaticChars,layout.userPersistentStaticChars??fullStaticChars);
 const templateStatic=chars.slice(0,fullStaticChars).join("");
 const tail=chars.slice(fullStaticChars+2).join("");
 const imageRecords=(origins.length>0&&origins.every(p=>(p.unitIds||[]).every(id=>/^I[1-9][0-9]{0,6}_P[0-9]{1,6}$/.test(id))));
 let persistentTemplate=imageRecords?templateStatic:chars.slice(0,persistentChars).join("");
 let bootstrapExamples="";
 if(imageRecords){
  bootstrapExamples=(layout.bootstrapExamplesChars||0)>0?"<persisted-in-anchor>":"";
 }else if(fullStaticChars>persistentChars){
  if(chars.slice(persistentChars,persistentChars+2).join("")!=="\n\n") throw new Error("conversation_bootstrap_example_boundary_mismatch");
  bootstrapExamples=chars.slice(persistentChars+2,fullStaticChars).join("");
 }
 const sourceOnly=imageRecords?(tail.match(/(?:^|\n)(<<I[1-9][0-9]{0,6}_P[0-9]{1,6}:[^\n]*>>(?:\n<<I[1-9][0-9]{0,6}_P[0-9]{1,6}:[^\n]*>>)*)\s*$/u)?.[1]||tail):tail;
 const intro=INTRO;
 let dynamic=imageRecords&&ai.conversation?.branch!=="repair"?sourceOnly:pageBoundaries(origins,layout.instructionLocale)+tail;
 if(ai.conversation?.branch==="repair") dynamic=(REPAIR_NOTE[layout.instructionLocale]||REPAIR_NOTE.en)+"\n\n"+dynamic;
 const staticText=persistentTemplate+"\n\n"+(intro[layout.instructionLocale]||intro.en);
 const anchorStatic=imageRecords?staticText:[staticText,bootstrapExamples].filter(Boolean).join("\n\n");
 const prefix=await hash(system+"\0"+anchorStatic), bounds=ai.model_capabilities?.limits||{};
 const compatibility=await hash(JSON.stringify([prefix,protocol,executedModel,ai.base_url,bounds.modelRevision||"",selectedContract]));
 let turns=[...state.history],reason="none",trimmed=0;
 if(state.prefix&&state.prefix!==compatibility){trimmed=turns.length;turns=[];reason="request_profile_changed";}
 let automaticBranch=false;
 if(ai.conversation?.branch!=="repair"){
  const b=branchHistory(turns,ai.conversation?.origins||[],ai.conversation?.orderPolicy||"request_arrival");
  if(b.reason!=="none"){turns=b.turns;reason=b.reason;automaticBranch=true;trimmed=state.history.length-turns.length;}
 }
 const limit=ai.provider==="ollama"?(planOllamaContext(bounds,{estimatedInput:1e9})?.evidence?.contextCeiling ?? bounds.contextTokens):bounds.contextTokens;
 const maxInput=Math.min(bounds.maxInputTokens||Infinity,limit?limit-outputReserve-128:32768);
 function compose(){
  // Replay committed provider-visible user bytes exactly. Only when an old anchor
  // is removed by context trimming do we create a new anchor, which necessarily
  // starts a new cache chain.
  const effectiveTurns=turns.map(t=>({...t}));
  if(effectiveTurns.length&&!effectiveTurns[0].anchor){
   effectiveTurns[0]={...effectiveTurns[0],user:[anchorStatic,effectiveTurns[0].user].filter(Boolean).join("\n\n"),anchor:true};
  }
  const history=effectiveTurns.flatMap(t=>[{role:"user",text:t.user,imageDataUri:t.image||""},{role:"assistant",text:t.assistant}]);
  const current=effectiveTurns.length?dynamic:[anchorStatic,dynamic].filter(Boolean).join("\n\n");
  const estimated=estimateProviderInput({system,user:current,schema,image:!!imageDataUri,history});
  return {history,current,estimated,effectiveTurns};
 }
 let prepared=compose();
 while(turns.length&&(prepared.estimated>maxInput||JSON.stringify(turns).length+user.length+(imageDataUri||"").length>934464)){
  reason=prepared.estimated>maxInput?"context_budget":"history_storage_budget";turns.shift();trimmed++;prepared=compose();
 }
 const base=estimateProviderInput({system,user:[anchorStatic,dynamic].filter(Boolean).join("\n\n"),schema,image:!!imageDataUri});
 const e={schema:"tp.conversation/1",policy:POLICY,mode:"conversation",path:"conversation",
  scope:state.scope?.slice(0,24)||"ephemeral",scopeStatus:state.scope?"ready":"scope_missing",
  pageCount:ai.conversation?.origins?.length||1,planner:ai.conversation?.origins?"conversation_cross_page":"conversation_request",
  historyRevision:state.revision,turnIndex:state.revision+1,historyTurns:turns.length,historyMessages:prepared.history.length,
  historyChars:prepared.history.reduce((n,m)=>n+Array.from(m.text).length,0),historyEstimatedTokens:Math.max(0,prepared.estimated-base),
  estimatedInput:prepared.estimated,currentUserChars:Array.from(prepared.current).length,staticUserRepeated:turns.length===0,
  bootstrapExamplesIncluded:!!bootstrapExamples,bootstrapExamplesPersisted:!!bootstrapExamples&&turns.length>0&&!!turns[0]?.anchor,
  bootstrapExamplesChars:imageRecords?(layout.bootstrapExamplesChars||0):(bootstrapExamples?Array.from(bootstrapExamples).length:0),
  queueWaitMs:state.queueWaitMs||0,trimmedTurns:trimmed,rolloverReason:reason,
  historySha256:await hash(JSON.stringify(prepared.history)),prefixSha256:prefix,branch:ai.conversation?.branch||"initial",
  orderPolicy:ai.conversation?.orderPolicy||"request_arrival",commitStatus:"pending",providerCacheStatus:"not_reported",
  storage:state.storage,historyQuality:"structural_and_script_checks_not_human_approved",
  historyMessageRoles:prepared.history.map(m=>m.role).join(","),contextLimit:limit||null,outputReserve,
  providerCallsAdded:0,legacyFallback:false,recordProtocol:imageRecords?"tp.translation.image-records/1":"tp.translation.compact-records/1",
  continuationUserOcrOnly:!!(imageRecords&&turns.length)};
 const effectiveStatic=anchorStatic;
 const effectiveLayout={...layout,examplesIncluded:e.bootstrapExamplesIncluded,
  userStaticChars:Array.from(effectiveStatic).length,userPersistentStaticChars:Array.from(staticText).length,
  bootstrapExamplesChars:e.bootstrapExamplesChars,dynamicChars:Array.from(dynamic).length,
  userStaticSha256:await hash(effectiveStatic),userPersistentStaticSha256:await hash(staticText),
  staticPrefixSha256:await hash(system+"\0"+effectiveStatic)};
 const historyOrigins=await Promise.all(prepared.effectiveTurns.map(async t=>({pages:t.pages||[],pageId:t.pageId||"",pageIndex:t.pageIndex??null,
  assistantSha256:await hash(t.assistant),sourceSha256:await hash(t.user)})));
 return {...prepared,origins:historyOrigins,automaticBranch,evidence:e,turns:prepared.effectiveTurns,prefix:compatibility,dynamic,image:imageDataUri||"",layout:effectiveLayout};
}
export function appendPreparedMessages(prepared,system,adapter) {
 return [{role:"system",content:system},...prepared.history.map(m=>m.role==="assistant"?{role:m.role,content:m.text}:
  {role:m.role,content:adapter.buildUserContent(m.text,m.imageDataUri),...adapter.userImageFields(m.imageDataUri)}),
  {role:"user",content:adapter.buildUserContent(prepared.current,prepared.image),...adapter.userImageFields(prepared.image)}];
}
