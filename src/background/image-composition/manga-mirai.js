// Manga Mirai: a chapter response supplies the page's scramble_key. The
// served image is AES-CBC encrypted with a key derived from its contents id,
// then shuffled in 96px blocks. No extra key/API requests occur here.
import { sniffImageMime } from '../image-composition.js';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const hexHost=/^(?:www\.)?mangamirai\.com$/i;
export function mangaMiraiKey(url,pageUrl) {
  try {
    if(!hexHost.test(new URL(pageUrl).hostname))return null;
    const source=new URL(url);
    if(!/^https?:$/.test(source.protocol))return null;
    let raw=source.hash.slice(1);
    if(raw.startsWith('tp-mirai='))raw=raw.slice(9);
    if(!raw||raw.length>4096||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))return null;
    const decoded=atob(raw),values=decoded.match(/\d+/g);
    if(!values||values.length<2||values.length>400)return null;
    const order=values.map(Number);
    if(order.some(n=>!Number.isInteger(n)||n<0||n>=order.length)||
       new Set(order).size!==order.length)return null;
    const segments=source.pathname.split('/').filter(Boolean);
    if(segments.length<2||segments[1].length>128)return null;
    return {order,contentsId:segments[1]};
  }catch{return null;}
}
export async function decodeMangaMirai(blob,url,pageUrl,{signal=null,onResult=null}={}) {
  const meta=mangaMiraiKey(url,pageUrl);
  if(!meta)return blob;
  if(typeof createImageBitmap!=='function'||typeof OffscreenCanvas!=='function'||!globalThis.crypto?.subtle)
    throw fail('IMAGE_COMPOSE_UNAVAILABLE','Manga Mirai AES or browser canvas unavailable');
  let bitmap,canvas;
  try {
    const source=new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted?.();
    let plain;
    if(sniffImageMime(source))plain=source;
    else {
      if(source.length<48||(source.length-16)%16!==0)
        throw fail('IMAGE_COMPOSE_DECODE_FAILED','Manga Mirai AES image length invalid');
      const material=new TextEncoder().encode(`manga${meta.contentsId}mirai`);
      const keyHash=await crypto.subtle.digest('SHA-256',material);
      const key=await crypto.subtle.importKey('raw',keyHash,'AES-CBC',false,['decrypt']);
      plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv:source.slice(0,16)},
        key,source.slice(16)));
    }
    signal?.throwIfAborted?.();
    const mime=sniffImageMime(plain);
    if(!mime)throw fail('IMAGE_COMPOSE_DECODE_FAILED','Manga Mirai decrypted bytes are not an image');
    bitmap=await createImageBitmap(new Blob([plain],{type:mime}));
    const {width,height}=bitmap,cols=Math.ceil(width/96),rows=Math.ceil(height/96);
    if(!width||!height||width*height>80_000_000||meta.order.length!==cols*rows)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','Manga Mirai tile key does not fit the image');
    canvas=new OffscreenCanvas(width,height);
    const ctx=canvas.getContext('2d');
    if(!ctx)throw fail('IMAGE_COMPOSE_UNAVAILABLE','Offscreen 2D canvas unavailable');
    ctx.imageSmoothingEnabled=false;
    onResult?.('detected',{kind:'manga-mirai-aes-tiles',tiles:meta.order.length});
    for(let dst=0;dst<meta.order.length;dst++){
      signal?.throwIfAborted?.();
      const src=meta.order[dst],sx=(src%cols)*96,sy=Math.floor(src/cols)*96;
      const dx=(dst%cols)*96,dy=Math.floor(dst/cols)*96;
      const cw=Math.min(96,width-sx,width-dx),ch=Math.min(96,height-sy,height-dy);
      if(cw<=0||ch<=0)throw fail('IMAGE_COMPOSE_SIZE_INVALID','Manga Mirai tile crop invalid');
      ctx.drawImage(bitmap,sx,sy,cw,ch,dx,dy,cw,ch);
    }
    const output=await canvas.convertToBlob({type:'image/png'});
    signal?.throwIfAborted?.();
    if(output.type!=='image/png'||output.size<64||output.size>25*1024*1024)
      throw fail('IMAGE_COMPOSE_ENCODE_FAILED','Manga Mirai image could not be encoded');
    onResult?.('complete',{kind:'manga-mirai-aes-tiles',width,height,bytes:output.size});
    return output;
  }catch(error){
    if(error?.name==='AbortError'||error?.code)throw error;
    throw fail('IMAGE_COMPOSE_FAILED',error?.message||String(error));
  }finally{bitmap?.close?.();if(canvas)canvas.width=canvas.height=0;}
}
