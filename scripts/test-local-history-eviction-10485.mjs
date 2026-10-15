/** .10485 Local Conversation history: LRU eviction of idle rows at 256, tombstones, in-use protection. */
import assert from 'node:assert/strict';

// Small multi-store IndexedDB fixture: per-store maps, an "updated"/"at" index
// with key-only cursors, and transactions that roll back on abort.
const stores={history:new Map(),evicted:new Map()};
const indexKey={history:'updated',evicted:'at'};
let opened=0;
function transaction(names,mode){
  const tx={};let waiting=0,scheduled=false,done=false;
  const backup=mode==='readwrite'?Object.fromEntries(Object.entries(stores).map(([k,v])=>[k,new Map(v)])):null;
  const complete=()=>{
    if(scheduled||done)return;scheduled=true;
    setTimeout(()=>{scheduled=false;if(done)return;if(!waiting){done=true;tx.oncomplete?.();}else complete();},0);
  };
  tx.abort=()=>{if(done)return;done=true;
    if(backup)for(const [k,v] of Object.entries(backup))stores[k]=v;
    setTimeout(()=>tx.onabort?.(),0);};
  const request=work=>{const q={};waiting++;setTimeout(()=>{
    if(done)return;
    try{q.result=work();}catch(error){waiting--;tx.error=error;tx.abort();return;}
    try{q.onsuccess?.();}catch(error){waiting--;tx.error=error;tx.abort();return;}
    waiting--;complete();},0);return q;};
  tx.objectStore=name=>{
    assert.ok([].concat(names).includes(name),`store ${name} is outside the transaction scope`);
    const map=()=>stores[name];
    return {
      get:key=>request(()=>structuredClone(map().get(key))),
      count:()=>request(()=>map().size),
      put:value=>{assert.equal(mode,'readwrite');return request(()=>{map().set(value.scope,structuredClone(value));});},
      delete:key=>{assert.equal(mode,'readwrite');return request(()=>{map().delete(key);});},
      getAll:()=>{throw new Error('bulk history scan is forbidden');},
      openCursor:()=>{throw new Error('value cursors would load ~1 MB rows; use a key cursor');},
      index:indexName=>{
        assert.equal(indexName,indexKey[name]);
        return {openKeyCursor:(range)=>{
          const keys=[...map().values()].filter(v=>v[indexName]!==undefined&&(!range||v[indexName]<=range.upper))
            .sort((a,b)=>a[indexName]-b[indexName]).map(v=>v.scope);
          let i=0;const q={};
          const step=()=>request(()=>{const key=keys[i++];
            q.result=key===undefined?null:{primaryKey:key,continue:()=>{const next=step();next.onsuccess=()=>q.onsuccess?.();}};
          });
          const first=step();first.onsuccess=()=>q.onsuccess?.();
          return q;
        }};
      },
    };
  };
  return tx;
}
const database={transaction,objectStoreNames:{contains:()=>false},
  createObjectStore:()=>({indexNames:{contains:()=>false},createIndex(){}})};
globalThis.IDBKeyRange??={upperBound:upper=>({upper})};
globalThis.indexedDB={open(name,version){opened=version;const q={};
  setTimeout(()=>{q.result=database;q.onupgradeneeded?.();q.onsuccess?.();},0);return q;}};

const lh=await import('../src/background/ai/translation-paths/local-history.js?eviction-10485');
const {conversationTranslation}=await import('../src/background/ai/translation-paths/conversation.js');
const HOUR=lh.IDLE_EVICT_MS;
assert.equal(HOUR,3600000,'idle threshold mirrors the API (1 h)');
const ai=doc=>({provider:'ollama',model:'fixture',base_url:'http://127.0.0.1:11434',thinking:'off',
  style_examples:false,model_capabilities:{limits:{contextTokens:65536}},conversation:{owner:'owner',documentId:doc}});
async function commit(doc,turn='hello'){
  return lh.withLocalHistory(ai(doc),'th','en',null,async s=>{
    await s.begin();
    await s.save({history:[...s.history,{user:turn,assistant:'สวัสดี'}],prefix:'',revision:s.revision+1});
    return s;
  });
}
const scopeOf=doc=>lh.localScope(ai(doc),'th','en');
const age=async(doc,ms)=>{stores.history.get(await scopeOf(doc)).updated=Date.now()-ms;};

for(let i=0;i<256;i++) await commit(`doc-${i}`);
assert.equal(opened,2,'database opens the v2 schema');
assert.equal(stores.history.size,256);

// 1. All rows recently used: capacity error before any provider request.
await assert.rejects(commit('fresh-overflow'),e=>e.code==='ai_conversation_capacity'&&e.requestDispatched===false);
assert.equal(stores.history.size,256);

