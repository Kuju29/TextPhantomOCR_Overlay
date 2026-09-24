// Saved site JS persists kagane_drm_tokens and skips the POST on cache hit.
// Synthetic fixtures only; no user tokens, HTML or image content are shipped.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const code=readFileSync(new URL('../src/content/sites/kagane/page-bridge.js',import.meta.url),'utf8');
const series='019c3cc0-468d-72d3-a7de-fda30338e242',chapter='019c3ce9-99b1-7132-beda-0d00e6d9d0b7';
const other='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
class CE extends Event{constructor(t,o){super(t);this.detail=o.detail}}
async function fixture({expired=false,wrongSeries=false,wrongToken=false,late=false,datasaver=false,malformed=false}={}){
 const location=new URL(`https://kagane.to/series/${series}/reader/${chapter}`);
 const pages=Array.from({length:51},(_,i)=>({page_no:i+1,page_id:webcrypto.randomUUID(),ext:'jxl',width:1900,height:2700}));
 const token='fixture-private-token';
 const cache=JSON.stringify({[`${wrongSeries?other:series}:${chapter}${datasaver?'_ds':''}`]:{
  token,cacheUrl:'https://kstatic.to',pages,expires:Date.now()+(expired?-1000:120000)},
  [`${series}:${other}`]:{token:'other-token',cacheUrl:'https://kstatic.to',pages,expires:Date.now()+120000}});
 const document=new EventTarget(),window=new EventTarget(),calls=[];
 const bytes=new Uint8Array(100);bytes.set([255,216,255]);
 window.fetch=async(url,init)=>{calls.push({url:String(url),init});return new Response(bytes,{headers:{'content-type':'image/jpeg'}})};
 const image=`https://kstatic.to/api/v2/books/page/${datasaver?'datasaver/':''}${chapter}/${pages[0].page_id}.jxl?token=${wrongToken?'mismatch':token}`;
 vm.runInNewContext(code,{window,document,location,URL,crypto:webcrypto,CustomEvent:CE,Response,Blob,Uint8Array,AbortController,
  sessionStorage:{getItem:key=>{assert.equal(key,'kagane_drm_tokens');return malformed?'broken-json':cache}},
  performance:{getEntriesByType:()=>late?[{name:image,initiatorType:'fetch'}]:[]},
  setTimeout:(fn,ms)=>setTimeout(fn,ms===2500?25:ms),clearTimeout,
  FileReader:class{readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result=`data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;this.onload()})}}});
 if(!late)await window.fetch(image);
 const request=body=>new Promise(resolve=>{const id=webcrypto.randomUUID();const receive=e=>{const r=JSON.parse(e.detail);if(r.id===id){document.removeEventListener('TP_KAGANE_REPLY_V1',receive);resolve(r)}};
 document.addEventListener('TP_KAGANE_REPLY_V1',receive);document.dispatchEvent(new CE('TP_KAGANE_REQUEST_V1',{detail:JSON.stringify({id,chapter,...body})}));});
 const manifest=await request({action:'manifest'});
 return {manifest,request,calls,token,pages};
}
for(const options of [{},{late:true},{datasaver:true},{late:true,datasaver:true}]){
 const f=await fixture(options);assert.equal(f.manifest.ok,true,`cache-hit chapter must work without POST: ${JSON.stringify(options)}`);
 assert.equal(f.manifest.rows.length,51);assert(!JSON.stringify(f.manifest).includes(f.token));
 assert.equal(f.manifest.diagnostics.manifestSource,'session_cache');
 const result=await f.request({action:'read',lease:f.manifest.lease,pageId:'45'});
 assert.equal(result.ok,true);assert.match(result.dataUri,/^data:image\/jpeg;/);
 assert(f.calls.at(-1).url.includes(f.pages[44].page_id));
 assert(f.calls.every(call=>call.init?.method!=='POST'),'no extra token API call');
}
for(const options of [{expired:true},{wrongSeries:true},{wrongToken:true},{malformed:true}]){
 const f=await fixture(options);assert.equal(f.manifest.ok,false,JSON.stringify(options));
 assert.match(f.manifest.error,/KAGANE_MANIFEST_UNAVAILABLE/);
 assert(f.manifest.diagnostics);assert(!JSON.stringify(f.manifest).includes(f.token));
}
console.log('PASS Kagane session cache: reload without POST; late bridge via observed resources; datasaver; full chapter mapping/read; reject expired/wrong series/token/malformed cache; credential-free diagnostics');
