import { getApiBase } from './api.js';
import { initializeLogJournal,setLogShippingEnabled,recordLogLine,persistLogJournal,flushLogs,logShippingState } from '../shared/log-sink.js';
import { diagnosticRecord,setDiagnosticSink } from '../shared/diagnostics.js';
const normalize=x=>String(x||'').replace(/\/+$/,'');
let probing=false,retry=null;
export async function configureDiagnosticShipping(base,on){
  const saved=normalize(await getApiBase({warm:false}));
  if(!saved||normalize(base)!==saved)return {ok:false,reason:'api_scope_mismatch'};
  await initializeLogJournal(saved);
  setLogShippingEnabled(Boolean(on),()=>saved,saved,{authoritative:true});
  recordLogLine(diagnosticRecord('logging.configured',{enabled:Boolean(on),source:'api_meta'}));
  await persistLogJournal();void flushLogs();return {ok:true,...logShippingState()};
}
export async function acceptDiagnosticEvent(record,base){
  const saved=normalize(await getApiBase({warm:false}));
  let sameScope=normalize(base)===saved;
  try{sameScope ||= normalize(base)===new URL(saved).origin && String(record?.path||'').startsWith(new URL(saved).pathname.replace(/\/$/, '')+'/');}catch{}
  if(!saved||(base&&!sameScope))return {ok:false,reason:'api_scope_mismatch'};
  await initializeLogJournal(saved);
  // Re-allowlist untrusted message fields. Never ingest arbitrary popup objects.
  const safe=diagnosticRecord(String(record?.event||'unknown'),record||{});
  if(Number.isFinite(record?.t))safe.t=record.t;
  if(/^[A-Za-z0-9_.:-]{1,80}$/.test(String(record?.client_run||'')))safe.client_run=record.client_run;
  if(Number.isSafeInteger(record?.client_n))safe.client_n=record.client_n;
  recordLogLine(safe);await persistLogJournal();void flushLogs();return {ok:true,...logShippingState()};
}
export async function startDiagnosticShipping(){
  if(probing)return;probing=true;
  let timer;
  try{
    const base=normalize(await getApiBase({warm:false}));if(!base)return;
    await initializeLogJournal(base);setDiagnosticSink(recordLogLine);
    recordLogLine(diagnosticRecord('worker.ready',{source:'service_worker',version:chrome.runtime.getManifest().version}));
    const controller=new AbortController();timer=setTimeout(()=>controller.abort(),5000);timer?.unref?.();
    const response=await fetch(base+'/meta',{signal:controller.signal,cache:'no-store',redirect:'error',credentials:'omit'});
    if(!response.ok)throw new Error('meta unavailable');
    const data=await response.json();
    // Without log_file the old API can still negotiate through /v1/capabilities.
    if(typeof data?.diagnostics?.log_file==='boolean')await configureDiagnosticShipping(base,data.diagnostics.log_file);
  }catch(error){
    recordLogLine(diagnosticRecord('logging.discovery_failed',{error_type:error?.name||'NetworkError',outcome:'error'}));
    await persistLogJournal();
    if(!retry){retry=setTimeout(()=>{retry=null;void startDiagnosticShipping();},15000);retry?.unref?.();}
  }finally{if(timer)clearTimeout(timer);probing=false;}
}
