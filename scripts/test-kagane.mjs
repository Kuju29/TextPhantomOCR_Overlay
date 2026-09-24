// Offline integration with a synthetic DOM/network shaped like the supplied HAR.
// This does not contact Kagane, Lens, or AI; no user credentials or book bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const script=p=>readFileSync(new URL('../src/'+p,import.meta.url),'utf8');
class CustomEvent extends Event{constructor(type,options){super(type);this.detail=options.detail}}
const observers=new Set();
class MutationObserver{
 constructor(callback){this.callback=callback;this.targets=[];this.records=[];observers.add(this)}
 observe(target,options){this.targets.push({target,options})}
 disconnect(){this.targets=[];this.records=[]}
}
function mutation(target,addedNodes=[],removedNodes=[]){
 for(const observer of observers){
  if(!observer.targets.some(w=>w.options.childList && (w.target===target || (w.options.subtree && w.target.contains(target)))))continue;
  observer.records.push({type:'childList',target,addedNodes,removedNodes});
  if(observer.records.length===1)queueMicrotask(()=>{const records=observer.records.splice(0);if(records.length)observer.callback(records)});
 }
}
class El extends EventTarget{
 constructor(tag='div',attrs={}){super();this.tagName=tag.toUpperCase();this.attrs=attrs;this.children=[];this.nodeType=1;this.dataset={};this.isConnected=true;}
 connected(value){this.isConnected=value;for(const child of this.children)child.connected(value)}
 append(el){el.parentElement=this;el.connected(this.isConnected);this.children.push(el);mutation(this,[el])}
 remove(){const parent=this.parentElement;parent.children=parent.children.filter(el=>el!==this);this.connected(false);mutation(parent,[],[this])}
 contains(el){return el===this || this.children.some(child=>child.contains(el))}
 getAttribute(key){return this.attrs[key]??null} hasAttribute(key){return key in this.attrs}
 matches(selector){return selector.split(',').some(s=>{s=s.trim();const m=s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);return m ? this.hasAttribute(m[1]) && (m[2]===undefined || this.attrs[m[1]]===m[2]) : s.toUpperCase()===this.tagName;})}
 closest(s){return this.matches(s)?this:this.parentElement?.closest(s)||null}
 querySelectorAll(s){return this.children.flatMap(el=>[...(el.matches(s)?[el]:[]),...el.querySelectorAll(s)])}
 getBoundingClientRect(){return {width:600,height:900,top:0,left:0,right:600,bottom:900}}
}
const chapter='019c3ce9-99b1-7132-beda-0d00e6d9d0b7';
const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const location=new URL(`https://kagane.to/series/019c3cc0-468d-72d3-a7de-fda30338e242/reader/${chapter}?p=2`);
const document=new El('document');document.documentElement=document;let root=new El('main');document.append(root);
const mount=id=>{const img=new El('img');img.src=`blob:https://kagane.to/${webcrypto.randomUUID()}`;img.complete=true;img.naturalWidth=1939;img.naturalHeight=2723;slots[id-1].append(img);return img};
let slots=Array.from({length:51},(_,i)=>{const el=new El('div',{'data-page':String(i+1)});root.append(el);return el});
for(let i=1;i<=6;i++)mount(i);
let token='synthetic-token-a',imageStatus=200,stall=false;
const pages=slots.map((_,i)=>({page_no:i+1,page_id:webcrypto.randomUUID(),ext:'jxl',width:i===45?3878:1939,height:2723}));
const calls=[],events=[],placed=[],dropped=[];
const bytes=new Uint8Array(100);bytes.set([255,216,255]);
const nativeFetch=async(input,init={})=>{
 const url=new URL(String(input),location.href);calls.push({url:url.href,init});
 if(init.method==='POST')return Response.json({access_token:token,cache_url:'https://kstatic.to',manifest:{pages,version:1}});
 if(stall)await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
 return new Response(bytes,{status:imageStatus,headers:{'content-type':'image/jpeg'}});
};
const TP={bail:false,pageInstanceId:'fixture',log:{info(){},warn(){},debug(){}},
 normUrl:v=>v||'',getBestImgUrl:img=>img.src,isTranslationOutputImage:()=>false,
 buildPayload:o=>({...o,src:o.original_image_url,context:{}}),buildPositionFromElement:()=>({}),
 traceNote(){},traceNoteFor(){},overlayMount:{dropHtmlOverlay:key=>dropped.push(key),hasRasterOverlay:()=>false,hasHtmlOverlay:()=>false},
 applyInsertMessage:async msg=>{placed.push(msg);return {ok:true,applied:true}}};