// 2. Oldest idle row is evicted; a less-idle row survives; tombstone recorded.
await age('doc-10',3*HOUR);await age('doc-20',2*HOUR);await age('doc-30',30*60*1000);
await commit('new-1');
assert.equal(stores.history.size,256);
assert.ok(!stores.history.has(await scopeOf('doc-10')),'least-recently-used idle scope is the victim');
assert.ok(stores.history.has(await scopeOf('doc-20')));
assert.ok(stores.evicted.has(await scopeOf('doc-10')),'evicted scope is tombstoned');

// 3. A row in use (request in flight in this worker) is never a victim even if it is the oldest idle row.
await age('doc-40',5*HOUR);
let release;const held=new Promise(r=>{release=r;});
let entered;const inUse=new Promise(r=>{entered=r;});
const lane=lh.withLocalHistory(ai('doc-40'),'th','en',null,async()=>{entered();await held;});
await inUse;
await commit('new-2');
assert.ok(stores.history.has(await scopeOf('doc-40')),'scope with an active lane survives');
assert.ok(!stores.history.has(await scopeOf('doc-20')),'next idle scope was taken instead');
release();await lane;

// 4. The evicted scope's next use starts over and reports history_evicted, also after a worker restart.
const restarted=await import('../src/background/ai/translation-paths/local-history.js?eviction-10485-restart');
await age('doc-50',2*HOUR); // free a slot for the evicted scope to come back
let evidence=null;
const result=await conversationTranslation(async(_units,{conversationContext})=>{
  await conversationContext.prepare({layout:{userStaticChars:6,userPersistentStaticChars:6,instructionLocale:'th',
    bootstrapExamplesChars:0},system:'S',user:'STATIC\n\n<<I1_P0:hi>>',schema:null,imageDataUri:'',
    outputReserve:128,executedModel:'fixture',protocol:'ollama',selectedContract:'marker'});
  conversationContext.capture('<<I1_P0:สวัสดี>>');
  return {translations:[{id:'I1_P0',text:'สวัสดี'}],meta:{terminalCompleted:true,usage:{inputTokens:1,outputTokens:1},
    generationAttempts:1,providerAttempts:1}};
},[{id:'I1_P0',text:'hi'}],{route:'direct-local',ai:{...ai('doc-10'),conversation:{owner:'owner',documentId:'doc-10',
  origins:[{pageId:'p1',pageIndex:0,pageOrder:1,unitIds:['I1_P0'],originalIds:['g1']}]}},targetLang:'th',sourceLang:'en',
  trace:(_n,e)=>{evidence=e;}});
assert.equal(result.meta.conversation.scopeStatus,'history_evicted');
assert.equal(evidence.scopeStatus,'history_evicted');
assert.equal(result.meta.conversation.historyTurns,0,'evicted scope starts over');
assert.equal(result.meta.conversation.commitStatus,'committed');
assert.ok(!stores.evicted.has(await scopeOf('doc-10')),'tombstone is consumed by the first durable write');
await restarted.withLocalHistory(ai('doc-10'),'th','en',null,s=>{assert.equal(s.scopeStatus,undefined);assert.equal(s.history.length,1);});

// 5. Fixture memory store (no IndexedDB) follows the same rule.
globalThis.indexedDB=undefined;
const mem=await import('../src/background/ai/translation-paths/local-history.js?eviction-10485-memory');
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
try{
  for(let i=0;i<256;i++) await mem.withLocalHistory(ai(`m-${i}`),'th','en',null,s=>s.save({history:[],prefix:'',revision:1}));
  await assert.rejects(mem.withLocalHistory(ai('m-new'),'th','en',null,s=>s.begin()),e=>e.code==='ai_conversation_capacity');
  clock+=2*HOUR;
  await mem.withLocalHistory(ai('m-0'),'th','en',null,s=>s.save({history:[],prefix:'',revision:2})); // m-0 recently used
  await mem.withLocalHistory(ai('m-new'),'th','en',null,s=>s.save({history:[],prefix:'',revision:1}));
  await mem.withLocalHistory(ai('m-0'),'th','en',null,s=>assert.equal(s.revision,2,'recently used scope kept'));
  await mem.withLocalHistory(ai('m-1'),'th','en',null,s=>{assert.equal(s.scopeStatus,'history_evicted');assert.equal(s.revision,0);});
}finally{Date.now=realNow;}
console.log('PASS .10485 Local Conversation history evicts the LRU idle (>=1 h) row not in use at 256 scopes, tombstones survive restart and report history_evicted, fresh rows still fail closed');
