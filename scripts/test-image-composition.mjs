import assert from 'node:assert/strict';
import {comixCandidate, imageRequestUrl, tileOrder, composeImageResponse} from '../src/background/image-composition.js';

const url='https://ek10.wowpic1.store/i5/bEqPbYfoMT0GmynlKgafoD5A4rkNav6i3R0VvpbI6y4EiS5FIHyEz7PI11FmpSw?8';
const site='https://comix.to/title/chapter';
assert.equal(comixCandidate(url,site),true);
assert.equal(comixCandidate(url,'https://unrelated.example/'),false);
assert.equal(imageRequestUrl(url,site),url);
assert.equal(imageRequestUrl(url,site,'scrambled'),'https://ek10.wowpic1.store/i5/bEqPbYfoMT0GmynlKgafoD5A4rkNav6i3R0VvpbI6y4EiS5FIHyEz7PI11FmpSw?8&v3');
assert.equal(imageRequestUrl(url,site,'plain'),url);
assert.equal(imageRequestUrl(url+'&v3',site),url+'&v3');
assert.equal(imageRequestUrl('https://example.test/a.webp',site),'https://example.test/a.webp');

const order=[22,8,12,6,9,0,15,10,1,3,18,11,17,20,23,16,24,5,14,19,4,2,21,13,7];
assert.deepEqual(tileOrder((4228536156 ^ 117532)|0,'3'),order);
const plain=new Blob([new Uint8Array(100).fill(0x89)],{type:'image/webp'});
assert.equal(await composeImageResponse(plain,new Headers()),plain);
await assert.rejects(composeImageResponse(plain,new Headers(),{hint:'scrambled'}),
  error=>error.code==='IMAGE_COMPOSE_METADATA_MISSING');
await assert.rejects(composeImageResponse(plain,new Headers({'x-scramble-grid':'5x5'})),
  error=>error.code==='IMAGE_COMPOSE_METADATA_MISSING');
await assert.rejects(composeImageResponse(plain,new Headers({'x-scramble-grid':'3x3'})),
  error=>error.code==='IMAGE_COMPOSE_GRID_UNSUPPORTED');

// A small 5x5 bitmap with a unique value in every tile exercises all crop
// and destination coordinates, including the one-image, one-result contract.
const bitmap={width:10,height:10,pixels:new Uint8Array(100),close(){this.closed=true;}};
for(let y=0;y<10;y++)for(let x=0;x<10;x++)bitmap.pixels[y*10+x]=Math.floor(y/2)*5+Math.floor(x/2);
const previousBitmap=globalThis.createImageBitmap,previousCanvas=globalThis.OffscreenCanvas;
globalThis.createImageBitmap=async()=>bitmap;
globalThis.OffscreenCanvas=class{
  constructor(w,h){this.width=w;this.height=h;this.pixels=new Uint8Array(w*h);}
  getContext(){return {drawImage:(_bitmap,...args)=>{
    const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length===4?
      [0,0,bitmap.width,bitmap.height,...args]:args;
    assert.equal(sw,dw);assert.equal(sh,dh);
    for(let y=0;y<sh;y++)for(let x=0;x<sw;x++)
      this.pixels[(dy+y)*this.width+dx+x]=bitmap.pixels[(sy+y)*bitmap.width+sx+x];
  }};}
  async convertToBlob(){return new Blob([this.pixels],{type:'image/png'});}
};
try{
  const events=[];
  const rendered=await composeImageResponse(plain,new Headers({
    'x-scramble-grid':'5x5','x-scramble-seed':'4228536156',
    'x-scramble-algo':'3','x-scramble-hash':'02900',
  }),{hint:'scrambled',onResult:(name,detail)=>events.push([name,detail])});
  const pixels=new Uint8Array(await rendered.arrayBuffer());
  assert.equal(rendered.type,'image/png');
  assert.equal(pixels.length,100);
  for(let y=0;y<10;y++)for(let x=0;x<10;x++)
    assert.equal(pixels[y*10+x],order[Math.floor(y/2)*5+Math.floor(x/2)]);
  assert.equal(bitmap.closed,true);
  assert.deepEqual(events.map(([name])=>name),['detected','complete']);
} finally {globalThis.createImageBitmap=previousBitmap;globalThis.OffscreenCanvas=previousCanvas;}

// Byte-XOR-only pages do not touch the canvas and should be returned as image
// bytes; an unrelated unmarked image remains byte-for-byte identical.
const jpeg=new Uint8Array(100);jpeg.set([0xff,0xd8,0xff,0xe0]);
const encrypted=jpeg.slice();let state=12345;
for(let i=0;i<24;i++){state=(Math.imul(state,1000005)+1234567891)|0;encrypted[i]^=state>>>24;}
const decoded=await composeImageResponse(new Blob([encrypted]),new Headers({
  'x-enc-seed':'12345','x-enc-len':'24','x-enc-algo':'1',
}));
assert.equal(decoded.type,'image/jpeg');
assert.deepEqual(new Uint8Array(await decoded.arrayBuffer()),jpeg);
console.log('image composition: real-page tile seed, all 25 destinations, byte XOR, ordinary image and invalid-header guards OK');
