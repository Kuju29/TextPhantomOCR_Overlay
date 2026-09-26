// VIZ's signed JPEG embeds its cell permutation in EXIF ImageUniqueID.
// The image bytes themselves, rather than guessed seams, select this adapter.
const fail=(code,message)=>Object.assign(new Error(message),{code});
export function vizPage(pageUrl) {
  try {return /^(?:www\.)?viz\.com$/i.test(new URL(pageUrl).hostname);}
  catch{return false;}
}
export function vizEndpoint(url,pageUrl) {
  try {
    const source=new URL(url);
    return vizPage(pageUrl) && source.protocol==='https:' &&
      /^(?:www\.)?viz\.com$/i.test(source.hostname) &&
      source.pathname==='/manga/get_manga_url';
  } catch{return false;}
}
export async function vizSignedUrl(response) {
  if(!response.ok)throw fail('IMG_SOURCE_UNREACHABLE',`HTTP ${response.status}`);
  const type=String(response.headers.get('content-type')||'').toLowerCase();
  if(type&&!type.includes('json'))throw fail('IMAGE_COMPOSE_METADATA_MISSING','VIZ page URL did not return JSON');
  const body=await response.text();
  if(body.length>8192)throw fail('IMAGE_COMPOSE_METADATA_INVALID','VIZ image URL response is too large');
  let data;
  try {data=JSON.parse(body)?.data;} catch {}
  const value=data&&typeof data==='object'&&!Array.isArray(data)
    ? Object.values(data).find(item=>typeof item==='string') : null;
  if(!value||value.length>8192)throw fail('IMAGE_COMPOSE_METADATA_MISSING','VIZ did not return a signed image URL');
  let signed;
  try {signed=new URL(value);}catch{}
  if(!signed||signed.protocol!=='https:'||signed.username||signed.password||signed.port||
      /^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(signed.hostname))
    throw fail('IMAGE_COMPOSE_METADATA_INVALID','VIZ returned an invalid image URL');
  return signed.href;
}

