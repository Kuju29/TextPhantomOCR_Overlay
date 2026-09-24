// Moves only click-owned image-scan evidence from the worker to the WEB PAGE
// console. No persistent settings, URLs, image bytes or server-side trace.
import { requestFromTabExact } from './tabs-messaging.js';

const sessions = new Map();
const TEN_MINUTES = 10 * 60 * 1000;

export function startImageScanDiagnostics(scanId, tabId, frameId = 0) {
  if (!/^[a-f0-9-]{36}$/i.test(String(scanId || '')) || !tabId) return;
  if (sessions.size >= 3) sessions.delete(sessions.keys().next().value);
  sessions.set(scanId, {tabId, frameId, expires:Date.now() + TEN_MINUTES});
}

export function reportImageScan(scanId, phase, detail = {}) {
  const session = sessions.get(scanId);
  if (!session) return Promise.resolve(false);
  if (session.expires < Date.now()) {sessions.delete(scanId);return Promise.resolve(false);}
  return requestFromTabExact(session.tabId, {
    type:'TP_IMAGE_SCAN_DIAGNOSTIC',scanId,phase,detail,
  },session.frameId).then(reply => reply?.ok === true).catch(() => false);
}

export function reportImageScanForJob(payload, phase, detail = {}) {
  const scanId = String(payload?.metadata?.batch_id || '');
  if (!sessions.has(scanId)) return;
  void reportImageScan(scanId, phase, {
    pageId:String(payload?.reader?.pageId || ''),
    pageIndex:Number(payload?.context?.page_index ?? -1),
    route:payload?.reader?.runId ? 'DYNAMIC' : 'NORMAL',
    ...detail,
  });
}
