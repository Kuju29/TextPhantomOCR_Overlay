import assert from 'node:assert/strict';
import {acquireImageDataUri} from '../src/background/image-acquisition.js';
import {createJobPreparation} from '../src/background/pipeline/job-preparation.js';
import {comixCandidate} from '../src/background/image-composition.js';

const page='https://comix.to/chapter/example', image='https://ek10.wowpic1.store/i5/example?8';
const plainBody=new Uint8Array(128).fill(7), pngBody=new Uint8Array(128).fill(9);
const originalFetch=globalThis.fetch, originalChrome=globalThis.chrome;
const originalBitmap=globalThis.createImageBitmap,originalCanvas=globalThis.OffscreenCanvas;
const calls=[], events=[], rules=[], activeRules=new Set();
globalThis.chrome={runtime:{getURL:()=> 'chrome-extension://extension/',lastError:null},
  declarativeNetRequest:{getSessionRules(callback){callback([...activeRules].map(id=>({id})));},updateSessionRules(rule,callback){
    for(const id of rule.removeRuleIds || [])activeRules.delete(id);
    if(rule.addRules)for(const item of rule.addRules){rules.push(item);activeRules.add(item.id);}
    callback();}}};
globalThis.createImageBitmap=async()=>({width:10,height:10,close(){}});
globalThis.OffscreenCanvas=class{
  constructor(width,height){this.width=width;this.height=height;}
  getContext(){return {drawImage(){}};}
  convertToBlob(){return Promise.resolve(new Blob([pngBody],{type:'image/png'}));}
};
let scenario='default';
let activeReferers=0,maxActiveReferers=0;
globalThis.fetch=async (url,options)=>{
  calls.push({url:String(url),options});
  if(scenario==='serial' && options.cache==='force-cache')throw Error('DEFAULT_BLOCKED');
  if(scenario==='serial' && options.cache==='no-store'){
    activeReferers++;maxActiveReferers=Math.max(maxActiveReferers,activeReferers);
    await new Promise(resolve=>setTimeout(resolve,10));activeReferers--;
  }
  if(scenario==='referer' && calls.length===1)throw Error('DEFAULT_BLOCKED');
  if(scenario==='transient' && calls.length===1)throw Error('DEFAULT_BLOCKED');
  if(scenario==='transient' && calls.length===2)return new Response('',{status:503});
  if(scenario==='abort-retry' && calls.length===1)throw Error('DEFAULT_BLOCKED');
  if(scenario==='abort-retry')return new Response('',{status:503});
  if(scenario==='dom')throw Error('FETCH_BLOCKED');
  const metadata=scenario.startsWith('plain') || scenario==='missing' ? {} : {
    'Content-Type':'image/webp','X-Scramble-Grid':'5x5','X-Scramble-Seed':'4228536156',
    'X-Scramble-Algo':'3','X-Scramble-Hash':'02900',
  };
  return new Response(new Blob([plainBody],{type:'image/webp'}),{status:200,headers:metadata});
};
try{
  const options=()=>({scope:`composition-test-${scenario}`,compositionHint:scenario.startsWith('plain')?'unknown':'scrambled',
    domFetch:()=>Promise.resolve('data:image/png;base64,'+btoa('dom')),onRoute:(event,detail)=>events.push([event,detail])});
  const first=await acquireImageDataUri(image,page,null,options());
  assert.ok(first.startsWith('data:image/png;base64,'));
  assert.equal(calls.length,1);
  assert.ok(calls[0].url.endsWith('?8&v3'));
  assert.ok(events.some(([event])=>event==='composition_complete'));

  scenario='referer';calls.length=0;events.length=0;
  const second=await acquireImageDataUri(image,page,null,options());
  assert.ok(second.startsWith('data:image/png;base64,'));
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.url.endsWith('?8&v3')));
  assert.ok(events.some(([event,detail])=>event==='success'&&detail.route==='REFERER'));
  assert.ok(rules.some(rule=>rule.action.requestHeaders.some(h=>h.header==='Origin'&&h.operation==='remove')));

  // The first CDN 503 is recoverable while a lazy reader's canvas is absent.
  scenario='transient';calls.length=0;events.length=0;
  const recovered=await acquireImageDataUri(image,page,null,options());
  assert.ok(recovered.startsWith('data:image/png;base64,'));
  assert.equal(calls.length,3);
  assert.equal(activeRules.size,0,'temporary Referer rule is removed after recovery');
  assert.ok(calls.every(call=>call.url.endsWith('?8&v3')));
  assert.ok(events.some(([event,detail])=>event==='retry'&&detail.route==='REFERER'&&detail.status===503));
  assert.ok(!events.some(([event,detail])=>event==='start'&&detail.route==='DOM'));
  scenario='abort-retry';calls.length=0;events.length=0;
  const stop=new AbortController();
  await assert.rejects(acquireImageDataUri(image,page,stop.signal,{
    ...options(),onRoute:(event,detail)=>{
      events.push([event,detail]);if(event==='retry')stop.abort();
    },
  }),error=>error.name==='AbortError');
  assert.equal(calls.length,2,'cancellation stops the page before a third CDN request');
  assert.equal(activeRules.size,0,'cancellation removes the exact-URL Referer rule');
  scenario='serial';calls.length=0;events.length=0;
  await Promise.all([acquireImageDataUri(image,page,null,options()),
    acquireImageDataUri(image,page,null,options())]);
  assert.equal(maxActiveReferers,1,'two requests for the same URL never overlap under a Referer rule');
  assert.equal(activeRules.size,0,'serialized requests remove both temporary rules');

  scenario='dom';calls.length=0;events.length=0;
  const third=await acquireImageDataUri('https://reader.test/page.webp','https://reader.test/chapter',null,
    {...options(),compositionHint:'unknown'});
  assert.equal(third,'data:image/png;base64,'+btoa('dom'));
  assert.equal(calls.length,2);
  assert.ok(events.some(([event,detail])=>event==='success'&&detail.route==='DOM'));

  // A known scrambled source must never wait for a canvas or accept raw tiles.
  calls.length=0;events.length=0;
  await assert.rejects(acquireImageDataUri(image,page,null,{
    ...options(),scope:'composition-failed-url',domFetch:()=>{throw Error('canvas must not be read');},
  }),/READER_ACQUISITION_FAILED/);
  assert.equal(calls.length,2);
  assert.ok(!events.some(([event,detail])=>event==='start'&&detail.route==='DOM'));
  scenario='missing';calls.length=0;events.length=0;
  await assert.rejects(acquireImageDataUri(image,page,null,options()),
    /READER_ACQUISITION_FAILED/);
  assert.ok(events.some(([event,detail])=>event==='composition_failed'&&
    detail.code==='metadata_missing'));
  assert.ok(!events.some(([event,detail])=>event==='start'&&detail.route==='DOM'));

  scenario='plain';calls.length=0;events.length=0;
  const normal=await acquireImageDataUri('https://example.test/page.webp','https://example.test/chapter',null,options());
  assert.ok(normal.startsWith('data:image/webp;base64,'));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://example.test/page.webp');
  assert.ok(events.some(([event])=>event==='composition_plain'));
  scenario='plain-comix';calls.length=0;events.length=0;
  const unmarked=await acquireImageDataUri(image,page,null,options());
  assert.ok(unmarked.startsWith('data:image/webp;base64,'));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,image);
  // A denied verified source must not escape to the normal tab fallback or
  // server URL path, where neither response metadata nor bytes are checked.
  let tabFallbacks=0, readErrors=0;
  const guarded=createJobPreparation({batchIsCancelled:()=>false,failWorkflow:async()=>{},
    shouldPrefetch:()=>true,requiresVerifiedImage:comixCandidate,
    fetchFromTab:async()=>{tabFallbacks++;return 'data:image/png;base64,aW1hZ2U=';},
    fetchFromUrl:async()=>{throw Error('HTTP 403');},getCached:()=>null,setCached:()=>{},
    normalizeImageKey:value=>value,classifyError:()=>({permanent:false}),
    onDownloadStarted:()=>{},onPayloadUpdated:()=>{},onPermanentReadError:async()=>{readErrors++;},
    logInfo:()=>{},logWarn:()=>{},reportDiagnostic:()=>{}});
  const denied=await guarded.prefetchDataUri({src:image,metadata:{},context:{}},
    {tabId:10,pageUrl:page});
  assert.equal(denied.stopped,true);
  assert.equal(tabFallbacks,0);
  assert.equal(readErrors,1);
  console.log('image acquisition: DEFAULT, Referer, DOM fallback and ordinary image routes OK');
}finally{
  globalThis.fetch=originalFetch;globalThis.chrome=originalChrome;
  globalThis.createImageBitmap=originalBitmap;globalThis.OffscreenCanvas=originalCanvas;
}
