import '../../shared/diagnostic-schema.js';
// Volatile UI view only; no extra storage, no prompt/source/credential copies.
// The existing trace is the durable diagnostic record when diagnostics are enabled.
const rows=new Map();
export function rememberDiagnostic({provider,model,operationId,budget,result,layout,coordination,conversation}) {
  if (!operationId) return;
  const previous=rows.get(operationId)||{};
  const row={...previous,at:Date.now(),provider:String(provider||previous.provider||'').slice(0,100),
    model:String(model||previous.model||'').slice(0,180),operationId:String(operationId).slice(0,200)};
  if(conversation)row.conversation=globalThis.TPAuditSchema.sanitizeConversation(conversation);
  if(coordination)row.coordination=globalThis.TPAuditSchema.sanitizeCacheCoordination(coordination);
  if(budget)row.budget=globalThis.TPAuditSchema.sanitize(budget);
  if(result)row.result=globalThis.TPAuditSchema.sanitize(result);
  if(layout)row.layout={
    styleRole:['user','system','both','absent'].includes(layout.styleRole)?layout.styleRole:'unknown',
    systemStyleCopies:Number.isSafeInteger(layout.systemStyleCopies)&&layout.systemStyleCopies>=0?layout.systemStyleCopies:null,
    userStyleCopies:Number.isSafeInteger(layout.userStyleCopies)&&layout.userStyleCopies>=0?layout.userStyleCopies:null,
    styleChars:Number.isSafeInteger(layout.styleChars)&&layout.styleChars>=0?layout.styleChars:null,
    styleSha256:/^[a-f0-9]{64}$/.test(layout.styleSha256||'')?layout.styleSha256:null,
    policyVersion:/^[a-z0-9.-]{1,100}$/.test(layout.policyVersion||'')?layout.policyVersion:null,
    instructionLocale:['th','en','ja'].includes(layout.instructionLocale)?layout.instructionLocale:'en',
    examplesEnabled:layout.examplesEnabled===true,examplesIncluded:layout.examplesIncluded===true,
    memoryMode:['off','terms','full'].includes(layout.memoryMode)?layout.memoryMode:'legacy_filtered',
    systemChars:Number.isSafeInteger(layout.systemChars)?layout.systemChars:null,
    userStaticChars:Number.isSafeInteger(layout.userStaticChars)?layout.userStaticChars:null,
    userPersistentStaticChars:Number.isSafeInteger(layout.userPersistentStaticChars)?layout.userPersistentStaticChars:null,
    bootstrapExamplesChars:Number.isSafeInteger(layout.bootstrapExamplesChars)?layout.bootstrapExamplesChars:null,
    staticPrefixSha256:/^[a-f0-9]{64}$/.test(layout.staticPrefixSha256||'')?layout.staticPrefixSha256:null};
  rows.delete(operationId);rows.set(operationId,row);
  while(rows.size>32)rows.delete(rows.keys().next().value);
}
export function recentDiagnostic(provider,model) {
  const row=[...rows.values()].reverse().find(r=>r.provider===provider&&r.model===model);
  return row?structuredClone(row):null;
}
export function clearRecentDiagnostics(){rows.clear();}