export function vizExif(bytes) {
  if(bytes.length<16||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
  for(let offset=2;offset+12<bytes.length;){
    if(bytes[offset]!==0xff)break;
    const marker=bytes[offset+1];
    if(marker===0xda||marker===0xd9)break;
    if((marker>=0xd0&&marker<=0xd7)||marker===0x01){offset+=2;continue;}
    const length=(bytes[offset+2]<<8)|bytes[offset+3], start=offset+4;
    if(length<2||offset+2+length>bytes.length)break;
    offset+=2+length;
    if(marker!==0xe1||length<16||String.fromCharCode(...bytes.subarray(start,start+6))!=='Exif\0\0')continue;
    const base=start+6, end=start+length-2;
    if(end>bytes.length||base+8>end)continue;
    const little=bytes[base]===0x49&&bytes[base+1]===0x49;
    if(!little && !(bytes[base]===0x4d&&bytes[base+1]===0x4d))continue;
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const within=(at,size)=>at>=base&&at+size<=end;
    const u16=(at)=>within(at,2)?view.getUint16(at,little):null;
    const u32=(at)=>within(at,4)?view.getUint32(at,little):null;
    if(u16(base+2)!==42)continue;
    const ifd=(relative)=>{
      if(!Number.isSafeInteger(relative))return null;
      const at=base+relative, count=u16(at);
      if(count===null||count>256||!within(at+2,count*12+4))return null;
      const tags=new Map();
      for(let i=0;i<count;i++)tags.set(u16(at+2+i*12),at+2+i*12);
      return tags;
    };
    const number=(entry)=>{
      if(entry===undefined||u32(entry+4)!==1)return null;
      const type=u16(entry+2);
      return type===3?u16(entry+8):type===4?u32(entry+8):null;
    };
    const root=ifd(u32(base+4));
    const exif=ifd(number(root?.get(0x8769)));
    const unique=exif?.get(0xa420);
    if(unique===undefined||u16(unique+2)!==2)return null;
    const size=u32(unique+4);
    if(!size||size>1024)return null;
    const at=size<=4?unique+8:base+u32(unique+8);
    if(!within(at,size))return null;
    const value=new TextDecoder('ascii').decode(bytes.subarray(at,at+size)).replace(/\0.*$/s,'');
    const hex=value.split(':');
    if(hex.length!==104||hex.some(item=>!/^[0-9a-f]{1,2}$/i.test(item)))return null;
    const key=hex.map(item=>parseInt(item,16));
    if(new Set(key).size!==104||key.some(item=>item<0||item>=104))return null;
    const width=number(exif.get(0xa002))||800, height=number(exif.get(0xa003))||1200;
    if(width<10||height<15||width>20_000||height>20_000)return null;
    return {width,height,key};
  }
  return null;
}

export async function decodeViz(blob,{signal=null,onResult=null}={}) {
  const head=new Uint8Array(await blob.slice(0,65536).arrayBuffer());
  signal?.throwIfAborted?.();
  const meta=vizExif(head);
  if(!meta)return blob;
  if(typeof OffscreenCanvas!=='function'||typeof createImageBitmap!=='function')
    throw fail('IMAGE_COMPOSE_UNAVAILABLE','VIZ EXIF composition requires canvas in the browser worker');
  let bitmap,canvas;
  try {
    bitmap=await createImageBitmap(blob);
    signal?.throwIfAborted?.();
    const width=bitmap.width,height=bitmap.height;
    const outW=Math.max(width-90,meta.width),outH=Math.max(height-140,meta.height);
    if(width<100||height<150||outW>width||outH>height||outW*outH>80_000_000)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','VIZ EXIF image dimensions are inconsistent');
    const cw=Math.floor(outW/10),ch=Math.floor(outH/15);
    if(!cw||!ch)throw fail('IMAGE_COMPOSE_SIZE_INVALID','VIZ cell dimensions are invalid');
    canvas=new OffscreenCanvas(outW,outH);
    const ctx=canvas.getContext('2d');
    if(!ctx)throw fail('IMAGE_COMPOSE_UNAVAILABLE','Offscreen 2D canvas is unavailable');
    ctx.imageSmoothingEnabled=false;
    const blit=(sx,sy,dx,dy,w,h)=>{
      const bw=Math.min(w,width-sx,outW-dx),bh=Math.min(h,height-sy,outH-dy);
      if(sx<0||sy<0||dx<0||dy<0||bw<=0||bh<=0)return;
      ctx.drawImage(bitmap,sx,sy,bw,bh,dx,dy,bw,bh);
    };
    onResult?.('detected',{kind:'viz-exif',cells:104});
    blit(0,0,0,0,outW,ch);
    blit(0,ch+10,0,ch,cw,outH-2*ch);
    blit(0,14*(ch+10),0,14*ch,outW,height-14*(ch+10));
    blit(9*(cw+10),ch+10,9*cw,ch,cw+(outW-10*cw),outH-2*ch);
    for(let m=0;m<104;m++){
      signal?.throwIfAborted?.();
      const to=meta.key[m];
      blit(((m%8)+1)*(cw+10),(Math.floor(m/8)+1)*(ch+10),
        ((to%8)+1)*cw,(Math.floor(to/8)+1)*ch,cw,ch);
    }
    const result=await canvas.convertToBlob({type:'image/png'});
    signal?.throwIfAborted?.();
    if(result.type!=='image/png'||result.size<64||result.size>25*1024*1024)
      throw fail('IMAGE_COMPOSE_ENCODE_FAILED','VIZ image could not be encoded');
    onResult?.('complete',{kind:'viz-exif',width:outW,height:outH,bytes:result.size});
    return result;
  }catch(error){
    if(error?.name==='AbortError'||error?.code)throw error;
    throw fail('IMAGE_COMPOSE_FAILED',error?.message||String(error));
  }finally{bitmap?.close?.();if(canvas)canvas.width=canvas.height=0;}
}
