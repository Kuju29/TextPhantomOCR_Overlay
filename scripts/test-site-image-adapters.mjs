import assert from 'node:assert/strict';
import { omoiCandidate, decodeOmoi } from '../src/background/image-composition/omoi.js';
import { vizEndpoint, vizSignedUrl, vizExif, decodeViz } from '../src/background/image-composition/viz.js';
import { mangagoKey, decodeMangago } from '../src/background/image-composition/mangago.js';
import { kmangaKey, decodeKManga } from '../src/background/image-composition/kmanga.js';
import { siteImageCandidate, decodeSiteImage } from '../src/background/image-composition/site-adapters.js';
import { acquireImageDataUri } from '../src/background/image-acquisition.js';
import { acquireReaderImage } from '../src/background/reader-acquisition.js';
import { normImgSrc } from '../src/background/job-keys.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function exifJpeg(key=Array.from({length:104},(_,i)=>103-i)) {
  const value=new TextEncoder().encode(key.map(v=>v.toString(16)).join(':')+'\0');
  const tiff=new Uint8Array(68+value.length),dv=new DataView(tiff.buffer);
  tiff.set([0x49,0x49]);dv.setUint16(2,42,true);dv.setUint32(4,8,true);
  dv.setUint16(8,1,true);
  dv.setUint16(10,0x8769,true);dv.setUint16(12,4,true);dv.setUint32(14,1,true);dv.setUint32(18,26,true);
  dv.setUint16(26,3,true);
  dv.setUint16(28,0xa420,true);dv.setUint16(30,2,true);dv.setUint32(32,value.length,true);dv.setUint32(36,68,true);
  dv.setUint16(40,0xa002,true);dv.setUint16(42,4,true);dv.setUint32(44,1,true);dv.setUint32(48,20,true);
  dv.setUint16(52,0xa003,true);dv.setUint16(54,4,true);dv.setUint32(56,1,true);dv.setUint32(60,15,true);
  tiff.set(value,68);
  const size=2+6+tiff.length;
  const bytes=new Uint8Array(2+2+size+2);
  bytes.set([0xff,0xd8,0xff,0xe1,size>>8,size&255,0x45,0x78,0x69,0x66,0,0]);
  bytes.set(tiff,12);bytes.set([0xff,0xd9],12+tiff.length);
  return bytes;
}

const originals={bitmap:globalThis.createImageBitmap,canvas:globalThis.OffscreenCanvas,
  fetch:globalThis.fetch,chrome:globalThis.chrome};
