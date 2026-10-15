/** .10485 AI result cache for every site: same image + same effective settings -> reused result, no AI/Lens request,
 * no usage; any settings/model/language change misses; count/byte LRU + TTL; MangaDex md cache unchanged and bounded. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;

const {createResultCache,resultCacheKey,imageIdentity,RESULT_CACHE_TTL_MS}=await import('../src/background/result-cache.js');

// ---- Key: identity + settings ---------------------------------------------------------------
const base={src:'https://site.test/ch1/p1.jpg#frag',lang:'th',mode:'lens_text',source:'ai',engine:'extension',
  ai:{provider:'gemini',model:'m1',prompt:'P',api_key:'secret-1',conversation:{owner:'o',documentId:'d1'}},
  render:{relayout:true},metadata:{image_id:'a'},context:{page_url:'https://site.test/ch1'}};
const key=async(p,apiBase='http://api.test')=>resultCacheKey(p,{apiBase,normalizeUrl:s=>s.replace(/#.*$/,'')});
const k0=await key(base);
// 10493: the key holds the generation settings themselves (no settings epoch).
assert.match(k0,/^url:https:\/\/site\.test\/ch1\/p1\.jpg::th::lens_text::ai::g[0-9a-f]{64}::v[0-9a-f]{64}$/);
assert.equal(await key({...base,ai:{...base.ai,api_key:'other',conversation:{owner:'x',documentId:'d9'}},
  metadata:{image_id:'b'},context:{page_url:'https://site.test/other'}}),k0,'credentials and page/run identity do not split the key');
for(const [label,variant] of [['language',{...base,lang:'en'}],['mode',{...base,mode:'lens_images'}],['text source',{...base,source:'translated'}],
  ['model',{...base,ai:{...base.ai,model:'m2'}}],['provider',{...base,ai:{...base.ai,provider:'openai'}}],['prompt',{...base,ai:{...base.ai,prompt:'Q'}}],
  ['render',{...base,render:{relayout:false}}],['engine',{...base,engine:'api'}]])
  assert.notEqual(await key(variant),k0,`${label} change must miss`);
assert.notEqual(await key(base,'http://other-api.test'),k0,'API server change must miss');
assert.ok(!k0.includes('secret-1')&&!k0.includes('P::'),'no credential or prompt text in the key');
assert.equal(await imageIdentity({src:'blob:https://site.test/x'}),'','blob without bytes is not cached');
const dataId=await imageIdentity({src:'blob:https://site.test/x',imageDataUri:'data:image/png;base64,AAAA'});
assert.match(dataId,/^sha256:[0-9a-f]{64}$/,'blob with bytes uses a content hash');
assert.equal(await imageIdentity({src:'data:image/png;base64,AAAA'}),dataId,'same bytes = same identity');
assert.notEqual(await imageIdentity({src:'data:image/png;base64,AAAB'}),dataId);

// ---- Store: LRU count/byte caps, TTL since last use, image cap ------------------------------------
let clock=0;
const c=createResultCache({now:()=>clock,maxEntries:3,maxBytes:10_000,maxImageBytes:4_000});
const res=(n,img='')=>({lensDocument:{paragraphs:[{aiText:`t${n}`}]},...(img?{imageDataUri:img}:{}),perf:{total_ms:5}});
for(const n of [1,2,3]) assert.equal(c.store(`k${n}`,res(n),{mode:'lens_text',hasHtml:true}).stored,true);
clock+=10;c.get('k1'); // k1 recently used
c.store('k4',res(4),{mode:'lens_text',hasHtml:true});
assert.equal(c.get('k2'),null,'least recently used entry evicted at the count cap');
assert.ok(c.get('k1')&&c.get('k3')&&c.get('k4'));
const hit=c.get('k4');
assert.equal(hit.result.perf.cache,'hit');assert.equal(hit.result.lensDocument.paragraphs[0].aiText,'t4');
assert.equal(c.store('big',res(9,'data:image/png;base64,'+'x'.repeat(3_000)),{mode:'lens_text',hasHtml:true}).stored,true);
assert.ok(c.stats().bytes<=10_000);
c.store('big2',res(10,'data:image/png;base64,'+'y'.repeat(3_500)),{mode:'lens_text',hasHtml:true});
c.store('big3',res(11,'data:image/png;base64,'+'z'.repeat(3_500)),{mode:'lens_text',hasHtml:true});
assert.ok(c.stats().bytes<=10_000,'byte cap holds');assert.equal(c.get('big'),null,'oldest entry evicted by the byte cap');
const over=c.store('huge',res(12,'data:image/png;base64,'+'h'.repeat(5_000)),{mode:'lens_text',hasHtml:true});
assert.deepEqual([over.stored,over.imageOmitted],[true,true],'text kept, oversized image skipped');
assert.equal(c.get('huge').result.imageDataUri,undefined);assert.equal(c.get('huge').result.perf.cacheImageOmitted,true);
assert.equal(c.store('img-only',res(13,'data:image/png;base64,'+'h'.repeat(5_000)),{mode:'lens_images',hasHtml:false}).stored,false,
  'image-mode result whose image is over the cap is not cached');
clock+=RESULT_CACHE_TTL_MS-1;assert.ok(c.get('huge'),'TTL counts from last use');
clock+=RESULT_CACHE_TTL_MS;assert.equal(c.get('huge'),null,'expired after 30 min unused');

// ---- MangaDex md cache: behaviour unchanged, now bounded --------------------------------------------
const md=await import('../src/background/mangadex.js');
const mdKey=md.mdCacheKey('md:data/h/p.png','th','lens_text','ai',3);
assert.equal(mdKey,'md:data/h/p.png::th::text::ai::r3','md key format unchanged');
md.setCachedResult(mdKey,{newImg:'data:image/png;base64,QQ',result:{html:'x'}});
assert.deepEqual(md.getCachedResult(mdKey).result,{html:'x'});assert.equal(md.getCachedResult(mdKey).newImg,'data:image/png;base64,QQ');
for(let i=0;i<md.MD_RESULT_MAX+5;i++) md.setCachedResult(md.mdCacheKey(`md:data/h/${i}.png`,'th','lens_text','ai',3),{newImg:null,result:{html:String(i)}});
assert.equal(md.getCachedResult(mdKey),null,'oldest md entry evicted at the count cap');
assert.ok(md.getCachedResult(md.mdCacheKey(`md:data/h/${md.MD_RESULT_MAX+4}.png`,'th','lens_text','ai',3)));

// ---- Integration: real jobs.js processJob + result delivery -----------------------------------------
const fetches=[],sent=[],session={},local={};
const ev=()=>({addListener(){},removeListener(){}});
const area=store=>({get(keys,cb){const out=keys==null?{...store}:typeof keys==='string'?{[keys]:store[keys]}:Array.isArray(keys)
    ?Object.fromEntries(keys.map(k=>[k,store[k]])):{...keys,...Object.fromEntries(Object.keys(keys).filter(k=>k in store).map(k=>[k,store[k]]))};
    cb?.(out);return Promise.resolve(out);},
  set(v,cb){Object.assign(store,v);cb?.();return Promise.resolve();},remove(k,cb){for(const x of [].concat(k))delete store[x];cb?.();return Promise.resolve();},
  setAccessLevel:async()=>{}});
globalThis.chrome={runtime:{lastError:null,id:'fixture',getManifest:()=>({version:'10485'}),sendMessage:async()=>({}),getURL:x=>x,onMessage:ev()},
  storage:{local:area(local),session:area(session),onChanged:ev()},alarms:{create(){},clear:async()=>true,onAlarm:ev()},
  tabs:{sendMessage(tabId,message,_o,cb){sent.push({tabId,message});const ack={ok:true,applied:true};cb?.(ack);return Promise.resolve(ack);},
    get:async()=>({id:7,url:'https://site.test/ch1'}),query:async()=>[]}};
globalThis.fetch=async(url)=>{fetches.push(String(url));return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
const jobs=await import('../src/background/jobs.js');
const {rememberJob,pendingByJob}=await import('../src/background/job-registry.js');
const {resultCache}=await import('../src/background/result-cache.js');
const life=await import('../src/background/jobs/lifecycle.js');
const usage=await import('../src/shared/ai-usage.js');
const payload=()=>({src:'https://site.test/ch1/p1.jpg',lang:'th',mode:'lens_text',source:'ai',engine:'extension',
  ai:{provider:'gemini',model:'m1',prompt:'P',api_key:'k'},metadata:{image_id:`img-${Math.random()}`},
  context:{page_url:'https://site.test/ch1',tp_tab_session:''},generation:{pageInstanceId:'pi',targetInstanceId:'ti'}});
const finished={lensDocument:{schema:'tp.lens-document/1',image:{width:10,height:10},languages:{source:'en',target:'th'},
  paragraphs:[{id:'p0',sourceText:'Hello',aiText:'สวัสดี',items:[]}]},imageDataUri:'data:image/png;base64,RkFLRQ==',
  Ai:{meta:{provider:'gemini',model:'m1',usage:{inputTokens:10,outputTokens:3}}}};
// First press: a translation finished and was delivered through the real result delivery.
const first=payload();
const apiBase=await (await import('../src/background/api.js')).getApiBase();
const cacheKey=await resultCacheKey(first,{apiBase,normalizeUrl:(await import('../src/background/job-keys.js')).normImgSrc});
rememberJob('first-job',{imgUrl:first.src,tabId:7,frameId:0,mode:'lens_text',lang:'th',source:'ai',metadata:first.metadata,
  generation:first.generation,sessionId:'',settingsEpoch:life.getSettingsEpoch(),resultCacheKey:cacheKey,startedAt:Date.now(),transport:'sync'});
await jobs.handleResult('first-job',structuredClone(finished));
assert.equal(resultCache.stats().entries,1,'finished result stored in the memory cache');
assert.equal(Object.keys(local).filter(k=>/cache/i.test(k)).length+Object.keys(session).filter(k=>/resultCache/i.test(k)).length,0,
  'cache never written to chrome.storage');
// Second press: same image + settings.
fetches.length=0;sent.length=0;
const receiptsBefore=Object.keys(local).filter(k=>k.startsWith(usage.AI_USAGE_RECEIPT_PREFIX)).length;
await jobs.processJob(payload(),7,0);
// API-base discovery (defaults_api.json) and warm-up pings are not Lens/AI work.
const aiOrLens=fetches.filter(u=>!/defaults_api\.json|\/(health|healthz|warmup|ping)\b/.test(u));
assert.deepEqual(aiOrLens,[],`no Lens/AI/API request on a cache hit (saw ${aiOrLens.join(', ')})`);
const delivered=sent.map(s=>s.message).filter(m=>m?.result||m?.lensDocument||m?.type==='INSERT_RESULT'||m?.type==='TP_INSERT');
assert.ok(sent.some(s=>JSON.stringify(s.message).includes('สวัสดี')),'cached translation delivered to the page');
assert.ok(sent.some(s=>JSON.stringify(s.message).includes('"cache":"hit"')),'delivery is marked perf.cache = hit');
assert.equal(Object.keys(local).filter(k=>k.startsWith(usage.AI_USAGE_RECEIPT_PREFIX)).length,receiptsBefore,'no usage receipt on a hit');
assert.equal([...pendingByJob.values()].filter(c=>c.resultCacheHit).length,0,'hit job released');
// Settings change: miss (the job proceeds past the cache into normal dispatch).
const missKey=await resultCacheKey({...payload(),ai:{...payload().ai,prompt:'P2'}},{apiBase,normalizeUrl:s=>s});
assert.equal(resultCache.get(missKey),null,'prompt change misses');
const otherModel=await resultCacheKey({...payload(),ai:{...payload().ai,model:'m2'}},{apiBase,normalizeUrl:s=>s});
assert.equal(resultCache.get(otherModel),null,'model change misses');
// 10493: a settings epoch bump alone (e.g. a credential/account change) keeps the entry.
life.bumpSettingsEpoch();
assert.ok(resultCache.get(cacheKey),'entries stay reusable for their own settings');
void delivered;
console.log('PASS .10485 result cache: per-site key (URL / content hash + lang/mode/source/generation + presentation settings), 2nd press reuses without AI/usage, misses on changes, LRU/bytes/TTL bounded, MangaDex unchanged');
process.exit(0);
