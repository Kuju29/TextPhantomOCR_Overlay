import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {alphaMangaKey,decodeAlphaManga} from '../src/background/image-composition/alpha-manga.js';
import {mangaMiraiKey,decodeMangaMirai} from '../src/background/image-composition/manga-mirai.js';
import {kmangaKey} from '../src/background/image-composition/kmanga.js';
import {siteImageCandidate} from '../src/background/image-composition/site-adapters.js';
import {acquireImageDataUri} from '../src/background/image-acquisition.js';
import {normImgSrc} from '../src/background/job-keys.js';

const alphaPage='https://www.alpha-manga.com/manga/123?mode=vertical';
const miraiPage='https://mangamirai.com/manga/42';
const alphaImage='https://cdn.example.org/a.webp';
const miraiImage='https://cdn.example.org/series/abc/page.jpg';
const text=(path)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
const original={bitmap:globalThis.createImageBitmap,canvas:globalThis.OffscreenCanvas,
  fetch:globalThis.fetch,chrome:globalThis.chrome};
function makeKey(tiles,rotIndex=-1) {
  const output=new Uint8Array(tiles*8),view=new DataView(output.buffer);
  const destinations=[2,0,3,1];
  for(let i=0;i<tiles;i++){
    const dest=destinations[i],left=(dest%2)*10,top=Math.floor(dest/2)*10;
    const v=(1<<27)|(left<<15)|(top<<3)|((i===rotIndex?1:0)<<1);
    const ha=(12<<24)|((i%2)<<16)|(Math.floor(i/2)<<8);
    view.setUint32(i*8,v,true);view.setUint32(i*8+4,ha,true);
  }
  return output;
}
function vmContent(path,hostname,document) {
  const TP={bail:false,log:{info(){}}};
  vm.runInNewContext(text(path),{window:{__TP:TP},document,
    location:{hostname,href:`https://${hostname}/read/42`},URL,atob,Uint8Array,Set,Map,WeakSet});
  return TP;
}
class RasterCanvas {
  constructor(width,height){this.width=width;this.height=height;this.pixels=new Uint8Array(width*height);
    this.transform=[1,0,0,1,0,0];this.stack=[];}
  getContext(){return {
    imageSmoothingEnabled:false,
    save:()=>this.stack.push([...this.transform]),
    restore:()=>{this.transform=this.stack.pop();},
    translate:(x,y)=>this.multiply([1,0,0,1,x,y]),
    rotate:a=>this.multiply([Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0]),
    scale:(x,y)=>this.multiply([x,0,0,y,0,0]),
    drawImage:(img,sx,sy,sw,sh,dx,dy,dw,dh)=>{
      assert.equal(sw,dw);assert.equal(sh,dh);
      const [a,b,c,d,e,f]=this.transform;
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){
        const localX=dx+x+.5,localY=dy+y+.5;
        const targetX=Math.floor(a*localX+c*localY+e),targetY=Math.floor(b*localX+d*localY+f);
        if(targetX>=0&&targetX<this.width&&targetY>=0&&targetY<this.height)
          this.pixels[targetY*this.width+targetX]=img.pixels[(sy+y)*img.width+sx+x];
      }
    },
  };}
  multiply([u,v,w,z,p,q]) {
    const [a,b,c,d,e,f]=this.transform;
    this.transform=[a*u+c*v,b*u+d*v,a*w+c*z,b*w+d*z,a*p+c*q+e,b*p+d*q+f];
  }
  async convertToBlob(){return new Blob([this.pixels],{type:'image/png'});}
}
globalThis.OffscreenCanvas=RasterCanvas;
let sourceBitmap;
globalThis.createImageBitmap=async()=>({...sourceBitmap,close(){}});
try {
  const key=makeKey(4);
  const placeholder=new Uint8Array(33+2+key.length);
  placeholder.set([137,80,78,71,13,10,26,10],0);
  placeholder.set([73,72,68,82],12);
  placeholder[33]=4;placeholder.set(key,35);
  const viewer={getAttribute(name){return name==='v-bind:pages'?
    JSON.stringify(['first',alphaImage,'https://cdn.example.org/b.webp','last']):
    name==='placeholder'?'data:image/png;base64,'+Buffer.from(placeholder).toString('base64'):'';}};
  // Mismatched key/page counts must stay unkeyed. Supply two records below.
  assert.equal(vmContent('content/sites/alpha-manga/adapter.js','www.alpha-manga.com',
    {querySelector:()=>viewer}).alphaManga.keyedUrl(alphaImage),alphaImage);
  const keys=[makeKey(4),makeKey(4,1)];
  const packed=new Uint8Array(33+keys.reduce((n,item)=>n+2+item.length,0));
  packed.set(placeholder.subarray(0,33));
  let pos=33;for(const item of keys){packed[pos]=item.length/8;packed.set(item,pos+2);pos+=item.length+2;}
  const properViewer={getAttribute(name){return name==='v-bind:pages'?
    JSON.stringify(['first',alphaImage,'https://cdn.example.org/b.webp','last']):
    name==='placeholder'?'data:image/png;base64,'+Buffer.from(packed).toString('base64'):'';}};
  const alpha=vmContent('content/sites/alpha-manga/adapter.js','www.alpha-manga.com',
    {querySelector:()=>properViewer});
  const keyedAlpha=alpha.alphaManga.keyedUrl(alphaImage);
  assert.ok(keyedAlpha.startsWith(alphaImage+'#key='));
  const finder=text('content/image-finder.js');
  const clickSnippet=finder.slice(finder.indexOf('function setLastRightClick(img) {'),
    finder.indexOf('  document.addEventListener(',finder.indexOf('function setLastRightClick(img) {')));
  const rightClick=vm.runInNewContext(`(()=>{let lastRightClick=null;
    const rememberImgUrls=()=>{};${clickSnippet};return setLastRightClick})()`,
    {TP:{alphaManga:alpha.alphaManga,normUrl:raw=>raw,getBestImgUrl:img=>img.currentSrc},Date});
  const clicked={currentSrc:alphaImage,src:alphaImage,dataset:{}};
  rightClick(clicked);
  assert.equal(clicked.dataset.tpOriginal,keyedAlpha);
  // A mounted first page and an unmounted second page must both enter the
  // logical reader with keys before either image is sent to the worker.
  const alphaManifest={textContent:JSON.stringify({pages:[alphaImage,'https://cdn.example.org/b.webp']})};
  const alphaDocument={querySelectorAll:()=>[alphaManifest]};
  vm.runInNewContext(text('content/reader/sources.js'),{
    window:{__TP:alpha},document:alphaDocument,
    location:{hostname:'www.alpha-manga.com',href:alphaPage},URL,Map,Set,WeakSet,
  });
  const slots=new Map([['1',{}],['2',{}]]);
  const plan={ids:['1','2'],slots,root:{closest:()=>null},attr:'data-page'};
  const discovered=await alpha.readerSources(plan,slot=>slot===slots.get('1')?alphaImage:'',
    {document:alphaDocument,pageWorld:false});
  assert.equal(discovered.urls.get('1'),keyedAlpha);
  assert.ok(discovered.urls.get('2').startsWith('https://cdn.example.org/b.webp#key='));
  const runtime=text('content/reader/runtime.js');
  const checkSnippet=runtime.slice(runtime.indexOf('function validates(img, stamp) {'),
    runtime.indexOf('  function errorTarget(',runtime.indexOf('function validates(img, stamp) {')));
  const insertedImage={currentSrc:alphaImage,src:alphaImage,isConnected:true,
    matches:()=>false};
  const run={id:'owned',pageInstanceId:'same-page',sources:new Map([['1',keyedAlpha]]),
    results:new Map()};
  const validates=vm.runInNewContext(`(()=>{${checkSnippet};return validates})()`,{
    current:run,live:()=>true,target:()=>insertedImage,
    TP:{alphaManga:alpha.alphaManga,normUrl:raw=>raw},
  });
  assert.equal(validates(insertedImage,{readerRunId:'owned',pageInstanceId:'same-page',readerPageId:'1'}).ok,true);
  assert.equal(alphaMangaKey(keyedAlpha,alphaPage)?.tileSize,12);
  assert.equal(normImgSrc(keyedAlpha),keyedAlpha);
  assert.equal(siteImageCandidate(keyedAlpha,alphaPage),true);
  assert.equal(siteImageCandidate(alphaImage,'https://ordinary.test/read'),false);
  sourceBitmap={width:24,height:24,pixels:Uint8Array.from({length:24*24},(_,i)=>
    1+Math.floor(i/24/12)*2+Math.floor(i%24/12))};
  const input=new Blob([new Uint8Array(128).fill(2)],{type:'image/webp'});
  const alphaPixels=new Uint8Array(await (await decodeAlphaManga(input,keyedAlpha,alphaPage)).arrayBuffer());
  assert.equal(alphaPixels.length,400);
  assert.equal(alphaPixels[2+2*20],2); // source tile 1 moved to destination 0
  assert.equal(alphaPixels[12+12*20],3); // source tile 2 moved to destination 3
  assert.equal(await decodeAlphaManga(input,alphaImage,alphaPage),input);
  // The 90-degree path must run and output a complete page as well.
  const rotated=alpha.alphaManga.keyedUrl('https://cdn.example.org/b.webp');
  sourceBitmap.pixels=Uint8Array.from({length:24*24},(_,i)=>1+i);
  const rotatedPixels=new Uint8Array(await (await decodeAlphaManga(input,rotated,alphaPage)).arrayBuffer());
  assert.equal(rotatedPixels.length,400);
  assert.equal(rotatedPixels[10*20],37); // source (12,1) rotated to destination (0,10)

  const order=[1,0,3,2],key64=Buffer.from(JSON.stringify(order)).toString('base64');
  const script={id:'__NEXT_DATA__',textContent:JSON.stringify({props:{viewer:{records:[
    {url:miraiImage,scramble_key:key64}]}}})};
  const mirai=vmContent('content/sites/manga-mirai/adapter.js','mangamirai.com',
    {querySelectorAll:()=>[script]});
  const keyedMirai=mirai.mangaMirai.keyedUrl(miraiImage);
  assert.equal(keyedMirai,miraiImage+'#tp-mirai='+key64);
  assert.deepEqual(mangaMiraiKey(keyedMirai,miraiPage)?.order,order);
  assert.equal(normImgSrc(keyedMirai),keyedMirai);
  assert.equal(siteImageCandidate(miraiImage,miraiPage),false);
  const kPage='https://kmanga.kodansha.com/episode/22';
  const kImage='https://images.example.org/page.jpg';
  const kScript={id:'__NEXT_DATA__',textContent:JSON.stringify({viewer:{
    scramble_seed:'we7',title_id:100,episode_id:222,page_list:[kImage]}})};
  const kmanga=vmContent('content/sites/kmanga/adapter.js','kmanga.kodansha.com',
    {querySelectorAll:()=>[kScript]});
  const keyedK=kmanga.kManga.keyedUrl(kImage);
  assert.equal(keyedK,kImage+'#we7:100:222');
  assert.equal(kmangaKey(keyedK,kPage).length,16);
  assert.equal(kmanga.kManga.keyedUrl('https://images.example.org/other.jpg'),
    'https://images.example.org/other.jpg');
  sourceBitmap={width:192,height:192,pixels:Uint8Array.from({length:192*192},(_,i)=>
    Math.floor(i/192/96)*2+Math.floor(i%192/96)+1)};
  const jpeg=new Uint8Array(128).fill(5);jpeg.set([255,216,255,224]);
  const iv=new Uint8Array(16),material=new TextEncoder().encode('mangaabcmirai');
  const keyHash=await webcrypto.subtle.digest('SHA-256',material);
  const cipherKey=await webcrypto.subtle.importKey('raw',keyHash,'AES-CBC',false,['encrypt']);
  const encrypted=new Uint8Array(await webcrypto.subtle.encrypt({name:'AES-CBC',iv},cipherKey,jpeg));
  const body=new Uint8Array(16+encrypted.length);body.set(iv);body.set(encrypted,16);
  globalThis.fetch=async()=>new Response(body,{headers:{'Content-Type':'application/octet-stream'}});
  const uri=await acquireImageDataUri(keyedMirai,miraiPage,null,{scope:'mirai-aes-test'});
  assert.ok(uri.startsWith('data:image/png;base64,'));
  const pixels=Buffer.from(uri.split(',')[1],'base64');
  assert.equal(pixels.length,192*192);
  assert.equal(pixels[2+2*192],2);
  assert.equal(pixels[97+2*192],1);
  assert.strictEqual(await decodeMangaMirai(input,miraiImage,miraiPage),input);
  console.log('expanded adapters: Alpha Manga viewer + rotated tile, Manga Mirai key + AES-CBC + tiles, K Manga embedded seed, plain images OK');
} finally {Object.assign(globalThis,{createImageBitmap:original.bitmap,
  OffscreenCanvas:original.canvas,fetch:original.fetch,chrome:original.chrome});}
