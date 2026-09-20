import {providerBillingFenceError} from "../../../shared/error-contract.js";
// Per-document ordering for real image jobs. Not a provider-cache warm-up gate.
// Reserve before OCR can finish out of order; enter BEFORE acquiring AI capacity.
const tails = new Map();
const tickets = new WeakMap();
const active = new Set();
export const selectedMode = ai => ai?.translation_mode === "independent" ? "independent" : "conversation";
export function bindConversation(payload, tabId = 0) {
  if (!payload?.ai || payload.source !== "ai" || selectedMode(payload.ai) !== "conversation") return null;
  const context = payload.context || {}, d = payload.ai.conversation || {};
  const documentId = String(d.documentId || context.page_url || "");
  const owner = String(context.tp_tab_session || payload.metadata?.tp_tab_session || (tabId ? `tab:${tabId}` : ""));
  payload.ai.conversation = { ...d, documentId, owner,
    reset: "automatic",
    pageId: String(payload.metadata?.image_id || d.pageId || ""),
    ...(Number.isInteger(context.page_index) ? {pageIndex:context.page_index} : {}),
    branch: "initial", orderPolicy: d.orderPolicy || "request_arrival" };
  return payload.ai.conversation;
}
export function reserveConversationJob(payload, tabId = 0) {
  const d = bindConversation(payload, tabId);
  if (!d || !d.documentId || !d.owner || tickets.has(payload)) return null;
  const a=payload.ai;
  // Raw values remain transient in this private worker map, never in diagnostics.
  const key=JSON.stringify([d.owner,d.documentId,d.reset,a.provider,a.base_url,a.model,
    a.api_key,a.prompt,payload.lang,a.style_examples,a.memory_mode,a.thinking,a.send_image]);
  const prior = tails.get(key);
  let resolve;
  const promise = new Promise(r => {resolve=r;});
  const billingKey=JSON.stringify([a.provider,a.base_url,a.api_key || d.owner]);
  const ticket={key,billingKey,prior:prior?.promise || Promise.resolve(),promise,resolve,tabId,
    batchId:String(payload.metadata?.batch_id || ""),done:false,entered:false,
    order:(prior?.order || 0)+1};
  // Keep wire identity and append-only history independent of scheduling.
  // The ready queue orders live reservations by webpage index.
  d.pageOrder=ticket.order; d.orderPolicy="request_arrival";
  ticket.descriptor=Object.freeze({...d});
  tails.set(key,ticket); tickets.set(payload,ticket); active.add(ticket);
  return ticket;
}
function finish(ticket) {
  if (!ticket || ticket.done) return;
  ticket.done=true; active.delete(ticket); wakeConversationReady();
  // A cancelled middle image must not let its successors overtake the image
  // preceding it. Keep a settled-tail fence until the predecessor has settled.
  ticket.prior.finally(() => {
    ticket.resolve();
    if (tails.get(ticket.key)===ticket) tails.delete(ticket.key);
  });
}
export function fenceConversationBilling(ownerTicket) {
  // A late response belonging to a cancelled run cannot fence a fresh run.
  if (!active.has(ownerTicket) || ownerTicket.done) return;
  const billingKey = ownerTicket.billingKey;
  // Existing reservations only: account failures affect other models/documents
  // using this credential, not another key/provider or a newly requested run.
  for (const ticket of active) {
    if (ticket.billingKey === billingKey && !ticket.done && !ticket.consumed)
      ticket.billingFailure = providerBillingFenceError();
  }
  wakeConversationReady();
}
export function finishConversationJob(payload) {finish(tickets.get(payload));tickets.delete(payload);}
export function cancelConversationJobs({tabId,batchId}={}) {
  for(const ticket of active) if((tabId==null||ticket.tabId===tabId)&&(!batchId||ticket.batchId===batchId)) finish(ticket);
}
export async function enterConversationJob(payload, signal, trace=null) {
  const ticket=tickets.get(payload);
  if(!ticket || ticket.entered) return 0;
  const started=performance.now();
  if(signal?.aborted) throw new DOMException("Conversation cancelled", "AbortError");
  await new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",abort);reject(new DOMException("Conversation cancelled","AbortError"));};
    const timer=setTimeout(()=>{signal?.removeEventListener?.("abort",abort);reject(Object.assign(new Error("Waiting for an earlier image timed out"),{code:"ai_conversation_wait_timeout",providerAttempts:0}));},600000);
    signal?.addEventListener?.("abort",abort,{once:true});
    ticket.prior.then(()=>{clearTimeout(timer);signal?.removeEventListener?.("abort",abort);resolve();},reject);
  });
  if(signal?.aborted||ticket.done) throw new DOMException("Conversation cancelled", "AbortError");
  ticket.entered=true;
  const waited=Math.max(0,performance.now()-started);
  payload.ai.conversation.pageQueueWaitMs=waited;
  trace?.("AI conversation order",{schema:"tp.conversation/1",mode:"conversation",path:"conversation",
    orderPolicy:"request_arrival",pageOrder:ticket.order,queueWaitMs:waited,
    commitStatus:"not_applicable",legacyFallback:false,providerCallsAdded:0});
  return waited;
}

// Ready-data batching uses the same enqueue reservations, not the old page gate.
const listeners = new Set();
export function onConversationReady(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function wakeConversationReady() { for (const fn of listeners) fn(); }
export function reservedConversation(payload) {
  const descriptor=tickets.get(payload)?.descriptor;
  return descriptor ? {...descriptor} : null;
}
export function conversationTicket(payload) { return tickets.get(payload) || reserveConversationJob(payload); }
export function conversationTickets(key) {
  const sourceOrder=t=>{
    const index=t.descriptor.pageIndex;
    return Number.isInteger(index)&&index>=0&&index<10000000 ? index : t.order;
  };
  return [...active].filter(t=>t.key===key&&!t.consumed)
    .sort((a,b)=>sourceOrder(a)-sourceOrder(b)||a.order-b.order);
}
