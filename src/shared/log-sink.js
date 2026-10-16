/** Bounded, API-scoped, durable diagnostic journal. Shipping needs BOTH the
 * user's "Send diagnostic logs" switch (default off, 10494) and TP_LOG_FILE.
 * With the switch off nothing is recorded or kept. Unknown metadata keeps only
 * explicit diagnostic records locally. Authoritative disabled clears them.
 * Transient failures retain/retry, never replay business calls.
 */
import './log-serialization.js';
const MAX_BUFFER=400,MAX_BYTES=512*1024,MAX_BATCH=100,MAX_REQUEST_BYTES=48*1024,TTL=7*86400000;
const KEY='tpDiagnosticJournalV1';
const RUN_ID=globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
let lineNo=0,buffer=[],dropped=0,timer=null,shipping=false,enabled=false,known=false,baseUrlProvider=null,activeBaseKey='';
let revision=0,failures=0,restored=false,restoreTask=null,saveTask=null,saveDirty=false,storageFailures=0;
// The user's switch. Fail closed until the worker has read it.
let userAllowed=false;
const unsupportedBases=new Set();
const normalize=base=>String(base||'').replace(/\/+$/,'');
const cloneSafe=value=>globalThis.__TPLogSerialization?.normalize(value)??value;
function persist(){
  if(!activeBaseKey)return Promise.resolve();
  saveDirty=true;
  if(saveTask)return saveTask;
  saveTask=Promise.resolve().then(async()=>{
    while(saveDirty){
      saveDirty=false;
      try{
        const store=globalThis.chrome?.storage?.local;
        if(!store?.set){storageFailures++;break;}
        const value=JSON.parse(JSON.stringify({base:activeBaseKey,records:buffer,dropped,enabled:known?enabled:null,updatedAt:Date.now()}));
        await store.set({[KEY]:value});
      }catch{storageFailures++;}
    }
  }).finally(()=>{saveTask=null;});
  return saveTask;
}
function cap(){
  if(buffer.length>MAX_BUFFER){dropped+=buffer.length-MAX_BUFFER;buffer.splice(0,buffer.length-MAX_BUFFER);}
  let bytes=new TextEncoder().encode(JSON.stringify(buffer)).length;
  while(bytes>MAX_BYTES&&buffer.length){const row=buffer.shift();bytes-=new TextEncoder().encode(JSON.stringify(row)).length;dropped++;}
}
function schedule(delay=1500){
  if(!enabled||!userAllowed||shipping||timer||!buffer.length)return;
  timer=setTimeout(()=>{timer=null;void flushLogs();},delay);timer?.unref?.();
}
export async function initializeLogJournal(base){
  const target=normalize(base);
  if(!target)return;
  if(restored&&target===activeBaseKey)return;
  if(restoreTask&&target===activeBaseKey)return restoreTask;
  if(activeBaseKey&&activeBaseKey!==target){revision++;buffer=[];dropped=0;failures=0;enabled=false;known=false;restored=false;}
  activeBaseKey=target;baseUrlProvider=()=>target;
  const epoch=revision;
  restoreTask=(async()=>{
    try{
      const stored=await globalThis.chrome?.storage?.local?.get?.(KEY),saved=stored?.[KEY];
      if(epoch!==revision||target!==activeBaseKey)return;
      if(userAllowed&&saved?.base===target&&Array.isArray(saved.records)&&saved.updatedAt>Date.now()-TTL){
        const existing=new Set(buffer.map(x=>`${x.run}:${x.n}`));
        buffer=[...saved.records.filter(x=>x?.t>Date.now()-TTL&&!existing.has(`${x.run}:${x.n}`)).map(cloneSafe),...buffer];
        dropped+=Math.max(0,Number(saved.dropped)||0);cap();
        // Remember a prior enabled sink, but re-negotiate on every API startup.
        if(!known&&saved.enabled===true)enabled=true;
      }
    }catch{}
    finally{if(epoch===revision){restored=true;restoreTask=null;await persist();schedule();}}
  })();
  return restoreTask;
}
export function setLogShippingEnabled(on,getBaseUrl,baseKey='',{authoritative=false}={}){
  const key=normalize(baseKey);
  if(getBaseUrl)baseUrlProvider=getBaseUrl;
  if(key&&activeBaseKey&&key!==activeBaseKey){revision++;buffer=[];dropped=0;restored=false;}
  if(key)activeBaseKey=key;
  known=true;
  if(authoritative&&on&&key)unsupportedBases.delete(key);
  enabled=Boolean(on)&&!unsupportedBases.has(activeBaseKey);
  if(!enabled){revision++;buffer=[];dropped=0;if(timer)clearTimeout(timer);timer=null;}
  failures=0;void persist();schedule(0);
}
/** The user's "Send diagnostic logs to the API server" switch. Off drops the journal. */
export function setDiagnosticsUploadAllowed(on){
  const next=on===true;
  if(next===userAllowed)return;
  userAllowed=next;
  if(!userAllowed){revision++;buffer=[];dropped=0;if(timer)clearTimeout(timer);timer=null;void persist();return;}
  schedule(0);
}
export const diagnosticsUploadAllowed=()=>userAllowed;
export function resetLogShippingSupport(baseKey=''){
  const key=normalize(baseKey);if(key)unsupportedBases.delete(key);else unsupportedBases.clear();
  failures=0;
}
export function recordLogLine(record){
  if(!userAllowed)return;
  if(!enabled&&(!record?.diagnostic||known))return;
  try{
    const clean=cloneSafe(record);
    const line={...clean,t:Number(clean.t)||Date.now(),run:RUN_ID,n:++lineNo};
    const serialized=JSON.stringify(line);
    if(new TextEncoder().encode(serialized).length>16000){dropped++;return;}
    buffer.push(line);cap();void persist();
    if(buffer.length>=40)void flushLogs();else schedule();
  }catch{}
}
export function logShippingState(){return {enabled,userAllowed,known,pending:buffer.length,dropped,consecutiveFailures:failures,persistent:restored&&storageFailures===0,storageFailures};}
export function persistLogJournal(){return persist();}
export async function flushLogs(){
  if(timer){clearTimeout(timer);timer=null;}
  if(!enabled||!userAllowed||shipping||!buffer.length)return;
  shipping=true;const epoch=revision;let deadline;
  try{
    const base=normalize(await baseUrlProvider?.());
    if(!base||!enabled||!userAllowed||epoch!==revision||activeBaseKey&&base!==activeBaseKey)return;
    const batch=[];let bytes=256;
    for(const item of buffer.slice(0,MAX_BATCH)){
      const n=new TextEncoder().encode(JSON.stringify(item)).length+1;
      if(bytes+n>MAX_REQUEST_BYTES&&batch.length)break;
      if(n+256>MAX_REQUEST_BYTES){dropped++;buffer=buffer.filter(x=>x!==item);continue;}
      batch.push(item);bytes+=n;
    }
    if(!batch.length)return;
    const gap=dropped,controller=new AbortController();deadline=setTimeout(()=>controller.abort(),10000);deadline?.unref?.();
    const response=await fetch(`${base}/v1/logs`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},cache:'no-store',redirect:'error',credentials:'omit',keepalive:false,
      body:JSON.stringify({records:batch,droppedSinceLastBatch:gap,shipping:{pending:buffer.length,failures,storageFailures}})});
    if(epoch!==revision)return;
    if(!response.ok){
      let data;try{data=await response.json();}catch{}
      const code=data?.detail?.code||data?.detail?.error?.code||data?.error?.code;
      // A generic 503 may be a proxy outage or disk-full, not "logging disabled".
      if(response.status===503&&code==='diagnostic_logging_disabled'){
        known=true;enabled=false;unsupportedBases.add(base);buffer=[];dropped=0;await persist();return;
      }
      throw new Error('Diagnostic transport failure');
    }
    const ack=await response.json();if(ack?.ok!==true)throw new Error('Missing diagnostic ACK');
    const sent=new Set(batch);buffer=buffer.filter(r=>!sent.has(r));dropped=Math.max(0,dropped-gap);failures=0;await persist();
  }catch{
    if(epoch===revision){failures++;await persist();}
  }finally{
    if(deadline)clearTimeout(deadline);shipping=false;
    schedule(failures?Math.min(60000,1500*2**Math.min(failures,6)):1500);
  }
}
