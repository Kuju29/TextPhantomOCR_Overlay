import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=name=>readFileSync(path.join(root,'src/content',name),'utf8');
const scanId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makePage(dynamic) {
  const logs=[];
  let listener;
  const img={tagName:'IMG',isConnected:true,complete:true,naturalWidth:900,naturalHeight:1200,
    src:'blob:https://reader.test/first',currentSrc:'blob:https://reader.test/first'};
  const slots=new Map(['1','2','3'].map(id=>[id,{id,isConnected:true,
    getAttribute:()=>id,img:id==='1'?img:null}]));
  const rootEl={isConnected:true,contains:()=>true};
  const plan={type:'DYNAMIC',profile:'numbered-reader',selector:'[data-page]',attr:'data-page',
    ids:['1','2','3'],slots,root:rootEl,sourceDiagnostics:{inline:'not_found',bridge:'no_manifest',propsFound:4,propsResolved:0}};
  const TP={bail:false,pageInstanceId:'fixture',log:{info(){},warn(){},debug(){}},
    readerClassification:{detect:()=>dynamic?plan:null,
      number:slot=>slot?.id || '',image:slot=>slot?.img || null,
      surface:slot=>slot?.img || null,source:slot=>slot?.img?.src || '',
      sources:async()=>new Map([['1',img.src]])},
    getSettings:async()=>({mode:'lens_image',lang:'th'}),
    getBestImgUrl:image=>image.src,normUrl:raw=>String(raw || ''),
    truncate:raw=>String(raw || '').slice(0,30),
    buildPositionFromElement:()=>({}),buildPipelineEvent:()=>({stage:'collected'}),
    isTranslationOutputImage:()=>false,isMangaDexHost:()=>false,
    removeLazyScriptsAndForceSrc(){},normalizeLazyImages(){},cancelReaderRun(){},
    collectImagesForScan:async()=>({items:[{src:'https://cdn.test/page.jpg?token=secret-value'}],
      stats:{candidates:1,accepted:1,skipped:0,duplicates:0,reasons:{}}}),
    traceNote(){},traceNoteFor(){},
  };
  const win={__TP:TP,addEventListener(){}};win.top=win;
  const normalImage={src:'https://cdn.test/page.jpg?token=secret-value',currentSrc:'',
    isConnected:true,complete:true,naturalWidth:900,naturalHeight:1200,
    getBoundingClientRect:()=>({width:900,height:1200}),getAttribute:()=>null,dataset:{}};
  const context={window:win,document:{images:dynamic?[img]:[normalImage]},
    location:{hostname:'reader.test',href:'https://reader.test/chapter?token=another-secret'},
    chrome:{runtime:{onMessage:{addListener:fn=>{listener=fn;}},lastError:null,
      sendMessage:(_msg,callback)=>callback?.()}},
    console:{log:line=>logs.push(line)},setTimeout:()=>1,clearTimeout(){},
    crypto:{randomUUID:()=>scanId},URL,Date,DOMException,AbortController,Map,Set,WeakMap};
  vm.runInNewContext(script('image-scan-diagnostics.js'),context);
  if(dynamic)vm.runInNewContext(script('reader/runtime.js'),context);
  else {TP.collectReaderImages=async()=>null;vm.runInNewContext(script('payload.js'),context);}
  vm.runInNewContext(script('messaging.js'),context);
  const send=msg=>new Promise(resolve=>listener(msg,{},resolve));
  const events=()=>logs.map(line=>JSON.parse(line.replace(/^\[TP_IMAGE_SCAN\] /,'')));
  return {TP,send,events,logs};
}

const silent=makePage(false);
const silentResponse=await silent.send({type:'GET_IMAGES'});
assert.equal(silentResponse.ok,true,silentResponse.error);
assert.equal(silent.events().length,0,'ordinary requests must not print image scan evidence');

const normal=makePage(false);
await normal.send({type:'TP_IMAGE_SCAN_DIAGNOSTIC',scanId,phase:'dispatch_start',
  detail:{trigger:'context_menu'}});
const normalResult=await normal.send({type:'GET_IMAGES',diagnosticId:scanId,
  diagnosticTrigger:'context_menu'});
assert.equal(normalResult.items.length,1);
assert(normal.events().some(e=>e.phase==='route.selected'&&e.route==='NORMAL'));
assert(normal.events().some(e=>e.phase==='content.scan_result'&&e.accepted===1));
assert(normal.events().some(e=>e.phase==='normal.candidates'&&e.rows.length===1&&
  e.rows[0].decision==='accepted'&&e.rows[0].source.kind==='http'));
normal.TP.scanDiag.emit('privacy',{url:'https://host.test/path?token=private',
  imageDataUri:'data:image/png;base64,private',message:'Bearer=private'});
assert(!normal.logs.join('\n').includes('private'));
assert(!normal.logs.join('\n').includes('secret-value'));
const originalChrome=globalThis.chrome;
try {
  globalThis.chrome={runtime:{lastError:null},tabs:{sendMessage:(_tabId,msg,_opts,done)=>{
    void normal.send(msg).then(done);
  }}};
  const {startImageScanDiagnostics,reportImageScan}=await import('../src/background/image-scan-diagnostics.js');
  startImageScanDiagnostics(scanId, 15, 0);
  assert.equal(await reportImageScan(scanId,'scan_delivery',{
    frameId:0,delivered:true,hasResponse:true}),true);
  assert(normal.events().some(e=>e.phase==='worker.scan_delivery'&&e.delivered===true));
} finally {globalThis.chrome=originalChrome;}

const reader=makePage(true);
await reader.send({type:'TP_IMAGE_SCAN_DIAGNOSTIC',scanId,phase:'dispatch_start',
  detail:{trigger:'page_action'}});
