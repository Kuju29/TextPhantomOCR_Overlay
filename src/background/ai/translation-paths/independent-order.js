import {isLocalAiPayload} from '../../local-capacity.js';

// Reservations are made before OCR, never while holding a provider slot. With
// story examples enabled a successor waits for its predecessor's accepted
// checkpoint, not merely its POST. Different documents/runs remain independent.
const tickets = new WeakMap();
const active = new Set();
let sequence = 0;
const listeners = new Set();
const wake = () => { for (const fn of [...listeners]) fn(); };
const aborted = () => new DOMException('Local AI image cancelled','AbortError');
const eligible = payload => payload?.engine !== 'api' && payload?.source === 'ai' &&
  payload?.ai?.translation_mode === 'independent' && isLocalAiPayload(payload);
export function reserveLocalIndependentJob(payload,tabId=0) {
  if (!eligible(payload) || tickets.has(payload)) return tickets.get(payload) || null;
  const context=payload.context || {}, a=payload.ai, meta=payload.metadata || {};
  const index=Number.isInteger(context.page_index) && context.page_index>=0 ? context.page_index : null;
  const ticket={key:JSON.stringify([context.tp_tab_session || meta.tp_tab_session || `tab:${tabId}`,
    meta.batch_id || '',context.page_url || '',a.provider,a.base_url,a.model,a.prompt,payload.lang]),
    tabId,batchId:String(meta.batch_id || ''),index,sequence:++sequence,entered:false,done:false,
    // This dependency, unlike capacity, cannot run concurrently without losing
    // the previous page's examples. With examples off only admission is ordered.
    waitForAccepted:a.style_examples !== false};
  tickets.set(payload,ticket);active.add(ticket);wake();return ticket;
}
const sourceOrder=t=>t.index ?? t.sequence;
const precedes=(a,b)=>sourceOrder(a)<sourceOrder(b) || sourceOrder(a)===sourceOrder(b)&&a.sequence<b.sequence;
function blocked(ticket) {
  for (const other of active) {
    if(other===ticket||other.done||other.key!==ticket.key) continue;
    if(ticket.waitForAccepted && other.entered) return true;
    if(precedes(other,ticket) && (ticket.waitForAccepted || !other.entered)) return true;
  }
  return false;
}
function finish(ticket) { if(ticket&&!ticket.done){ticket.done=true;active.delete(ticket);wake();} }
export function finishLocalIndependentJob(payload) {finish(tickets.get(payload));tickets.delete(payload);}
export function cancelLocalIndependentJobs({tabId,batchId}={}) {
  for(const ticket of [...active]) if((tabId==null||ticket.tabId===tabId)&&(!batchId||ticket.batchId===batchId))finish(ticket);
}
export async function enterLocalIndependentJob(payload,signal,trace=()=>{}) {
  if(!eligible(payload))return 0;
  const ticket=tickets.get(payload) || reserveLocalIndependentJob(payload);
  if(signal?.aborted||ticket.done)throw aborted();
  if(ticket.entered)return 0;
  const start=performance.now();
  await new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);listeners.delete(check);signal?.removeEventListener('abort',onAbort);};
    const onAbort=()=>{cleanup();finish(ticket);reject(aborted());};
    const check=()=>{
      if(signal?.aborted||ticket.done)return onAbort();
      if(blocked(ticket))return;
      ticket.entered=true;cleanup();resolve();wake();
    };
    timer=setTimeout(()=>{cleanup();finish(ticket);reject(Object.assign(new Error('An earlier Local image has not finished'),{
      code:'ai_independent_order_timeout',requestDispatched:false,providerAttempts:0,generationAttempts:0}));},600000);
    listeners.add(check);signal?.addEventListener('abort',onAbort,{once:true});check();
  });
  if(signal?.aborted||ticket.done)throw aborted();
  const wait=Math.max(0,performance.now()-start);
  trace({schema:'tp.audit/1',event:'independent_order',reason:ticket.waitForAccepted?'previous_page_accepted':'source_order_admission',
    queueWaitMs:wait,batchId:ticket.batchId,pageIndex:ticket.index,order:ticket.sequence});
  return wait;
}
