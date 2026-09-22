// Dynamic adds only its owner-validated DOM fallback to the shared NORMAL reader.
import { acquireImageDataUri, forgetImageAcquisition } from './image-acquisition.js';
import { requestFromTabExact } from './tabs-messaging.js';
export const forgetReaderAcquisition = forgetImageAcquisition;
export async function acquireReaderImage(payload, {tabId, frameId=0, pageUrl='', signal=null}={}) {
  const reader=payload.reader, url=String(payload.src || '');
  if (!reader?.runId || reader.runId !== payload.generation?.readerRunId)
    throw new Error('READER_OWNER_MISSING');
  return acquireImageDataUri(url,pageUrl,signal,{
    scope: reader.runId, timeoutMs: 14000,
    traceId: String(payload.context?.tp_trace || ''), pageId: String(reader.pageId || ''),
    domFetch: async ownedSignal => {
      ownedSignal.throwIfAborted();
      const response=await requestFromTabExact(tabId,{
        type:'TP_READER_DOM_FETCH',url,readerRunId:reader.runId,pageId:reader.pageId,
      },frameId);
      ownedSignal.throwIfAborted();
      if (!response?.ok || !response.dataUri) throw new Error(response?.error || 'DOM_READER_UNAVAILABLE');
      return response.dataUri;
    },
  });
}
