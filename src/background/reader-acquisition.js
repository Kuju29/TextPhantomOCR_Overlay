// Dynamic adds only its owner-validated DOM fallback to the shared NORMAL reader.
import { acquireImageDataUri, forgetImageAcquisition } from './image-acquisition.js';
import { requestFromTabExact } from './tabs-messaging.js';
import { reportImageScanForJob } from './image-scan-diagnostics.js';
import { siteImageCandidate } from './image-composition/site-adapters.js';
import { note as traceNote } from '../shared/trace.js';
export const forgetReaderAcquisition = forgetImageAcquisition;
export async function acquireReaderImage(payload, {tabId, frameId=0, pageUrl='', signal=null}={}) {
  const reader=payload.reader, url=String(payload.src || '');
  if (!reader?.runId || reader.runId !== payload.generation?.readerRunId)
    throw new Error('READER_OWNER_MISSING');
  const traceId=String(payload.context?.tp_trace || '');
  const imageId=String(payload.metadata?.image_id || '');
  traceNote('background/reader-acquisition.js','readerImageSource',{
    schema:'tp.audit/1',event:'image_source',
    scope:{runId:reader.runId,pageId:`p${reader.pageId || 0}`,imageId},
    imageHint:reader.compositionHint || 'unknown',
    sourceRoute:reader.adapter==='kagane' ? 'kagane_page' : 'url_with_referer',
  },traceId);
  if(reader.adapter==='kagane'){
    signal?.throwIfAborted();
    reportImageScanForJob(payload,'acquisition.route_start',{route:'KAGANE_PAGE'});
    const response=await requestFromTabExact(tabId,{type:'TP_READER_DOM_FETCH',url,
      readerRunId:reader.runId,pageId:reader.pageId,diagnosticId:payload.metadata?.batch_id || ''},frameId);
    signal?.throwIfAborted();
    if(!response?.ok || !/^data:image\//.test(response.dataUri || '')){
      reportImageScanForJob(payload,'acquisition.route_failed',{route:'KAGANE_PAGE',reason:response?.error || 'KAGANE_PAGE_UNAVAILABLE'});
      throw Error(response?.error || 'KAGANE_PAGE_UNAVAILABLE');
    }
    reportImageScanForJob(payload,'acquisition.route_success',{route:'KAGANE_PAGE',encodedChars:response.dataUri.length});
    return response.dataUri;
  }
  return acquireImageDataUri(url,pageUrl,signal,{
    scope: reader.runId, timeoutMs: 14000,
    compositionHint:reader.compositionHint || 'unknown',
    traceId, pageId: String(reader.pageId || ''), imageId,
    onRoute: (event,detail)=>reportImageScanForJob(payload,`acquisition.route_${event}`,detail),
    domFetch: async ownedSignal => {
      ownedSignal.throwIfAborted();
      const response=await requestFromTabExact(tabId,{
        type:'TP_READER_DOM_FETCH',url,readerRunId:reader.runId,pageId:reader.pageId,
        compositionHint:reader.compositionHint || 'unknown',
        diagnosticId:payload.metadata?.batch_id || '',
      },frameId);
      ownedSignal.throwIfAborted();
      if (!response?.ok || !response.dataUri) throw new Error(response?.error || 'DOM_READER_UNAVAILABLE');
      if((reader.compositionHint==='scrambled' || siteImageCandidate(url,pageUrl)) &&
          response.composition!=='rendered_canvas')
        throw new Error('DOM_COMPOSITE_NOT_VERIFIED');
      return response.dataUri;
    },
  });
}
