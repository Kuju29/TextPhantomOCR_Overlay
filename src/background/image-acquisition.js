// Shared browser acquisition: NORMAL = legacy DEFAULT + exact-URL REFERER.
// Dynamic readers supply DOM as a final fallback; no content probe for NORMAL.
import { fetchImageDataUriFromUrl, blobToDataUri } from './images.js';
import { note as traceNote } from '../shared/trace.js';
import { createLogger } from '../shared/logger.js';
const log = createLogger('SW.imageAcquisition');
const policies = new Map(), refererOwners = new Map();
const RULE_START = 19000000, RULE_END = 19999999;
let nextRule = RULE_START, cleanup;
const abortError = () => new DOMException('Reader acquisition cancelled', 'AbortError');
const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function dnrCall(method, arg) {
  return new Promise((resolve,reject) => {
    const api=chrome.declarativeNetRequest;
    if (!api?.[method]) return reject(new Error('REFERER_UNAVAILABLE'));
    try { api[method](...(arg === undefined ? [] : [arg]), value => {
      const error=chrome.runtime.lastError;error ? reject(new Error(error.message)) : resolve(value);
    }); } catch(error) { reject(error); }
  });
}
// Session rules survive a service-worker restart, unlike our pending fetches.
function clearOrphanRules() {
  return cleanup ||= dnrCall('getSessionRules').then(rules => {
    const ids=rules.filter(r=>r.id>=RULE_START&&r.id<=RULE_END).map(r=>r.id);
    return ids.length ? dnrCall('updateSessionRules',{removeRuleIds:ids}) : undefined;
  }).catch(error=>{cleanup=null;throw error;});
}
export function forgetImageAcquisition(scope) { policies.delete(String(scope)); }
async function bounded(work, signal, ms=14000) {
  if(signal?.aborted)throw abortError();
  const controller=new AbortController(), aborted=()=>controller.abort();
  signal?.addEventListener('abort',aborted,{once:true});
  const timer=ms>0 ? setTimeout(aborted,ms) : 0;
  try {
    return await new Promise((resolve,reject)=>{
      const stop=()=>reject(signal?.aborted ? abortError() : new Error('IMAGE_ACQUISITION_TIMEOUT'));
      controller.signal.addEventListener('abort',stop,{once:true});
      Promise.resolve().then(()=>work(controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));
    });
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',aborted);}
}
async function refererFetch(url,pageUrl,signal) {
  const ref=new URL(pageUrl), source=new URL(url);source.hash='';
  if(!/^https?:$/.test(ref.protocol)||!/^https?:$/.test(source.protocol))throw new Error('REFERER_HTTP_ONLY');
  // Requests for the same URL share a rule scope. Serialize only this fallback,
  // not different images, readers, OCR lanes or AI requests.
  const previous=refererOwners.get(url)||Promise.resolve();
  let unlock; const owned=new Promise(resolve=>{unlock=resolve;});
  refererOwners.set(url,owned);
  try {
    await previous;
    if(signal?.aborted)throw abortError();
    await clearOrphanRules();
    if(signal?.aborted)throw abortError();
    const id=nextRule++;if(nextRule>RULE_END)nextRule=RULE_START;
    ref.username=ref.password='';ref.hash='';
    const rule={id,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:ref.href}]},
      condition:{regexFilter:`^${esc(source.href)}$`,isUrlFilterCaseSensitive:true,
        initiatorDomains:[new URL(chrome.runtime.getURL('')).hostname],resourceTypes:['xmlhttprequest']}};
    await dnrCall('updateSessionRules',{addRules:[rule]});
    try {
      if(signal?.aborted)throw abortError();
      const response=await fetch(source.href,{credentials:'include',cache:'no-store',signal});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const mime=String(response.headers.get('content-type')||'').split(';')[0];
      if(mime&&!mime.toLowerCase().startsWith('image/'))throw new Error(`Not an image: ${mime}`);
      const blob=await response.blob();
      if(blob.size<64||blob.size>25*1024*1024)throw new Error('REFERER_IMAGE_SIZE_INVALID');
      return blobToDataUri(blob,mime||blob.type);
    } finally {await dnrCall('updateSessionRules',{removeRuleIds:[id]}).catch(error=>log.warn('referer rule cleanup failed',{id,error:error.message}));}
  } finally {unlock();if(refererOwners.get(url)===owned)refererOwners.delete(url);}
}

