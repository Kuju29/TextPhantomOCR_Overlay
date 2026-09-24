// Dynamic adds only its owner-validated DOM fallback to the shared NORMAL reader.
import { acquireImageDataUri, forgetImageAcquisition } from './image-acquisition.js';
import { requestFromTabExact } from './tabs-messaging.js';
import { reportImageScanForJob } from './image-scan-diagnostics.js';
export const forgetReaderAcquisition = forgetImageAcquisition;
export async function acquireReaderImage(payload, {tabId, frameId=0, pageUrl='', signal=null}={}) {
  const reader=payload.reader, url=String(payload.src || '');
  if (!reader?.runId || reader.runId !== payload.generation?.readerRunId)
    throw new Error('READER_OWNER_MISSING');
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
    traceId: String(payload.context?.tp_trace || ''), pageId: String(reader.pageId || ''),
    onRoute: (event,detail)=>reportImageScanForJob(payload,`acquisition.route_${event}`,detail),
    domFetch: async ownedSignal => {
      ownedSignal.throwIfAborted();
      const response=await requestFromTabExact(tabId,{
        type:'TP_READER_DOM_FETCH',url,readerRunId:reader.runId,pageId:reader.pageId,
        diagnosticId:payload.metadata?.batch_id || '',
      },frameId);
      ownedSignal.throwIfAborted();
      if (!response?.ok || !response.dataUri) throw new Error(response?.error || 'DOM_READER_UNAVAILABLE');
      return response.dataUri;
    },
  });
}
