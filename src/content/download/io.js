// Saving reads existing image bytes. This file has no translation/erase imports.
(function () {
  'use strict';
  const TP=window.__TP;
  if (!TP || TP.bail || window.top!==window) return;
  const api=TP.downloads ||= {}, MAX_BYTES=25*1024*1024, MAX_PIXELS=48_000_000;
  const abortError=()=>new DOMException('Download cancelled','AbortError');
  const check=signal=>{if(signal?.aborted)throw abortError();};
  function limited(promise,signal,ms=20_000) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>done(new Error('Image read timed out')),ms);
      const abort=()=>done(abortError());
      function done(error,value){clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);}
      if(signal?.aborted){done(abortError());return;}
      signal?.addEventListener('abort',abort,{once:true});
      promise.then(value=>done(null,value),error=>done(error));
    });
  }
  async function responseBlob(response,signal) {
    if(!response.ok)throw new Error(`Image HTTP ${response.status}`);
    const mime=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!mime.startsWith('image/'))throw new Error('Source is not an image');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('Image exceeds 25 MB');
    const chunks=[],reader=response.body?.getReader();let size=0;
    if(!reader)throw new Error('Image stream unavailable');
    try {while(true){check(signal);const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;if(size>MAX_BYTES)throw new Error('Image exceeds 25 MB');chunks.push(part.value);}
    }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
    if(!size)throw new Error('Image is empty');
    return new Blob(chunks,{type:mime});
  }
  function workerImage(url,signal) {
    const requestId=crypto.randomUUID();
    return new Promise((resolve,reject)=>{
      let finished=false;
      const stop=()=>{try{chrome.runtime.sendMessage({type:'TP_DOWNLOAD_CANCEL_READ',requestId},()=>void chrome.runtime.lastError);}catch{}};
      const done=(err,value)=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);err?reject(err):resolve(value);};
      const abort=()=>{stop();done(abortError());};
      const timer=setTimeout(()=>{stop();done(new Error('Extension image read timed out'));},22_000);
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});
      try{chrome.runtime.sendMessage({type:'TP_DOWNLOAD_READ_SOURCE',requestId,url},async result=>{
        const err=chrome.runtime.lastError;
        if(finished)return;
        if(err || !result?.ok){done(new Error(result?.error || err?.message || 'Image source unavailable'));return;}
        try {
          if(typeof result.dataUri!=='string' || !/^data:image\//i.test(result.dataUri) || result.dataUri.length>MAX_BYTES*1.4)throw new Error('Invalid image response');
          const b=await (await fetch(result.dataUri,{signal})).blob();check(signal);done(null,b);
        }catch(e){done(e);}
      });}catch(e){done(e);}
    });
  }
  async function readImage(url,signal) {
    check(signal);
    const source=api.safeUrl(url);
    if(!source)throw new Error('Image source unavailable');
    // Blob/data URLs must stay in the owning document, not a remote API.
    const controller=new AbortController(), relay=()=>controller.abort();
    signal?.addEventListener('abort',relay,{once:true});
    const timer=setTimeout(()=>controller.abort(),15_000);
    try{
      return await responseBlob(await fetch(source,{signal:controller.signal,credentials:'include',cache:'force-cache'}),controller.signal);
    }catch(error){
      check(signal);
      if(!/^https?:/i.test(source))throw error;
      // Use extension host access only for a page image, without contacting the
      // TextPhantom API. Cancellation is scoped to this read and sender document.
      return await workerImage(source,signal);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
  }
  function safeTitle(title=document.title) {
    let stem=String(title || 'TextPhantom').replace(/[<>:"/\\|?*\u0000-\u001f]/g,' ').replace(/\s+/g,' ').replace(/[. ]+$/g,'').trim().slice(0,120) || 'TextPhantom';
    if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem))stem='_'+stem;
    return stem;
  }
  function filename(row,kind,ext,title=document.title) {
    return `${safeTitle(title)} - ${row.fileNumber} - ${kind}.${ext}`;
  }
  function archiveFilename(kind,title=document.title,partial=false){
    return `${safeTitle(title)} - ${kind}${partial?' - partial':''}.zip`;
  }
  const extension=mime=>({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/svg+xml':'svg','image/bmp':'bmp','image/apng':'apng','image/x-icon':'ico','image/vnd.microsoft.icon':'ico','image/tiff':'tiff'})[mime?.toLowerCase()] || 'img';
  async function render(row,kind,signal,options={}) {
    const format=options.format || 'auto', quality=typeof options.quality==='number' && Number.isFinite(options.quality)?Math.max(1,Math.min(100,options.quality))/100:.92;
    const mime=({png:'image/png',jpeg:'image/jpeg',webp:'image/webp'})[format];
    if(format!=='auto' && !mime)throw new Error('Unsupported image format');
    check(signal);api.assertCurrent(row);
    if(!row.available[kind])throw new Error('This image type is not available');
    const text=kind==='translated' && !row.rasterUrl;
    if(text){await limited(document.fonts?.ready || Promise.resolve(),signal,8_000);check(signal);api.assertCurrent(row);}
    const lines=text?api.captureLines(row.scope):null;
    if(text&&!lines.length)throw new Error('No visible translated text is available');
    const source=kind==='original'?row.original:kind==='clean'?row.cleanUrl:row.rasterUrl || row.cleanUrl || api.originalOf(row.img);
    const useCanvas=row.originalCanvas && (kind==='original' || text && !row.cleanUrl);
    if(useCanvas && (row.canvasWidth*row.canvasHeight>MAX_PIXELS || row.canvasWidth>32767 || row.canvasHeight>32767))
      throw new Error('Canvas is too large for a safe export');
    const blob=useCanvas ? await limited(new Promise((resolve,reject)=>{
      try{row.originalCanvas.toBlob(b=>b?resolve(b):reject(new Error('Original canvas export failed')),'image/png');}
      catch(e){reject(new Error('Original canvas is not readable: '+e.message));}
    }),signal) : await readImage(source,signal);
    check(signal);api.assertCurrent(row);
    if(!text && format==='auto')return {blob,ext:extension(blob.type)};
    const image=new Image(),url=URL.createObjectURL(blob);let canvas;
    try {
      image.src=url;
      await limited(image.decode(),signal);check(signal);api.assertCurrent(row);
      const W=image.naturalWidth,H=image.naturalHeight;
      if(!W || !H || W*H>MAX_PIXELS || W>32767 || H>32767)throw new Error('Image is too large for a safe canvas export');
      canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
      const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas is unavailable');
      if(mime==='image/jpeg'){ctx.fillStyle='#ffffff';ctx.fillRect(0,0,W,H);}
      ctx.drawImage(image,0,0,W,H);
      for(const line of lines || [])api.drawOverlayLine(ctx,line,W,H);
      const output=await limited(new Promise((resolve,reject)=>{
        try{canvas.toBlob(b=>b?resolve(b):reject(new Error('Canvas export failed')),mime || 'image/png',quality);}catch(e){reject(e);}
      }),signal);
      check(signal);api.assertCurrent(row);
      if(output.type!==(mime || 'image/png'))throw new Error('This browser cannot encode '+format.toUpperCase()+'; no replacement format was saved');
      return {blob:output,ext:extension(output.type)};
    }finally{URL.revokeObjectURL(url);image.src='';if(canvas){canvas.width=1;canvas.height=1;}}
  }
  function save(blob,name,signal) {
    check(signal);
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;a.style.display='none';
    document.documentElement.append(a);
    try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),10_000);}
    // This is a browser handoff, not an OS/disk completion acknowledgement.
  }
  Object.assign(api,{readImage,render,save,filename,archiveFilename});
})();