const cell=(x,y,w)=>(7*x+11*y)&255;
class RasterCanvas {
  constructor(width,height){this.width=width;this.height=height;this.pixels=new Uint8Array(width*height);}
  getContext(){return {imageSmoothingEnabled:false,drawImage:(img,...args)=>{
    const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length===4
      ? [0,0,img.width,img.height,...args] : args;
    assert.equal(sw,dw);assert.equal(sh,dh);
    for(let y=0;y<sh;y++)for(let x=0;x<sw;x++)
      this.pixels[(dy+y)*this.width+dx+x]=img.pixels[(sy+y)*img.width+sx+x];
  }};}
  async convertToBlob(){return new Blob([this.pixels],{type:'image/png'});}
}
globalThis.OffscreenCanvas=RasterCanvas;
globalThis.createImageBitmap=async blob=>{
  const {width,height}=blob.mockBitmap;
  return {width,height,pixels:blob.mockBitmap.pixels,close(){}};
};
function mockImage(width,height,bytes=new Uint8Array(128)) {
  const blob=new Blob([bytes],{type:'image/jpeg'});
  blob.mockBitmap={width,height,pixels:Uint8Array.from({length:width*height},(_,i)=>cell(i%width,Math.floor(i/width),width))};
  return blob;
}
function contentNormalizer(file,start,end,name,site) {
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  const snippet=source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  assert.ok(snippet.startsWith(start));
  return vm.runInNewContext(`(function(){${snippet};return ${name}})()`,
    {URL,TP:{},location:{href:site,hostname:new URL(site).hostname}});
}
try {
  const data=new Uint8Array(128).fill(41);data.set([255,216,255,224],0);
  const encrypted=Uint8Array.from(data,byte=>byte^174);
  const drm='https://assets.omoi.com/page.jpeg?drm=1';
  assert.equal(omoiCandidate(drm,'https://omoi.com/chapter/1'),true);
  assert.equal(omoiCandidate(drm,'https://other.example/chapter/1'),false);
  assert.deepEqual(new Uint8Array(await (await decodeOmoi(new Blob([encrypted]))).arrayBuffer()),data);
  assert.equal((await decodeOmoi(new Blob([data]))).size,data.length);
  await assert.rejects(decodeOmoi(new Blob([new Uint8Array(128)])),/did not decode/);
  assert.equal(await decodeSiteImage(new Blob([data]),{url:'https://other.example/p.jpg',pageUrl:'https://other.example'}).then(b=>b.size),128);

  assert.equal(vizEndpoint('https://www.viz.com/manga/get_manga_url?chapter=1','https://www.viz.com/read'),true);
  assert.equal(vizEndpoint('https://attacker.example/manga/get_manga_url','https://www.viz.com/read'),false);
  const signed='https://cdn.viz.com/page.jpg?token=123';
  assert.equal(await vizSignedUrl(new Response(JSON.stringify({data:{0:signed}}),
    {headers:{'Content-Type':'application/json'}})),signed);
  await assert.rejects(vizSignedUrl(new Response(JSON.stringify({data:{0:'http://localhost/private'}}),
    {headers:{'Content-Type':'application/json'}})),/invalid image URL/);
  assert.equal(vizExif(new Uint8Array(128)),null);
  const fixture=exifJpeg();
  assert.deepEqual(vizExif(fixture)?.key.slice(0,4),[103,102,101,100]);
  assert.equal(vizExif(exifJpeg([0,0,...Array.from({length:102},(_,i)=>i+2)])),null);
  const v=mockImage(110,155,fixture);
  const decoded=new Uint8Array(await (await decodeViz(v)).arrayBuffer());
  assert.equal(decoded.length,20*15);
  assert.equal(decoded[16+13*20],v.mockBitmap.pixels[12+11*110]);
  assert.equal(decoded[0],v.mockBitmap.pixels[0]);
  assert.equal(decoded[0+14*20],v.mockBitmap.pixels[154*110]);
  const mirrored=new Uint8Array(await (await decodeSiteImage(v,{url:'https://mirror.example/p.jpg',
    pageUrl:'https://reader.example/chapter/1'})).arrayBuffer());
  assert.deepEqual(mirrored,decoded);
  const ordinary=mockImage(110,155);
  assert.strictEqual(await decodeViz(ordinary),ordinary);
  const mUrl='https://cspiclink.example/image.jpg#desckey=2a0a3a1&cols=2';
  const mPage='https://www.mangago.me/read/123';
  assert.deepEqual(mangagoKey(mUrl,mPage),{cols:2,order:[1,3,0,2]});
  assert.equal(siteImageCandidate(mUrl,mPage),true);
  assert.equal(siteImageCandidate(mUrl,'https://example.test/'),false);
  const m=mockImage(17,17);
  const mOut=new Uint8Array(await (await decodeMangago(m,mUrl,mPage)).arrayBuffer());
  assert.equal(mOut[0],m.mockBitmap.pixels[8]);
  assert.equal(mOut[8*17],m.mockBitmap.pixels[0]);
  assert.equal(mOut[16],m.mockBitmap.pixels[16]); // uncovered edge survives
  assert.equal(mangagoKey(mUrl.replace('2a0a3a1','2a2a3a1'),mPage),null);
  assert.equal(normImgSrc(mUrl),mUrl);
  assert.equal(normImgSrc('https://example.test/a.jpg#view'),'https://example.test/a.jpg');
  const normM=contentNormalizer('../src/content/dom-utils.js','function normUrl(u) {',
    '  const isHttpish','normUrl',mPage);
  const readerM=contentNormalizer('../src/content/reader/sources.js','const http = raw => {',
    '  const sameImage','http',mPage);
  assert.equal(normM(mUrl),mUrl);assert.equal(readerM(mUrl),mUrl);
  assert.equal(normM(mUrl.replace('#desckey=2a0a3a1&cols=2','#view')),
    mUrl.split('#')[0]);
  assert.equal(readerM(mUrl.replace('#desckey=2a0a3a1&cols=2','#view')),
    mUrl.split('#')[0]);
  const kPage='https://kmanga.kodansha.com/title/100';
  const kUrl='https://images.example/page.jpeg#we7:100:222';
  const order=kmangaKey(kUrl,kPage);
  assert.equal(order.length,16);assert.equal(new Set(order).size,16);
  assert.equal(kmangaKey(kUrl,'https://not-kmanga.example'),null);
  assert.equal(normImgSrc(kUrl),kUrl);
  const normK=contentNormalizer('../src/content/dom-utils.js','function normUrl(u) {',
    '  const isHttpish','normUrl',kPage);
  const readerK=contentNormalizer('../src/content/reader/sources.js','const http = raw => {',
    '  const sameImage','http',kPage);
  assert.equal(normK(kUrl),kUrl);assert.equal(readerK(kUrl),kUrl);
  const k=mockImage(18,18);
  const kOut=new Uint8Array(await (await decodeKManga(k,kUrl,kPage)).arrayBuffer());
  assert.equal(kOut[0],k.mockBitmap.pixels[(order[0]%4)*4+Math.floor(order[0]/4)*4*18]);
  assert.equal(kOut[17*18+17],k.mockBitmap.pixels[17*18+17]); // remainder preserved

  const events=[],requests=[],dnr=[];
  globalThis.chrome={runtime:{getURL:()=> 'chrome-extension://extension/',lastError:null},
    declarativeNetRequest:{getSessionRules(cb){cb([]);},updateSessionRules(value,cb){
      dnr.push(value);cb();}}};
  globalThis.fetch=async (url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).includes('/get_manga_url'))
      return new Response(JSON.stringify({data:{0:signed}}),{headers:{'Content-Type':'application/json'}});
    if(String(url).includes('omoi'))
      return new Response(encrypted,{headers:{'Content-Type':'image/jpeg'}});
    return new Response(data,{headers:{'Content-Type':'image/jpeg'}});
  };
  const omoiData=await acquireImageDataUri(drm,'https://omoi.com/chapter/1',null,
    {scope:'omoi-test',onRoute:(kind,detail)=>events.push({kind,detail})});
  assert.equal(Buffer.from(omoiData.split(',')[1],'base64').compare(Buffer.from(data)),0);
  assert.ok(events.some(x=>x.kind==='composition_complete'&&x.detail.kind==='omoi-xor'));
  const vizData=await acquireImageDataUri('https://www.viz.com/manga/get_manga_url?chapter=1',
    'https://www.viz.com/read',null,{scope:'viz-test'});
  assert.equal(requests.length,3);
  assert.equal(requests[2].url,signed);
  assert.equal(Buffer.from(vizData.split(',')[1],'base64').compare(Buffer.from(data)),0);
  assert.equal(dnr.length,0); // normal routes do not add header rewrite rules
  const normal=await acquireImageDataUri('https://normal.example/page.jpg','https://normal.example/read',null,
    {scope:'ordinary-test'});
  assert.equal(Buffer.from(normal.split(',')[1],'base64').compare(Buffer.from(data)),0);
  let fallbackCalls=0;
  globalThis.fetch=async url=>{
    fallbackCalls++;
    if(fallbackCalls===1)throw Error('site requires Referer');
    return new Response(encrypted,{headers:{'Content-Type':'image/jpeg'}});
  };
  const fallback=await acquireImageDataUri(drm,'https://omoi.com/chapter/1',null,
    {scope:'omoi-referer-test'});
  assert.equal(fallbackCalls,2);
  assert.equal(Buffer.from(fallback.split(',')[1],'base64').compare(Buffer.from(data)),0);
  assert.ok(dnr.some(row=>row.addRules?.some(rule=>rule.action.requestHeaders.some(header=>
    header.header==='Origin'&&header.value==='https://www.omoi.com'))));
  assert.ok(dnr.some(row=>row.removeRuleIds?.length));
  let vizCalls=0;
  globalThis.fetch=async url=>{
    vizCalls++;
    if(vizCalls===1)throw Error('endpoint needs Referer');
    if(String(url).includes('/get_manga_url'))
      return new Response(JSON.stringify({data:{0:signed}}),{headers:{'Content-Type':'application/json'}});
    return new Response(data,{headers:{'Content-Type':'image/jpeg'}});
  };
  const vizFallback=await acquireImageDataUri('https://www.viz.com/manga/get_manga_url?chapter=2',
    'https://www.viz.com/read',null,{scope:'viz-referer-test'});
  assert.equal(vizCalls,3);
  assert.equal(Buffer.from(vizFallback.split(',')[1],'base64').compare(Buffer.from(data)),0);
  assert.ok(dnr.some(row=>row.addRules?.some(rule=>rule.action.requestHeaders.some(header=>
    header.header==='Origin'&&header.value==='https://www.viz.com'))));
  const deniedPage='https://omoi.com/chapter/2', denied='https://assets.omoi.com/p2.jpg?drm=1';
  globalThis.fetch=async()=>new Response(new Uint8Array(128),{headers:{'Content-Type':'image/jpeg'}});
  await assert.rejects(acquireImageDataUri(denied,deniedPage,null,{scope:'denied-test'}),
    /IMAGE_ACQUISITION_FAILED/);
  let domReply={ok:true,dataUri:'data:image/png;base64,aW1hZ2U='};
  let domCalls=0;
  globalThis.chrome.tabs={sendMessage(_id,_msg,_opts,cb){domCalls++;cb(domReply);}};
  const reader={src:denied,reader:{runId:'reader-verified',pageId:'4',adapter:'generic'},
    generation:{readerRunId:'reader-verified'},metadata:{},context:{}};
  await assert.rejects(acquireReaderImage(reader,{tabId:1,pageUrl:deniedPage}),
    /DOM_COMPOSITE_NOT_VERIFIED/);
  assert.equal(domCalls,1);
  domReply={...domReply,composition:'rendered_canvas'};
  assert.equal(await acquireReaderImage(reader,{tabId:1,pageUrl:deniedPage}),domReply.dataUri);
  console.log('site image adapters: Omoi, VIZ EXIF/endpoint, keyed MangaGo/K Manga, and plain image OK');
} finally {
  Object.assign(globalThis,{createImageBitmap:originals.bitmap,OffscreenCanvas:originals.canvas,
    fetch:originals.fetch,chrome:originals.chrome});
}