// Each admitted image fetches independently. Remember successful routes, but do
// not make a whole chapter await a slow first image or add a probe request.
export async function acquireImageDataUri(url, pageUrl = '', signal = null, {
  scope = `page:${pageUrl}`, domFetch = null, timeoutMs = 0, traceId = '', pageId = '', onRoute = null,
} = {}) {
  const report=(phase, detail)=>{try{onRoute?.(phase,detail);}catch{}};
  if (signal?.aborted) throw abortError();
  if (!String(url || '').trim()) return '';
  const source = new URL(url);
  // Blob/file/data acquisition keeps its existing ownership-specific path.
  if (!/^https?:$/.test(source.protocol)) {
    const startedAt=Date.now();
    report('start',{route:'WORKER_NON_HTTP',protocol:source.protocol,domFallbackAvailable:false});
    try {
      const dataUri=await fetchImageDataUriFromUrl(url, pageUrl, signal);
      report('success',{route:'WORKER_NON_HTTP',elapsedMs:Date.now()-startedAt,encodedChars:dataUri.length});
      return dataUri;
    } catch(error) {
      report('failed',{route:'WORKER_NON_HTTP',elapsedMs:Date.now()-startedAt,
        code:error?.code || error?.name || 'FETCH_FAILED',reason:error?.message || String(error)});
      throw error;
    }
  }
  const host = source.origin;
  let policy = policies.get(scope);
  if (!policy) {
    // Bounded strategy metadata only, no source bytes or credentials.
    if (policies.size >= 128) policies.delete(policies.keys().next().value);
    policy = new Map(); policies.set(scope, policy);
  }
  let entry = policy.get(host);
  if (!entry) { entry = { preferred: '' }; policy.set(host, entry); }
  if (signal?.aborted) throw abortError();
  const available = domFetch ? ['DEFAULT', 'REFERER', 'DOM'] : ['DEFAULT', 'REFERER'];
  const preferred = available.includes(entry.preferred) ? entry.preferred : '';
  const order = [...new Set([preferred, ...available].filter(Boolean))];
  const failures = [];
  try {
    for (const route of order) {
      if (signal?.aborted) throw abortError();
      const startedAt = Date.now();
      report('start',{route,preferred:preferred || 'none',previousFailures:failures.length});
      try {
        const dataUri = await bounded(ownedSignal => {
          if (route === 'DEFAULT') return fetchImageDataUriFromUrl(url, pageUrl, ownedSignal);
          if (route === 'REFERER') return refererFetch(url, pageUrl, ownedSignal);
          return domFetch(ownedSignal);
        }, signal, timeoutMs);
        if (signal?.aborted) throw abortError();
        // Legacy DEFAULT accepts an absent Content-Type and leaves actual image
        // decoding to Lens. Keep that behavior when sharing the route with NORMAL.
        const valid = route === 'DOM' ? /^data:image\//i : /^data:(?:image\/|application\/octet-stream;)/i;
        if (!valid.test(String(dataUri || ''))) throw new Error('IMAGE_ACQUISITION_INVALID');
        entry.preferred = route;
        report('success',{route,elapsedMs:Date.now()-startedAt,encodedChars:String(dataUri).length,
          previousFailures:failures.length});
        traceNote('background/image-acquisition.js', `imageAcquisition_${route}_success`, {
          schema:'tp.audit/1',event:'route_capability',reason:'success',
          scope:{runId:scope,pageId:`p${pageId || 0}`},
          timing:{readMs:Date.now()-startedAt},counts:{fallbackCount:failures.length},
        }, traceId);
        if (failures.length || preferred !== route)
          log.info('image acquisition selected', { scope, route, host, fallbacks: failures });
        return dataUri;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        report('failed',{route,elapsedMs:Date.now()-startedAt,
          code:error?.code || error?.name || 'FETCH_FAILED',reason:error?.message || String(error)});
        failures.push({ route, reason: error.message });
        traceNote('background/image-acquisition.js', `imageAcquisition_${route}_fallback`, {
          schema:'tp.audit/1',event:'route_capability',reason:'failed',
          scope:{runId:scope,pageId:`p${pageId || 0}`},timing:{readMs:Date.now()-startedAt},
        }, traceId);
      }
    }
    entry.preferred = '';
    const error=new Error(`${domFetch ? 'READER' : 'IMAGE'}_ACQUISITION_FAILED: ${failures.map(f => `${f.route}: ${f.reason}`).join('; ')}`);
    error.code='IMG_READ_FAILED';
    throw error;
  } catch (error) {
    throw error;
  }
}

export function fetchImageDataUriWithReferer(url, pageUrl = '', signal = null, options = {}) {
  return acquireImageDataUri(url, pageUrl, signal, options);
}
