// Shared browser acquisition: NORMAL = legacy DEFAULT + exact-URL REFERER.
// Dynamic readers supply DOM as a final fallback; no content probe for NORMAL.
import { fetchImageDataUriFromUrl, blobToDataUri } from './images.js';
import { composeImageResponse, comixCandidate, comixV3, imageRequestUrl } from './image-composition.js';
import { decodeSiteImage, siteImageCandidate, vizEndpoint, vizSignedUrl } from './image-composition/site-adapters.js';
import { omoiCandidate } from './image-composition/omoi.js';
import { mangaMiraiKey } from './image-composition/manga-mirai.js';
import { note as traceNote } from '../shared/trace.js';
import { createLogger } from '../shared/logger.js';
const log = createLogger('SW.imageAcquisition');
const policies = new Map(), refererOwners = new Map();
const RULE_START = 19000000, RULE_END = 19999999;
const TRANSIENT_IMAGE_HTTP = new Set([429,502,503,504]);
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
function transientRetryDelay(response, attempt) {
  const raw=String(response.headers.get('retry-after') || '').trim();
  const seconds=/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw)*1000 : NaN;
  const date=raw && !Number.isFinite(seconds) ? Date.parse(raw)-Date.now() : NaN;
  const suggested=Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : 0;
  // Never send another request early when the origin asks us to wait longer
  // than this page's bounded acquisition can reasonably stay alive.
  if(suggested>3000)return 0;
  return Math.max(200,suggested || 250*(attempt+1));
}
function waitForImageRetry(ms, signal) {
  if(signal?.aborted)return Promise.reject(abortError());
  return new Promise((resolve,reject)=>{
    const done=()=>{signal?.removeEventListener('abort',onAbort);resolve();};
    const timer=setTimeout(done,ms);
    const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(abortError());};
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted)onAbort();
  });
}
async function refererFetch(url,pageUrl,signal,{compositionHint='unknown',onResult=null,
  retryTransient=false,onRetry=null}={}) {
  const ref=new URL(pageUrl), source=new URL(imageRequestUrl(url,pageUrl,compositionHint));source.hash='';
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
    const requestHeaders=[{header:'Referer',operation:'set',value:ref.href}];
    // Comix's v3 CDN suppresses its tile seed if Origin is present. This rule
    // applies only to the exact fallback image URL, for the lifetime of fetch.
    if(comixV3(source.href,pageUrl))requestHeaders.push({header:'Origin',operation:'remove'});
    if(/^(?:www\.)?viz\.com$/i.test(ref.hostname))
      requestHeaders.push({header:'Origin',operation:'set',value:'https://www.viz.com'});
    if(omoiCandidate(url,pageUrl))
      requestHeaders.push({header:'Origin',operation:'set',value:'https://www.omoi.com'});
    if(mangaMiraiKey(url,pageUrl))
      requestHeaders.push({header:'Origin',operation:'set',value:'https://mangamirai.com'});
    const rule={id,priority:1,action:{type:'modifyHeaders',requestHeaders},
      condition:{regexFilter:`^${esc(source.href)}$`,isUrlFilterCaseSensitive:true,
        initiatorDomains:[new URL(chrome.runtime.getURL('')).hostname],resourceTypes:['xmlhttprequest']}};
    await dnrCall('updateSessionRules',{addRules:[rule]});
    try {
      if(signal?.aborted)throw abortError();
      let response;
      for(let attempt=0;;attempt++){
        response=await fetch(source.href,{credentials:'include',cache:'no-store',signal});
        if(response.ok)break;
        if(!retryTransient || attempt>=2 || !TRANSIENT_IMAGE_HTTP.has(response.status))
          throw new Error(`HTTP ${response.status}`);
        const delayMs=transientRetryDelay(response,attempt);
        if(!delayMs)throw new Error(`HTTP ${response.status}`);
        onRetry?.({status:response.status,attempt:attempt+1,delayMs});
        await response.body?.cancel?.();
        await waitForImageRetry(delayMs,signal);
      }
      if(vizEndpoint(url,pageUrl)){
        const signed=await vizSignedUrl(response);
        return refererFetch(signed,pageUrl,signal,{compositionHint,onResult});
      }
      const mime=String(response.headers.get('content-type')||'').split(';')[0];
      const verifiedBinary=Boolean(mangaMiraiKey(url,pageUrl)) &&
        /^(?:application|binary)\/octet-stream$/i.test(mime);
      if(mime&&!mime.toLowerCase().startsWith('image/')&&!verifiedBinary)
        throw new Error(`Not an image: ${mime}`);
      const blob=await response.blob();
      if(blob.size<64||blob.size>25*1024*1024)throw new Error('REFERER_IMAGE_SIZE_INVALID');
      const inspected=await composeImageResponse(blob,response.headers,{signal,hint:compositionHint,onResult});
      const prepared=inspected===blob ? await decodeSiteImage(blob,{url,pageUrl,signal,onResult}) : inspected;
      if(verifiedBinary&&!/^image\//i.test(prepared.type))
        throw new Error('Encoded source did not decode to an image');
      return blobToDataUri(prepared,prepared===blob?mime||blob.type:prepared.type);
    } finally {await dnrCall('updateSessionRules',{removeRuleIds:[id]}).catch(error=>log.warn('referer rule cleanup failed',{id,error:error.message}));}
  } finally {unlock();if(refererOwners.get(url)===owned)refererOwners.delete(url);}
}

