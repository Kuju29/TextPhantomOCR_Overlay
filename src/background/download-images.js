// Export-only image byte broker. No API-server calls or translation state.
// The existing host permission is used, never a new permission or erasing route.
const reads=new Map(), MAX_BYTES=25*1024*1024;
function identity(sender) {
  if(sender?.id!==globalThis.chrome?.runtime?.id || !Number.isInteger(sender?.tab?.id))return '';
  return `${sender.tab.id}:${sender.frameId||0}:${sender.documentId||sender.url||''}`;
}
function requestKey(message,sender) {
  const id=String(message?.requestId||'');
  const scope=identity(sender);
  return scope && /^[a-zA-Z0-9-]{1,80}$/.test(id)?`${scope}:${id}`:'';
}
export function cancelDownloadRead(message,sender) {
  const key=requestKey(message,sender);if(key)reads.get(key)?.controller.abort();
  return {ok:!!key};
}
export function cancelTabDownloadReads(tabId) {
  for(const entry of reads.values())if(entry.tabId===tabId)entry.controller.abort();
}
export async function readDownloadImage(message,sender) {
  const key=requestKey(message,sender),scope=identity(sender);
  if(!key)return {ok:false,error:'Invalid download source request'};
  let url;
  try{url=new URL(message.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}
  catch{return {ok:false,error:'Only HTTP image sources may use extension host access'};}
  if(reads.has(key)||[...reads.values()].some(r=>r.scope===scope)||reads.size>=32)
    return {ok:false,error:'An image read is already running; try again after it completes'};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20_000);
  reads.set(key,{controller,scope,tabId:sender.tab.id});
  try{
    // Extension-origin fetch cannot assign an arbitrary publisher Referrer.
    // Sites requiring a custom hotlink header remain explicit failures.
    const response=await fetch(url.href,{signal:controller.signal,cache:'force-cache',credentials:'include',redirect:'follow'});
    if(!response.ok)throw new Error(`Image HTTP ${response.status}`);
    const type=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!/^image\/[a-z0-9.+-]+$/.test(type))throw new Error('Source is not an image');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('Image exceeds 25 MB');
    const reader=response.body?.getReader();if(!reader)throw new Error('Image stream unavailable');
    const chunks=[];let count=0;
    try{while(true){const part=await reader.read();if(part.done)break;count+=part.value.byteLength;
      if(count>MAX_BYTES)throw new Error('Image exceeds 25 MB');chunks.push(part.value);}}
    finally{try{await reader.cancel();}catch{}reader.releaseLock();}
    if(!count)throw new Error('Image is empty');
    if(controller.signal.aborted)throw new Error('Download read cancelled');
    // Encode at byte boundaries; building one string before btoa avoids padding
    // corruption when network chunk lengths are not multiples of three.
    let binary='';for(const part of chunks)for(let i=0;i<part.length;i+=0x8000)binary+=String.fromCharCode(...part.subarray(i,i+0x8000));
    return {ok:true,dataUri:`data:${type};base64,${btoa(binary)}`};
  }catch(e){return {ok:false,error:controller.signal.aborted?'Download image read cancelled or timed out':String(e?.message||e)};}
  finally{clearTimeout(timer);reads.delete(key);}
}
