// Private browser history. Separate from provider KV cache and Series memory.
const MAX_CHARS=1_000_000, MAX_SESSIONS=256;
const pending=new Map(), memory=new Map();
let database;
export async function digest(value) {
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(value)));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function db() {
  if(!globalThis.indexedDB) return null;
  if(!database) database=new Promise((resolve,reject)=>{
    const request=indexedDB.open("textphantom-conversations-v1",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("history",{keyPath:"scope"});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error("Conversation database blocked"));
  }).catch(error=>{database=null;throw error;});
  return database;
}
async function transact(mode,action) {
  const database=await db(); if(!database) return null;
  return new Promise((resolve,reject)=>{
    const tx=database.transaction("history",mode), store=tx.objectStore("history");
    let result;
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("History transaction aborted"));
    action(store,v=>{result=v;});
  });
}
async function read(scope) {
  let storage="local_indexeddb";
  try {
    const value=await transact("readonly",(s,done)=>{const q=s.get(scope);q.onsuccess=()=>done(q.result);});
    if(value) {
      const newer=memory.get(scope);
      if(newer && newer.revision>value.revision) return {...newer,storage:"local_memory"};
      memory.set(scope,value);return {...value,storage};
    }
    if(!globalThis.indexedDB) storage="local_memory";
  } catch {storage="local_memory";}
  return {...(memory.get(scope)||{scope,history:[],prefix:"",revision:0}),storage};
}
async function write(value) {
  memory.delete(value.scope);memory.set(value.scope,value);
  while(memory.size>MAX_SESSIONS) {
    const victim=[...memory.keys()].find(k=>!pending.has(k));
    if(!victim) break; memory.delete(victim);
  }
  if(!globalThis.indexedDB) return "local_memory";
  try {
    await transact("readwrite",(s)=>{
      s.put(value);
      const q=s.getAll();q.onsuccess=()=>{
        const rows=q.result.sort((a,b)=>a.updated-b.updated);
        let excess=rows.length-MAX_SESSIONS;
        for(const row of rows) if(excess>0&&!pending.has(row.scope)&&row.scope!==value.scope){s.delete(row.scope);excess--;}
      };
    }); return "local_indexeddb";
  } catch {return "local_memory";}
}
export async function localScope(ai,targetLang,sourceLang) {
  const c=ai?.conversation || {};
  if(!c.owner||!c.documentId) return "";
  return digest(JSON.stringify(["conversation-immutable-anchor-2026.9.15.2",c.owner,c.documentId,"automatic",ai.provider,ai.model,ai.base_url,
    ai.prompt,false,ai.memory_mode,ai.thinking,!!ai.send_image,targetLang,sourceLang,
    ai.model_capabilities?.limits?.modelRevision||"",ai.output_contract||""]));
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
    state.save=async value=>{
      if(!scope) return "ephemeral";
      if(JSON.stringify(value).length>MAX_CHARS) return "history_storage_limit";
      return write({...value,scope,updated:Date.now()});
    };
    return await work(state);
  } finally {
    // A cancelled queued request cannot open the lane before its predecessor.
    if(before) before.finally(done); else done();
    if(scope&&pending.get(scope)===completed) completed.then(()=>{if(pending.get(scope)===completed)pending.delete(scope);});
  }
}