// Each admitted image fetches independently. Remember successful routes, but do
// not make a whole chapter await a slow first image or add a probe request.
export async function acquireImageDataUri(url, pageUrl = '', signal = null, {
  scope = `page:${pageUrl}`, domFetch = null, timeoutMs = 0, traceId = '', pageId = '', imageId = '', onRoute = null,
  compositionHint = 'unknown',
} = {}) {
  const report=(phase, detail)=>{try{onRoute?.(phase,detail);}catch{}};
  if (signal?.aborted) throw abortError();
  if (!String(url || '').trim()) return '';
  const source = new URL(url);
  // NORMAL policy keys may include a page URL. Only reader UUIDs may leave
  // memory in compact trace scopes; page URLs can contain private queries.
  const traceRunId=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(scope) ? scope : '';
  // A URL explicitly tagged v3 takes precedence over a stale/plain page flag.
  if (comixCandidate(url,pageUrl) && comixV3(url,pageUrl)) compositionHint='scrambled';
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
  // Comix's lazy canvas is display-only; decode the original URL and response
  // headers even when its page has not mounted. Preserve the validated DOM
  // fallback used by other site adapters when their network routes fail.
  const networkComposition = comixCandidate(url,pageUrl) || compositionHint==='scrambled';
  const verified = networkComposition || siteImageCandidate(url,pageUrl);
  const available = domFetch && !networkComposition ? ['DEFAULT', 'REFERER', 'DOM'] : ['DEFAULT', 'REFERER'];
  const preferred = available.includes(entry.preferred) && !(verified && entry.preferred==='DOM')
    ? entry.preferred : '';
  const order = [...new Set([preferred, ...available].filter(Boolean))];
  const failures = [];
  const onComposition=(status,detail)=>{
    report(`composition_${status}`,detail);
    traceNote('background/image-acquisition.js','imageComposition',{
      schema:'tp.audit/1',event:'image_composition',
      scope:{runId:traceRunId,pageId:`p${pageId || 0}`,imageId},
      imageHint:compositionHint,
      compositionState:status,
      compositionGrid:detail?.grid || 'unknown',
      compositionCode:status==='failed' ? detail?.code || 'unknown' : 'unknown',
      compositionKind:status==='plain' ? 'plain' :
        ['tiles','bytes'].includes(detail?.kind) ? detail.kind :
          detail?.kind ? 'site' : 'unknown',
      counts:{w:Number(detail?.width)||0,h:Number(detail?.height)||0},
    },traceId);
  };
  try {
    for (const route of order) {
      if (signal?.aborted) throw abortError();
      const startedAt = Date.now();
      report('start',{route,preferred:preferred || 'none',previousFailures:failures.length});
      try {
        const dataUri = await bounded(ownedSignal => {
          if (route === 'DEFAULT') {
            const onResponse=async (blob,response,actualUrl=url)=>{
              const inspected=await composeImageResponse(blob,response.headers,{
                signal:ownedSignal,hint:compositionHint,onResult:onComposition});
              return inspected===blob ? decodeSiteImage(blob,{url:actualUrl,pageUrl,
                signal:ownedSignal,onResult:onComposition}) : inspected;
            };
            if(vizEndpoint(url,pageUrl))return (async()=>{
              const endpoint=await fetch(url,{credentials:'include',cache:'no-store',
                referrer:pageUrl||'about:client',signal:ownedSignal});
              const signed=await vizSignedUrl(endpoint);
              return fetchImageDataUriFromUrl(signed,pageUrl,ownedSignal,{
                onResponse:(blob,response)=>onResponse(blob,response,signed)});
            })();
            return fetchImageDataUriFromUrl(url, pageUrl, ownedSignal,{
              requestUrl:imageRequestUrl(url,pageUrl,compositionHint),onResponse,
              allowBinaryImage:Boolean(mangaMiraiKey(url,pageUrl))});
          }
          if (route === 'REFERER') return refererFetch(url, pageUrl, ownedSignal,{
            compositionHint,onResult:onComposition,retryTransient:Boolean(domFetch),
            onRetry:detail=>{
              report('retry',{route:'REFERER',...detail});
              traceNote('background/image-acquisition.js','imageAcquisition_REFERER_retry',{
                schema:'tp.audit/1',event:'route_retry',scope:{runId:traceRunId,pageId:`p${pageId || 0}`,imageId},
                status:detail.status,counts:{httpAttempts:detail.attempt},timing:{pauseMs:detail.delayMs},
              },traceId);
            }});
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
          scope:{runId:traceRunId,pageId:`p${pageId || 0}`},
          timing:{readMs:Date.now()-startedAt},counts:{fallbackCount:failures.length},
        }, traceId);
        if (failures.length || preferred !== route)
          log.info('image acquisition selected', { scope:traceRunId || 'normal', route, host, fallbacks: failures });
      return dataUri;
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw abortError();
        if(/^IMAGE_COMPOSE_/.test(String(error?.code || '')))
          onComposition('failed',{code:String(error.code).slice('IMAGE_COMPOSE_'.length).toLowerCase()});
        report('failed',{route,elapsedMs:Date.now()-startedAt,
          code:error?.code || error?.name || 'FETCH_FAILED',reason:error?.message || String(error)});
        failures.push({ route, reason: error.message });
        traceNote('background/image-acquisition.js', `imageAcquisition_${route}_fallback`, {
          schema:'tp.audit/1',event:'route_capability',reason:'failed',
          scope:{runId:traceRunId,pageId:`p${pageId || 0}`},timing:{readMs:Date.now()-startedAt},
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
