// Inspect the same response used for OCR. An ordinary image with no recognized
// metadata leaves this module unchanged; one logical page always yields one
// prepared image. The known Comix query variant is chosen before fetching.
const COLS = 5, ROWS = 5, TILES = COLS * ROWS;
const fail = (code, reason) => Object.assign(new Error(reason), {code});
const h = (headers, name) => headers?.get?.(name) ?? null;

export function comixCandidate(url, pageUrl) {
  try {
    const page = new URL(pageUrl), image = new URL(url);
    return /^(?:www\.)?comix\.to$/i.test(page.hostname) && /^https?:$/.test(image.protocol) &&
      /^\/i5\/[^/]+$/i.test(image.pathname);
  } catch { return false; }
}

export function comixV3(url, pageUrl) {
  if (!comixCandidate(url, pageUrl)) return false;
  try { return [...new URL(url).searchParams.keys()].some(key => key.toLowerCase() === 'v3'); }
  catch { return false; }
}

export function imageRequestUrl(url, pageUrl, hint = 'unknown') {
  // A v3 query can change which bytes the CDN serves. Never add it to a page
  // without a verified page flag or a v3 query already present in its URL.
  if (!comixCandidate(url, pageUrl) || hint !== 'scrambled') return url;
  const image = new URL(url);
  if (![...image.searchParams.keys()].some(key => key.toLowerCase() === 'v3')) {
    image.search += (image.search ? '&' : '?') + 'v3';
  }
  return image.href;
}

const int32 = raw => {
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return null;
  try { return Number(BigInt(raw.trim()) & 0xffffffffn) | 0; } catch { return null; }
};
function hashCode(raw) {
  if (raw?.trim() === '03632') return 58414;
  if (raw?.trim() === '02900') return 117532;
  return 0;
}
export function tileOrder(seed, algo) {
  const permutation = Array.from({length:TILES}, (_, index) => index);
  let state = algo === '3' ? seed | 1 : seed | 0;
  for (let i = TILES - 1; i >= 1; --i) {
    if (algo === '3') {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state |= 0;
    } else state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const j = (state >>> 0) % (i + 1);
    [permutation[i], permutation[j]] = [permutation[j], permutation[i]];
  }
  const inverse = new Array(TILES);
  for (let i = 0; i < TILES; i++) inverse[permutation[i]] = i;
  return inverse;
}

function mimeFor(bytes) {
  if (bytes.length < 12) return '';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return 'image/webp';
  return '';
}
export const sniffImageMime = mimeFor;
function xorBytes(input, seed, length, algo) {
  const decode = (method, initial, highByte = false) => {
    const bytes = input.slice();
    let state = initial | 0;
    for (let i = 0, limit = Math.min(length, bytes.length); i < limit; i++) {
      if (method === 'xorshift') {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state |= 0;
        bytes[i] ^= highByte ? state >>> 24 : state & 255;
      } else {
        state = (Math.imul(state, 1000005) + 1234567891) | 0;
        bytes[i] ^= state >>> 24;
      }
    }
    return bytes;
  };
  if (algo !== '2') return decode('lcg',seed);
  const candidates = [decode('xorshift',seed|1),decode('xorshift',seed),
    decode('xorshift',seed|1,true),decode('lcg',seed)];
  return candidates.find(bytes => mimeFor(bytes)) ?? candidates[0];
}