const response=await reader.send({type:'GET_IMAGES',diagnosticId:scanId,
  diagnosticTrigger:'page_action'});
assert.equal(response.ok,false);
assert.equal(response.code,'READER_SOURCE_UNAVAILABLE');
const evidence=reader.events();
assert(evidence.some(e=>e.phase==='click'&&e.trigger==='page_action'));
assert(evidence.some(e=>e.phase==='route.selected'&&e.route==='DYNAMIC'&&e.logicalPages===3));
assert(evidence.some(e=>e.phase==='reader.source_barrier'&&e.resolved===1&&
  e.missingCount===2&&e.missingPages.join(',')==='2,3'));
assert(evidence.some(e=>e.phase==='content.scan_error'&&e.error.code==='READER_SOURCE_UNAVAILABLE'));
assert(evidence.some(e=>e.phase==='dom.snapshot'&&e.rows[0].source.kind==='blob'&&
  e.rows[1].source.kind==='none'));
assert(reader.logs.every(line=>line.startsWith('[TP_IMAGE_SCAN] ')));

// Kagane-style numbered placeholders can carry component data which the
// existing HTTP-only bridge sees but cannot turn into image sources.
const eventHandlers=new Map();
let pageWorldReply;
const slots=['1','2','3'].map(pageId=>({
  getAttribute:()=>pageId,closest:()=>null,
  '__reactProps$fixture':{imageUrl:`blob:https://reader.test/${pageId}?token=hidden`,
    page:{page_no:Number(pageId),page_id:`private-${pageId}`}},
}));
const scope={closest:()=>null,querySelectorAll:()=>slots};
const eventDocument={querySelector:()=>scope,
  addEventListener:(type,callback)=>eventHandlers.set(type,callback),
  dispatchEvent(event){if(event.type==='TP_READER_SOURCES_REPLY_V1')pageWorldReply=JSON.parse(event.detail);
    else eventHandlers.get(event.type)?.(event);}};
class CustomEventFixture {constructor(type,init){this.type=type;this.detail=init.detail;}}
vm.runInNewContext(script('reader/page-sources.js'),{
  document:eventDocument,location:{href:'https://reader.test/chapter'},
  Node:class {},Element:class {},CustomEvent:CustomEventFixture,URL,Set,Map,WeakSet,JSON,
});
eventDocument.dispatchEvent(new CustomEventFixture('TP_READER_SOURCES_V1',{
  detail:JSON.stringify({id:scanId,href:'https://reader.test/chapter',pages:['1','2','3'],
    attr:'data-page',diagnostics:true}),
}));
assert.equal(pageWorldReply.rows.length,0);
assert.equal(pageWorldReply.diagnostics.pages.length,3);
assert(pageWorldReply.diagnostics.pages.every(row=>row.fieldKinds.blob===1 && row.httpCandidates===0));
assert(pageWorldReply.diagnostics.pages.every(row=>row.hints.page_no && row.hints.page_id));
assert(!JSON.stringify(pageWorldReply.diagnostics).includes('private-'));
assert(!JSON.stringify(pageWorldReply.diagnostics).includes('token=hidden'));

const manifestEvents=[];
const sourceTP={bail:false,scanDiag:{active:()=>true,emit:(phase,details)=>manifestEvents.push({phase,...details}),
  describeSource:()=>({kind:'blob'})}};
const manifestDoc={querySelectorAll:()=>[{textContent:JSON.stringify({
  pages:['https://cdn.test/1.jpg','https://cdn.test/2.jpg','https://cdn.test/3.jpg']})}]};
vm.runInNewContext(script('reader/sources.js'),{
  window:{__TP:sourceTP},location:{href:'https://reader.test/chapter'},document:manifestDoc,
  URL,Map,Set,WeakSet,DOMException,
});
const manifestResult=await sourceTP.readerSources({ids:['1','2','3'],slots:new Map(slots.map((slot,i)=>[
  String(i+1),{img:i===0?{src:'blob:https://reader.test/first'}:null}])),
  root:{closest:()=>null}},slot=>slot?.img?.src||'',{
    document:manifestDoc,pageWorld:false,knownSources:new Map([['1','blob:https://reader.test/first']]),
  });
assert.equal(manifestResult.profile,'reader-source-unresolved');
assert(manifestEvents.some(e=>e.phase==='reader.manifest_check'&&
  e.outcomes.includes('no_http_anchor_or_chapter_identity')));

// A blob handed to the Dynamic Reader currently skips DOM acquisition. This
// evidence must appear in the page console when that branch is reached.
const {acquireImageDataUri}=await import('../src/background/image-acquisition.js');
const originalFetch=globalThis.fetch;
const routeEvents=[];
let domFetches=0;
try {
  globalThis.fetch=async()=>({ok:true,headers:new Headers({'content-type':'image/png'}),
    blob:async()=>new Blob([new Uint8Array(80)],{type:'image/png'})});
  await acquireImageDataUri('blob:https://reader.test/example','https://reader.test/chapter',null,{
    onRoute:(event,detail)=>routeEvents.push({event,...detail}),
    domFetch:()=>{domFetches++;throw Error('unexpected DOM request');},
  });
} finally {globalThis.fetch=originalFetch;}
assert.equal(domFetches,0);
assert(routeEvents.some(e=>e.event==='start'&&e.route==='WORKER_NON_HTTP'&&
  e.domFallbackAvailable===false));
assert(routeEvents.some(e=>e.event==='success'&&e.route==='WORKER_NON_HTTP'));
console.log('Image-scan console diagnostics: NORMAL, Dynamic Reader, failure, trigger and redaction passed.');
