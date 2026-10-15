import { CHANGE_HEADER, noteResponseChanges } from './change-signals.js';
/** Metadata-only diagnostics; independent of console level and TP_TRACE. */
const id = () => globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
const run=id(); let seq=0, direct=null;
const valid=value=>/^[A-Za-z0-9_.:-]{0,160}$/.test(String(value||''))?String(value||''):'';
export const diagnosticId=id;
export function setDiagnosticSink(fn){direct=typeof fn==='function'?fn:null;}
export function diagnosticRecord(event, fields={}){
  const allowed=['trace_id','request_id','center_request_id','operation_id','run_id','job_id','batch_id','image_id','error_code','error_type',
    'outcome','method','reason','action','capability','state','mode','version','source','request_status','delivery_status',
    'provider','stage','provider_reason','flow_ref'];
  const data={};
  for(const key of allowed)if(fields[key]!==undefined)data[key]=valid(fields[key]);
  for(const key of ['http_status','upstream_status','elapsed_ms','attempt','pending','dropped','retry_after_ms','input_tokens','output_tokens'])
    if(Number.isFinite(fields[key]))data[key]=Math.max(0,fields[key]);
  for(const key of ['enabled','available','configured','authenticated','session_present','code_present','registered','terminal','retryable'])
    if(typeof fields[key]==='boolean')data[key]=fields[key];
  if(fields.path)data.path=String(fields.path).split('?')[0].replace(/[^/]*@[^/]*/g,'[private]').slice(0,200);
  return {diagnostic:true,schema:'tp.diagnostic/1',event:valid(event),...data,
    t:Date.now(),client_run:run,client_n:++seq,source_trust:'client_reported'};
}
export function recordDiagnostic(event,fields={},apiBase=''){
  const row=diagnosticRecord(event,fields);
  try{
    if(direct){direct(row);return row;}
    const message={type:'TP_DIAGNOSTIC_EVENT',record:row,apiBase:String(apiBase||'').replace(/\/+$/,'')};
    const result=globalThis.chrome?.runtime?.sendMessage?.(message);
    result?.catch?.(()=>{});
  }catch{}
  return row;
}
export function configureDiagnosticsFromMeta(base,data){
  if(typeof data?.diagnostics?.log_file!=='boolean')return;
  try{globalThis.chrome?.runtime?.sendMessage?.({type:'TP_DIAGNOSTICS_CONFIG',apiBase:base,enabled:data.diagnostics.log_file})?.catch?.(()=>{});}catch{}
}
export async function diagnosticFetch(url,options={}){
  const headers=new Headers(options.headers||{});
  const tid=headers.get('X-TP-Trace-ID')||id(); headers.set('X-TP-Trace-ID',tid);
  if(!headers.has('X-TP-Client-Version')){
    let version='2026.10.1.5';try{version=chrome.runtime.getManifest().version;}catch{}
    headers.set('X-TP-Client-Version',version);
  }
  let path='',base='';try{const u=new URL(url);path=u.pathname;base=u.origin;}catch{}
  // Do not include query strings, headers, bodies, email addresses or error text.
  const method=options.method||'GET',start=Date.now();
  recordDiagnostic('http.started',{trace_id:tid,method,path,authenticated:headers.has('Authorization')},base);
  try{
    const response=await fetch(url,{...options,headers:Object.fromEntries([...headers.entries()].map(([k,v])=>[({'authorization':'Authorization','content-type':'Content-Type','accept':'Accept','x-tp-trace-id':'X-TP-Trace-ID','x-tp-client-version':'X-TP-Client-Version'})[k]||k,v]))});
    recordDiagnostic('http.response',{trace_id:tid,request_id:response.headers?.get?.('X-Request-ID')||'',
      center_request_id:response.headers?.get?.('X-TP-Center-Request-ID')||'',method,path,http_status:response.status,
      elapsed_ms:Date.now()-start,outcome:response.ok?'ok':'error'},base);
    // Attach diagnostic metadata without changing the payload or consuming it.
    try{Object.defineProperty(response,'tpTraceId',{value:tid});}catch{}
    // Account/support responses carry change tokens; remember them so the
    // extension fetches a topic only when its token moved (shared/change-signals.js).
    try{const changes=response.headers?.get?.(CHANGE_HEADER);if(changes&&path.includes('/paid/'))noteResponseChanges(url,headers.get('Authorization'),changes);}catch{}
    return response;
  }catch(error){
    recordDiagnostic('http.failed',{trace_id:tid,method,path,error_type:error?.name||'NetworkError',
      error_code:error?.name==='AbortError'?'ABORTED_OR_TIMEOUT':'NETWORK_UNAVAILABLE',elapsed_ms:Date.now()-start,outcome:'error'},base);
    try{error.tpTraceId=tid;}catch{}
    throw error;
  }
}
