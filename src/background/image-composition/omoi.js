// Omoi/Azuki page images advertise their one-byte XOR in the image URL.
// This adapter is opt-in to the exact page host and `drm` query parameter.
import { sniffImageMime } from '../image-composition.js';

export function omoiCandidate(url, pageUrl) {
  try {
    const page=new URL(pageUrl), image=new URL(url);
    return /^(?:www\.)?omoi\.com$/i.test(page.hostname) && /^https?:$/.test(image.protocol) &&
      image.searchParams.has('drm');
  } catch {return false;}
}

export async function decodeOmoi(blob,{signal=null,onResult=null}={}) {
  const source=new Uint8Array(await blob.arrayBuffer());
  signal?.throwIfAborted?.();
  // A signed URL can now serve an ordinary image. Do not XOR it twice.
  if(sniffImageMime(source))return blob;
  const output=new Uint8Array(source.length);
  for(let i=0;i<source.length;i++)output[i]=source[i]^174;
  const mime=sniffImageMime(output);
  if(!mime)throw Object.assign(new Error('Omoi DRM image did not decode to an image'),{code:'IMAGE_COMPOSE_DECODE_FAILED'});
  const prepared=new Blob([output],{type:mime});
  onResult?.('detected',{kind:'omoi-xor'});
  onResult?.('complete',{kind:'omoi-xor',bytes:prepared.size});
  return prepared;
}