const window=new EventTarget();window.fetch=nativeFetch;window.__TP=TP;
const timers=new Set();
const ctx=vm.createContext({window,document,location,URL,Response,Blob,Uint8Array,CustomEvent,DOMException,AbortController,
 crypto:webcrypto,CSS:{escape:s=>s},MutationObserver,console,
 setTimeout:(f,ms)=>{const t=setTimeout(()=>{timers.delete(t);f()},ms);timers.add(t);return t},clearTimeout:t=>{timers.delete(t);clearTimeout(t)},
 FileReader:class{readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result=`data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;this.onload()})}},
 chrome:{runtime:{sendMessage:(m,cb)=>{events.push(m);cb?.()},lastError:null}}});
for(const name of ['content/sites/kagane/page-bridge.js','content/sites/kagane/adapter.js','content/reader/classification.js','content/reader/runtime.js'])vm.runInContext(script(name),ctx);
const observed=()=>window.fetch(`https://kstatic.to/api/v2/books/page/${chapter}/${pages[0].page_id}.jxl?token=${token}`);
const response=await window.fetch('/api/v2/books/'+chapter,{method:'POST'});
assert.equal(response.status,200,'observer preserves website response');await observed();
// Prefetched pages from another chapter must not contaminate current mapping.
await window.fetch(`https://kstatic.to/api/v2/books/page/${other}/${pages[1].page_id}.jxl?token=wrong`);
const found=await TP.collectReaderImages('lens_text','th');
assert.equal(found.items.length,51);assert.equal(document.querySelectorAll('img').length,6);
assert(found.items.every((item,i)=>item.reader.pageId===String(i+1) && item.src.endsWith(pages[i].page_id+'.jxl')));
assert(!JSON.stringify(found).includes(token));assert.equal(found.items[45].naturalSize.width,3878);
const item=found.items[44],run=item.reader.runId;
let fetched=await TP.readReaderDomImage({readerRunId:run,pageId:'45',url:item.src});
assert.equal(fetched.ok,true);assert.match(fetched.dataUri,/^data:image\/jpeg;base64,/);
assert(calls.at(-1).url.includes(pages[44].page_id));
assert.equal((await TP.readReaderDomImage({readerRunId:run,pageId:'46',url:item.src})).ok,false);
const msg={type:'OVERLAY_HTML',generation:item.generation,original:item.src,result:{}};
let receipt=await TP.stageReaderInsert(msg);assert.equal(receipt.pending,true);
const first=mount(45);slots[44].attrs.class='new-class-on-every-scroll';
location.search='?p=45';assert.equal(TP.readerOwnsRun(run),true);
assert.equal(TP.readerCurrent(first,item.generation).ok,true);
receipt=await TP.stageReaderInsert(msg);assert.equal(receipt.applied,true);
first.remove();const replacement=mount(45);slots[44].attrs.class='different-again';
receipt=await TP.stageReaderInsert(msg);assert.equal(receipt.applied,true);
assert.equal(placed.at(-1).readerReplayTarget,replacement);
assert.equal(TP.readerCurrent(first,item.generation).ok,false);
assert.equal(TP.readerCurrent(mount(46),item.generation).ok,false);
// Refresh naturally observed access credentials without invalidating page identity.
token='synthetic-token-b';await window.fetch('/api/v2/books/'+chapter,{method:'POST'});await observed();
await new Promise(resolve=>setTimeout(resolve,20)); // response.clone parsing is deliberately non-blocking
fetched=await TP.readReaderDomImage({readerRunId:run,pageId:'45',url:item.src});assert.equal(fetched.ok,true);
assert(calls.at(-1).url.endsWith('token='+token));
imageStatus=403;fetched=await TP.readReaderDomImage({readerRunId:run,pageId:'45',url:item.src});
assert.equal(fetched.error,'KAGANE_IMAGE_HTTP_403');assert(!JSON.stringify(fetched).includes(token));imageStatus=200;
// A second translation in the same chapter preserves earlier display while
// giving the worker a distinct run ID and without acquiring a new manifest.
const manifestCount=()=>calls.filter(call=>call.init?.method==='POST').length;
const beforeManifest=manifestCount(),beforeDrop=dropped.length;
const nextPage=mount(47);
const second=await TP.buildReaderImagePayload(nextPage,'lens_text','th');
assert.notEqual(second.reader.runId,run);
assert.equal(second.generation.targetKey.replace(/:47$/,':45'),item.generation.targetKey);
assert.equal(manifestCount(),beforeManifest);
assert.equal(dropped.length,beforeDrop,'prior translated page remains displayed');
assert.equal(TP.readerImageForKey(item.generation.targetKey),replacement);
assert.equal((await TP.stageReaderInsert(msg)).stale,true,'old worker result cannot enter new run');
const afterCarry=placed.length;
// Replacing the entire page-image component, including its IMG, retains the
// translated page until the new publisher IMG can receive a local replay.
const component=new El('div');slots[44].append(component);replacement.remove();
const image=new El('img');image.src=`blob:https://kagane.to/${webcrypto.randomUUID()}`;
image.complete=true;image.naturalWidth=1939;image.naturalHeight=2723;component.append(image);
await new Promise(resolve=>setTimeout(resolve,25));
assert.equal(dropped.length,beforeDrop,'React page component removal must not drop the display layer');
assert(placed.length>afterCarry && placed.at(-1).readerReplayTarget===image,'translated page replays locally after component remount');
assert.equal(TP.readerImageForKey(item.generation.targetKey),image);
// A whole reader-root replacement, e.g. a layout change on opening Inspect,
// must also reconnect the same chapter instead of invalidating its results.
root.remove();root=new El('main');slots=Array.from({length:51},(_,i)=>{const slot=new El('div',{'data-page':String(i+1)});root.append(slot);return slot});
const imageAfterRoot=mount(45);document.append(root);
await new Promise(resolve=>setTimeout(resolve,35));
assert.equal(TP.readerOwnsRun(second.reader.runId),true);
assert.equal(TP.readerImageForKey(item.generation.targetKey),imageAfterRoot);
assert(placed.some(entry=>entry.readerReplayTarget===imageAfterRoot));
assert.equal(dropped.length,beforeDrop);
const oldRepair={...msg,generation:{...second.generation,readerPageId:'45',targetKey:item.generation.targetKey},
 translationRun:{runId:'prior-job',generationId:'prior',phase:'repair',revision:2}};
const freshInitial={...msg,generation:{...second.generation,readerPageId:'45',targetKey:item.generation.targetKey},
 translationRun:{runId:'new-job',generationId:'new',phase:'initial',revision:1}};
assert.equal((await TP.stageReaderInsert(oldRepair)).applied,true);
assert.equal((await TP.stageReaderInsert(freshInitial)).applied,true,'new initial result replaces carried repair result');
// A cancellation aborts the page-owned acquisition rather than leaving work behind.
stall=true;const reading=TP.readReaderDomImage({readerRunId:second.reader.runId,pageId:'45',url:item.src});
TP.cancelReaderRun('test',true);fetched=await reading;assert.equal(fetched.ok,false);stall=false;
const single=await TP.buildReaderImagePayload(imageAfterRoot,'lens_text','th');assert.equal(single.reader.total,1);assert.equal(single.reader.pageId,'45');
location.pathname=location.pathname.replace(chapter,other);
assert.equal(TP.readerOwnsRun(single.reader.runId),false);
assert.equal((await TP.stageReaderInsert({...msg,generation:single.generation})).stale,true);
TP.cancelReaderRun('done');for(const t of timers)clearTimeout(t);
// Both content and worker independently preserve only same-chapter scroll URLs.
for(const path of ['content/namespace.js','background/index.js']){
 const text=script(path),start=text.indexOf('function preservesKaganeChapter('),end=text.indexOf('\n}',start)+2;
 const preserves=vm.runInNewContext('('+text.slice(start,end)+')',{URL});
 const base=`https://kagane.to/series/${other}/reader/${chapter}`;
 assert(preserves(base+'?p=1',base+'?p=51'));
 assert(!preserves(base,base.replace(chapter,other)));
 assert(!preserves(base,base.replace('kagane.to','unrelated.test')));
}
console.log('PASS Kagane: 51 logical pages / 6 mounted; token isolation/refresh; JPEG acquisition; React component/root remount; same-chapter display carry; single image; chapter invalidation; cancellation');
// Exercise the real background acquisition entry point: exact owning frame,
// inline image bytes, and no generic URL fallback on Kagane access failures.
const priorChrome=globalThis.chrome;const workerRequests=[];
try{
 let workerReply={ok:true,dataUri:'data:image/jpeg;base64,/9j/'};
 globalThis.chrome={runtime:{lastError:null},tabs:{sendMessage:(tabId,msg,options,done)=>{
   workerRequests.push({tabId,msg,options});done(workerReply);
 }}};
 const {acquireReaderImage}=await import('../src/background/reader-acquisition.js');
 const payload={src:'https://kstatic.to/api/v2/books/page/'+chapter+'/'+pages[44].page_id+'.jxl',
   reader:{adapter:'kagane',runId:'owned',pageId:'45'},generation:{readerRunId:'owned'}};
 assert.equal(await acquireReaderImage(payload,{tabId:5,frameId:7}),workerReply.dataUri);
 assert.equal(workerRequests[0].options.frameId,7);assert.equal(workerRequests[0].msg.pageId,'45');
 workerReply={ok:false,error:'KAGANE_IMAGE_HTTP_403'};
 await assert.rejects(acquireReaderImage(payload,{tabId:5,frameId:7}),/KAGANE_IMAGE_HTTP_403/);
 assert.equal(workerRequests.length,2,'no top-frame or unsigned URL fallback');
 const controller=new AbortController();controller.abort();
 await assert.rejects(acquireReaderImage(payload,{tabId:5,signal:controller.signal}),{name:'AbortError'});
 assert.equal(workerRequests.length,2);
 console.log('PASS Kagane worker: exact frame acquisition, inline bytes, explicit access failure, aborted job');
}finally{globalThis.chrome=priorChrome;}
