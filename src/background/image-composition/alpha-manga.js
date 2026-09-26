// Alpha Manga keys are stored on the viewer's placeholder; one record is
// attached to each source URL by the content collector, without extra fetches.
const fail=(code,message)=>Object.assign(new Error(message),{code});
export function alphaMangaKey(url,pageUrl) {
  try {
    const page=new URL(pageUrl),source=new URL(url);
    if(!/^(?:www\.)?alpha-manga\.com$/i.test(page.hostname)||!/^https?:$/.test(source.protocol))return null;
    const hex=source.hash.match(/^#key=([0-9a-f]{16,6400})$/i)?.[1];
    if(!hex||hex.length%16!==0)return null;
    const key=Uint8Array.from({length:hex.length/2},(_,i)=>parseInt(hex.slice(i*2,i*2+2),16));
    const view=new DataView(key.buffer);
    const tileSize=view.getUint32(4,true)>>>24;
    const bleed=(view.getUint32(0,true)>>>27)&7;
    return tileSize>2*bleed ? {key,tileSize,bleed} : null;
  }catch{return null;}
}
export async function decodeAlphaManga(blob,url,pageUrl,{signal=null,onResult=null}={}) {
  const meta=alphaMangaKey(url,pageUrl);
  if(!meta)return blob;
  if(typeof createImageBitmap!=='function'||typeof OffscreenCanvas!=='function')
    throw fail('IMAGE_COMPOSE_UNAVAILABLE','Alpha Manga tile composition requires a browser canvas');
  let bitmap,canvas;
  try {
    bitmap=await createImageBitmap(blob);
    signal?.throwIfAborted?.();
    const {width,height}=bitmap, {key,tileSize,bleed}=meta;
    const cols=Math.ceil(width/tileSize),rows=Math.ceil(height/tileSize),count=key.length/8;
    const outW=width-cols*2*bleed,outH=height-rows*2*bleed,inner=tileSize-2*bleed;
    if(!width||!height||width*height>80_000_000||count<1||count>400||
       count!==cols*rows||outW<1||outH<1||outW*outH>80_000_000)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','Alpha Manga tile metadata does not fit this image');
    canvas=new OffscreenCanvas(outW,outH);
    const ctx=canvas.getContext('2d');
    if(!ctx)throw fail('IMAGE_COMPOSE_UNAVAILABLE','Offscreen 2D canvas unavailable');
    ctx.imageSmoothingEnabled=false;
    const view=new DataView(key.buffer,key.byteOffset,key.byteLength);
    const occupied=new Set(),sources=new Set();
    const operations=[];
    for(let i=0;i<count;i++){
      const v=view.getUint32(i*8,true),ha=view.getUint32(i*8+4,true);
      const flip=v&1,rot=(v>>>1)&3,top=(v>>>3)&4095,left=(v>>>15)&4095;
      const srcRow=(ha>>>8)&255,srcCol=(ha>>>16)&255;
      if(left>=outW||top>=outH||
          left%inner!==0||top%inner!==0||srcCol>=cols||srcRow>=rows||
          occupied.has(`${left},${top}`)||sources.has(`${srcCol},${srcRow}`))
        throw fail('IMAGE_COMPOSE_METADATA_INVALID','Alpha Manga tile map is inconsistent');
      occupied.add(`${left},${top}`);sources.add(`${srcCol},${srcRow}`);
      const spanX=(Math.floor(left/inner)===cols-1?outW-left:inner)+2*bleed;
      const spanY=(Math.floor(top/inner)===rows-1?outH-top:inner)+2*bleed;
      const dw=rot%2?spanY:spanX,dh=rot%2?spanX:spanY;
      const sx=srcCol*tileSize,sy=srcRow*tileSize;
      const cropW=Math.min(dw,width-sx),cropH=Math.min(dh,height-sy);
      if(cropW<=0||cropH<=0)
        throw fail('IMAGE_COMPOSE_METADATA_INVALID','Alpha Manga tile crop is empty');
      operations.push({sx,sy,cropW,cropH,dx:left-bleed,dy:top-bleed,dw,dh,rot,flip});
    }
    onResult?.('detected',{kind:'alpha-manga-tiles',tiles:count});
    for(const {sx,sy,cropW,cropH,dx,dy,dw,dh,rot,flip} of operations){
      signal?.throwIfAborted?.();
      ctx.save();
      ctx.translate(dx+dw/2,dy+dh/2);
      if(rot)ctx.rotate(-Math.PI*rot/2);
      if(flip)ctx.scale(-1,1);
      ctx.drawImage(bitmap,sx,sy,cropW,cropH,-cropW/2,-cropH/2,cropW,cropH);
      ctx.restore();
    }
    const output=await canvas.convertToBlob({type:'image/png'});
    signal?.throwIfAborted?.();
    if(output.type!=='image/png'||output.size<64||output.size>25*1024*1024)
      throw fail('IMAGE_COMPOSE_ENCODE_FAILED','Alpha Manga image could not be encoded');
    onResult?.('complete',{kind:'alpha-manga-tiles',width:outW,height:outH,bytes:output.size});
    return output;
  }catch(error){
    if(error?.name==='AbortError'||error?.code)throw error;
    throw fail('IMAGE_COMPOSE_FAILED',error?.message||String(error));
  }finally{bitmap?.close?.();if(canvas)canvas.width=canvas.height=0;}
}
