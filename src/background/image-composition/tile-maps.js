// Common native-browser raster copy. Every map operates on one acquired image
// and yields one output; source and destination cells never share a canvas.
const fail=(code,message)=>Object.assign(new Error(message),{code});
export async function remapCells(blob,{cols,rows,order,geometry=null,kind,signal=null,onResult=null}) {
  if(!Number.isInteger(cols)||!Number.isInteger(rows)||cols<2||rows<2||cols*rows>400||
      order.length!==cols*rows||new Set(order).size!==order.length||
      order.some(n=>!Number.isInteger(n)||n<0||n>=order.length))
    throw fail('IMAGE_COMPOSE_METADATA_INVALID','Image cell permutation is invalid');
  if(typeof createImageBitmap!=='function'||typeof OffscreenCanvas!=='function')
    throw fail('IMAGE_COMPOSE_UNAVAILABLE','Image cell remapping requires browser canvas');
  let bitmap,canvas;
  try {
    bitmap=await createImageBitmap(blob);
    signal?.throwIfAborted?.();
    const {width,height}=bitmap;
    if(width<cols||height<rows||width*height>80_000_000)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','Image cell dimensions are invalid');
    const cw=geometry?.(width,height)?.[0]??Math.floor(width/cols);
    const ch=geometry?.(width,height)?.[1]??Math.floor(height/rows);
    if(!cw||!ch||cw*cols>width||ch*rows>height)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','Image cell geometry is invalid');
    canvas=new OffscreenCanvas(width,height);
    const ctx=canvas.getContext('2d');
    if(!ctx)throw fail('IMAGE_COMPOSE_UNAVAILABLE','Offscreen 2D canvas is unavailable');
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(bitmap,0,0,width,height);
    onResult?.('detected',{kind,cols,rows});
    for(let dst=0;dst<order.length;dst++){
      signal?.throwIfAborted?.();
      const src=order[dst];
      ctx.drawImage(bitmap,(src%cols)*cw,Math.floor(src/cols)*ch,cw,ch,
        (dst%cols)*cw,Math.floor(dst/cols)*ch,cw,ch);
    }
    const output=await canvas.convertToBlob({type:'image/png'});
    signal?.throwIfAborted?.();
    if(output.type!=='image/png'||output.size<64||output.size>25*1024*1024)
      throw fail('IMAGE_COMPOSE_ENCODE_FAILED','Reassembled image could not be encoded');
    onResult?.('complete',{kind,width,height,bytes:output.size});
    return output;
  }catch(error){
    if(error?.name==='AbortError'||error?.code)throw error;
    throw fail('IMAGE_COMPOSE_FAILED',error?.message||String(error));
  }finally{bitmap?.close?.();if(canvas)canvas.width=canvas.height=0;}
}