export async function composeImageResponse(blob, headers, {signal = null, hint = 'unknown', onResult = null} = {}) {
  signal?.throwIfAborted?.();
  const grid = h(headers,'x-scramble-grid'), algo = h(headers,'x-scramble-algo');
  const rawSeed = h(headers,'x-scramble-seed');
  const encSeed = int32(h(headers,'x-enc-seed'));
  const rawEncLen = h(headers,'x-enc-len');
  const hasEncryption = encSeed !== null && encSeed !== 0;
  const incompleteEncryption = (encSeed === null && (h(headers,'x-enc-seed') !== null || rawEncLen !== null));
  if (incompleteEncryption) throw fail('IMAGE_COMPOSE_METADATA_MISSING','Image byte encryption headers are incomplete');
  if (!grid && !hasEncryption) {
    if (hint === 'scrambled') throw fail('IMAGE_COMPOSE_METADATA_MISSING','Expected a scrambled image, but the response has no scramble metadata');
    onResult?.('plain',{reason:'no_scramble_headers'});
    return blob;
  }
  if (grid && grid !== '5x5') throw fail('IMAGE_COMPOSE_GRID_UNSUPPORTED',`Unsupported image grid: ${grid}`);
  if (grid && ![null,'1','2','3'].includes(algo)) throw fail('IMAGE_COMPOSE_ALGO_UNSUPPORTED',`Unsupported tile algorithm: ${algo}`);
  if (grid && (int32(rawSeed) === null || int32(rawSeed) === 0))
    throw fail('IMAGE_COMPOSE_METADATA_MISSING','5x5 image response has no usable X-Scramble-Seed');
  if (hasEncryption && (rawEncLen === null || !/^\d+$/.test(rawEncLen) ||
      !Number.isSafeInteger(Number(rawEncLen))))
    throw fail('IMAGE_COMPOSE_METADATA_MISSING','Image byte encryption headers are incomplete');
  onResult?.('detected',{grid:grid || 'none',algo:algo || '1',encrypted:hasEncryption});
  let source = blob;
  if (hasEncryption && encSeed !== 0) {
    const original = new Uint8Array(await blob.arrayBuffer());
    signal?.throwIfAborted?.();
    const plain = xorBytes(original,encSeed,Number(rawEncLen),h(headers,'x-enc-algo'));
    const mime = mimeFor(plain);
    if (!mime) throw fail('IMAGE_COMPOSE_DECODE_FAILED','Decoded bytes do not contain a supported image');
    source = new Blob([plain],{type:mime});
  }
  if (!grid) {onResult?.('complete',{kind:'bytes',bytes:source.size});return source;}
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function')
    throw fail('IMAGE_COMPOSE_UNAVAILABLE','Image composition is unavailable in this browser worker');
  let bitmap, canvas;
  try {
    bitmap = await createImageBitmap(source);
    signal?.throwIfAborted?.();
    const {width, height} = bitmap;
    if (!width || !height || width * height > 80_000_000 || width < 5 || height < 5)
      throw fail('IMAGE_COMPOSE_SIZE_INVALID','Scrambled image dimensions are invalid');
    const tw=Math.floor(width/COLS), th=Math.floor(height/ROWS);
    canvas=new OffscreenCanvas(width,height);
    const context=canvas.getContext('2d');
    if (!context) throw fail('IMAGE_COMPOSE_UNAVAILABLE','Offscreen 2D canvas is unavailable');
    context.imageSmoothingEnabled=false;
    context.drawImage(bitmap,0,0,width,height);
    const seed=(int32(rawSeed) ^ hashCode(h(headers,'x-scramble-hash'))) | 0;
    const order=tileOrder(seed,algo);
    for (let dst=0;dst<TILES;dst++) {
      signal?.throwIfAborted?.();
      const src=order[dst];
      context.drawImage(bitmap,(src%COLS)*tw,Math.floor(src/COLS)*th,tw,th,
        (dst%COLS)*tw,Math.floor(dst/COLS)*th,tw,th);
    }
    const output=await canvas.convertToBlob({type:'image/png'});
    signal?.throwIfAborted?.();
    if (output.type !== 'image/png' || output.size < 64 || output.size > 25*1024*1024)
      throw fail('IMAGE_COMPOSE_ENCODE_FAILED','Composed image could not be encoded');
    onResult?.('complete',{kind:'tiles',width,height,bytes:output.size});
    return output;
  } catch(error) {
    if (error?.name === 'AbortError' || error?.code) throw error;
    throw fail('IMAGE_COMPOSE_FAILED',error?.message || String(error));
  } finally {
    bitmap?.close?.();
    if (canvas) canvas.width=canvas.height=0;
  }
}
