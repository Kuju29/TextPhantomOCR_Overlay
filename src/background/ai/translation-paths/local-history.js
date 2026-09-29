// Private browser history. Separate from provider KV cache and Series memory.
const MAX_CHARS=1_000_000, MAX_SESSIONS=256;
const pending=new Map(), memory=new Map(), broken=new Map(), capacityBlocked=new Set();
let database;
function capacityError() {
  const failure=new Error('This Local Conversation could not retain its previous translation within history capacity. Start a new document Conversation before translating again.');
  failure.code='ai_conversation_history_capacity';
  failure.requestDispatched=false;
  failure.providerAttempts=0;
  failure.generationAttempts=0;
  return failure;
}
function sessionCapacityError() {
  const failure=new Error('Local Conversation history reached the 256-document limit. Remove an old stored history entry in browser IndexedDB before starting another; no AI request was sent.');
  failure.code='ai_conversation_capacity';
  failure.requestDispatched=false;
  failure.providerAttempts=0;
  failure.generationAttempts=0;
  return failure;
}
function pendingError() {
  const failure=new Error('A previous Local Conversation request was sent, but its result was not durably saved. Start a new document Conversation before translating again.');
  failure.code='ai_conversation_state_pending';
  failure.requestDispatched=false;
  failure.providerAttempts=0;
  failure.generationAttempts=0;
  return failure;
}
function stateConflictError() {
  const failure=new Error('Local Conversation changed while this request was prepared. Retry to read its latest history; no AI request was sent.');
  failure.code='ai_conversation_state_conflict';
  failure.requestDispatched=false;
  failure.providerAttempts=0;
  failure.generationAttempts=0;
  return failure;
}
function storageError(error) {
  const failure=new Error("Local Conversation history storage is unavailable; check IndexedDB before retrying.");
  failure.code="ai_conversation_storage_unavailable";
  failure.cause=error;
  failure.requestDispatched=false;
  failure.providerAttempts=0;
  failure.generationAttempts=0;
  return failure;
}
export async function digest(value) {
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function db() {
  if(!globalThis.indexedDB) {
    if(globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id)
      throw storageError(new Error("IndexedDB API is missing"));
    return null; // Non-browser fixtures retain their explicit ephemeral status.
  }
  if(!database) database=new Promise((resolve,reject)=>{
    const request=indexedDB.open("textphantom-conversations-v1",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("history",{keyPath:"scope"});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error("Conversation database blocked"));
  }).catch(error=>{database=null;throw error;});
  return database;
}
const cancellation=()=>new DOMException("Conversation cancelled","AbortError");
async function transact(mode,action,signal=null) {
  const database=await db(); if(!database) return null;
  if(signal?.aborted) throw cancellation();
  return new Promise((resolve,reject)=>{
    const tx=database.transaction("history",mode), store=tx.objectStore("history");
    let result,settled=false;
    const finish=(ok,value)=>{if(settled)return;settled=true;signal?.removeEventListener?.("abort",abort);
      (ok?resolve:reject)(value);};
    const abort=()=>{try{tx.abort();}catch{} /* oncomplete owns an already-committed transaction */};
    tx.oncomplete=()=>finish(true,result);
    tx.onerror=()=>finish(false,signal?.aborted?cancellation():tx.error);
    tx.onabort=()=>finish(false,signal?.aborted?cancellation():tx.error||new Error("History transaction aborted"));
    signal?.addEventListener?.("abort",abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{action(store,v=>{result=v;});}catch(error){abort();finish(false,error);}
  });
}
async function read(scope) {
  if(capacityBlocked.has(scope)) throw capacityError();
  if(broken.has(scope)) throw storageError(broken.get(scope));
  try {
    if(!globalThis.indexedDB) {
      if(globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id)
        throw storageError(new Error("IndexedDB API is missing"));
      const value=memory.get(scope);
      if(value?.blocked==='history_storage_limit') throw capacityError();
      if(value?.pending==='provider_result_uncommitted') throw pendingError();
      return {...(value||{scope,history:[],prefix:"",revision:0}),storage:"local_memory",rowPresent:!!value};
    }
    const value=await transact("readonly",(s,done)=>{const q=s.get(scope);q.onsuccess=()=>done(q.result);});
    if(value?.blocked==='history_storage_limit') {
      capacityBlocked.add(scope);
      throw capacityError();
    }
    if(value?.pending==='provider_result_uncommitted') throw pendingError();
    const cached=memory.get(scope);
    // The last accepted browser turn is cached only after its transaction
    // completed. A removed or rolled-back persisted row must not silently
    // continue from memory or silently restart a live conversation.
    if(cached && (!value || value.revision<cached.revision))
      throw storageError(new Error("Persisted conversation history changed during this worker"));
    if(value) {memory.set(scope,value);return {...value,storage:"local_indexeddb",rowPresent:true};}
    return {scope,history:[],prefix:"",revision:0,storage:"local_indexeddb",rowPresent:false};
  } catch(error) {
    if(['ai_conversation_history_capacity','ai_conversation_state_pending'].includes(error?.code)) throw error;
    throw storageError(error);
  }
}
async function write(value,signal=null,expected=null) {
  if(!globalThis.indexedDB && (globalThis.chrome?.runtime?.id || globalThis.browser?.runtime?.id)) {
    const error=new Error("IndexedDB API disappeared before history commit");
    broken.set(value.scope,error);
    throw storageError(error);
  }
  if(globalThis.indexedDB) {
    let full=false,conflict=false;
    try {
      await transact("readwrite",(s)=>{
        const q=s.get(value.scope);q.onsuccess=()=>{
          const current=q.result;
          if(expected){
            if(!!current!==expected.present||current?.pending||current?.blocked||
                (current&&current.revision!==expected.revision)){
              conflict=true;return;
            }
          }
          if(current){s.put(value);return;}
          const count=s.count();count.onsuccess=()=>{
            if(count.result>=MAX_SESSIONS){full=true;return;}
            s.put(value);
          }
        };
      },signal);
    } catch(error) {
      // Aborted transactions roll back the put. Do not fence a healthy scope;
      // the last accepted response ID remains the only committed cursor.
      if(error?.name==="AbortError"&&signal?.aborted) throw error;
      broken.set(value.scope,error);throw storageError(error);
    }
    if(conflict) throw stateConflictError();
    if(full) throw sessionCapacityError();
  }
  if(!globalThis.indexedDB&&signal?.aborted) throw cancellation();
  if(!globalThis.indexedDB&&expected){
    const current=memory.get(value.scope);
    if(!!current!==expected.present||current?.pending||current?.blocked||
        (current&&current.revision!==expected.revision)) throw stateConflictError();
  }
  if(!globalThis.indexedDB&&memory.size>=MAX_SESSIONS&&!memory.has(value.scope)) throw sessionCapacityError();
  memory.delete(value.scope);memory.set(value.scope,value);
  return globalThis.indexedDB ? "local_indexeddb" : "local_memory";
}
export async function localScope(ai,targetLang,sourceLang) {
  const c=ai?.conversation || {};
  if(!c.owner||!c.documentId) return "";
  return digest(JSON.stringify(["conversation-immutable-anchor-2026.9.27.8",c.owner,c.documentId,"automatic",ai.provider,ai.model,ai.base_url,
    ai.prompt,ai.style_examples === false ? "none" : false,ai.memory_mode,ai.thinking,!!ai.send_image,targetLang,sourceLang,
    ai.model_capabilities?.limits?.modelRevision||"",ai.output_contract||"",
    ...(ai.provider==="lmstudio" ? [String(ai.local_adapter?.baseUrl||"")] : [])]));
}
export async function withLocalHistory(ai,targetLang,sourceLang,signal,work) {
  const scope=await localScope(ai,targetLang,sourceLang);
  const before=scope?pending.get(scope):null;
  let done;const completed=new Promise(r=>{done=r;});
  if(scope) pending.set(scope,completed);
  const started=performance.now();
  try {
    if(signal?.aborted) throw new DOMException("Conversation cancelled","AbortError");
    if(before) await new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);reject(new DOMException("Conversation cancelled","AbortError"));};
      const timer=setTimeout(()=>{signal?.removeEventListener?.("abort",abort);reject(Object.assign(new Error("Conversation wait expired"),{code:"ai_conversation_wait_timeout",providerAttempts:0}));},600000);
      signal?.addEventListener?.("abort",abort,{once:true});
      before.then(()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",abort);resolve();});
    });
    if(signal?.aborted) throw new DOMException("Conversation cancelled","AbortError");
    const state=scope?await read(scope):{scope:"",history:[],prefix:"",revision:0,storage:"ephemeral"};
    state.queueWaitMs=performance.now()-started;
    let committed={history:state.history,prefix:state.prefix,revision:state.revision};
    let begun=false,hasCommittedRow=state.rowPresent===true;
    state.begin=async()=>{
      if(signal?.aborted) throw cancellation();
      if(!scope) return "ephemeral";
      if(begun) return state.storage;
      // This marker is durable before a provider request can begin. A failed
      // answer commit must remain visible after a service-worker restart.
      const storage=await write({scope,...committed,updated:Date.now(),pending:'provider_result_uncommitted'},
        signal,{present:hasCommittedRow,revision:committed.revision});
      begun=true;
      hasCommittedRow=true;
      return storage;
    };
    state.rollback=async()=>{
      if(!begun||!scope) return;
      // Failed, invalid, and cancelled generations have no accepted turn.
      // This may run after cancellation, so its transaction has no job signal.
      await write({scope,...committed,updated:Date.now()},null);
      begun=false;
      hasCommittedRow=true;
    };
    state.save=async value=>{
      if(signal?.aborted) throw cancellation();
      if(!scope) return "ephemeral";
      if(JSON.stringify(value).length>MAX_CHARS) {
        // The provider has already produced a valid answer. Retain the last
        // accepted history byte-for-byte and persist a small fence beside it;
        // silently starting a new anchor would discard this result as context.
        const marker={scope,...committed,updated:Date.now(),blocked:'history_storage_limit'};
        try {await write(marker,signal);}
        catch(error) {
          if(signal?.aborted) throw error;
          capacityBlocked.add(scope);
          throw error;
        }
        capacityBlocked.add(scope);
        begun=false;
        hasCommittedRow=true;
        return "history_storage_limit";
      }
      const storage=await write({...value,scope,updated:Date.now()},signal);
      committed={history:value.history,prefix:value.prefix,revision:value.revision};
      begun=false;
      hasCommittedRow=true;
      return storage;
    };
    return await work(state);
  } finally {
    // A cancelled queued request cannot open the lane before its predecessor.
    if(before) before.finally(done); else done();
    if(scope&&pending.get(scope)===completed) completed.then(()=>{if(pending.get(scope)===completed)pending.delete(scope);});
  }
}
