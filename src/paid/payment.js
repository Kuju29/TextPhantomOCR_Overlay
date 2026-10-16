import { changedTopics } from '../shared/change-signals.js';
/** Visible-page payment status monitor. Only the Center can verify payment or
 * issue credits; the browser reads customer-owned order state. */
export const orderIdValid = id => /^ord_[a-f0-9]{32}$/.test(id || '');
export const paymentPending = order => orderIdValid(order?.id) &&
  ['creating','create_pending','create_unknown','waiting','processing','review_required'].includes(order.status);

export const paymentTerminal = order => orderIdValid(order?.id) &&
  ['credited','cancelled','expired','failed'].includes(order.status);

export const paymentEndedUnpaid = order => orderIdValid(order?.id) &&
  ['cancelled','expired','failed'].includes(order.status);

// Account requests can return a snapshot captured before an order poll finished.
export function reconcileAccountOrder(data, active, id, preferActive=false) {
  const rows=data?.history?.orders?.items||[], index=rows.findIndex(row=>row.id===id);
  if(index<0)return active;
  const snapshot=rows[index];
  const keep=active?.id===id && (paymentTerminal(active)&&!paymentTerminal(snapshot) ||
    preferActive&&!paymentTerminal(snapshot));
  const current=keep?active:snapshot;
  rows[index]=current;
  return current;
}

// A pending order is re-read with a bounded backoff (2 s ... 5 min, about
// 9 min in all) while the page is visible, then only when the page becomes visible
// again (resume) or the account change token moves (checkout finished elsewhere).
// Was every 10 s for as long as the order stayed pending.
export const PAYMENT_POLL_MS = Object.freeze([2000, 5000, 10000, 30000, 60000, 120000, 300000]);
export function createPaymentMonitor({request,onOrder=()=>{},onSettled=()=>{},onError=()=>{},
  isVisible=()=>true,schedule=setTimeout,unschedule=clearTimeout,delays=PAYMENT_POLL_MS,
  storageEvents=globalThis.chrome?.storage?.onChanged}={}) {
  let active=null,timer=null,generation=0,round=0,inflight=null,disposed=false,paused=false,blocked=false;
  const clear=()=>{if(timer!==null)unschedule(timer);timer=null;};
  function queue(){
    clear();
    if(disposed||paused||blocked||!isVisible()||!paymentPending(active)||inflight)return;
    if(round>=delays.length)return; // Bounded: wait for resume() or an account change signal.
    timer=schedule(()=>{timer=null;void refresh().catch(()=>{});},delays[round++]);
  }
  const accountChanged=(changes,area)=>{
    if(area==='local'&&changedTopics(changes).includes('account')&&paymentPending(active)&&!paused&&!disposed){round=0;void refresh().catch(()=>{});}
  };
  try{storageEvents?.addListener?.(accountChanged);}catch{}
  async function refresh(id=active?.id){
    if(disposed||paused||!isVisible()||!orderIdValid(id))return null;
    blocked=false;
    if((active&&active.id!==id)||(inflight&&inflight.id!==id)){
      generation++;clear();round=0;inflight=null;active=null;
    }
    if(inflight?.id===id&&inflight.generation===generation)return inflight.promise;
    clear();const expected=generation;
    const run=(async()=>{
      try {
        const order=await request('/paid/orders/'+id);
        if(disposed||paused||expected!==generation||!isVisible())return null;
        if(order?.id!==id)throw new Error('The account service returned a different payment order.');
        const newlyTerminal=paymentTerminal(order)&&(!paymentTerminal(active)||active.status!==order.status);active=order;await onOrder(order);
        if(newlyTerminal&&expected===generation)await onSettled(order);
        return order;
      } catch(e){
        if(!disposed&&!paused&&expected===generation&&isVisible()){
          onError(e);
          // 10495: data use withdrawn: stop polling (nothing more is sent).
          if(e.status===401||e.status===403||/^DATA_CONSENT_/.test(e.code||'')){blocked=true;clear();}
        }
        throw e;
      }
      finally {if(inflight?.generation===expected){inflight=null;queue();}}
    })();
    inflight={id,generation:expected,promise:run};return run;
  }
  function watch(order){
    if(disposed)return;
    if(order?.id!==active?.id || paymentTerminal(order)&&paymentPending(active)){generation++;clear();round=0;inflight=null;blocked=false;}
    active=orderIdValid(order?.id)?order:null;queue();
  }
  function pause(){paused=true;generation++;clear();inflight=null;}
  function resume(){if(disposed||!paused)return;paused=false;round=0;if(paymentPending(active))void refresh().catch(()=>{});}
  function stop(){pause();active=null;}
  function dispose(){stop();disposed=true;try{storageEvents?.removeListener?.(accountChanged);}catch{}}
  return {watch,refresh,pause,resume,stop,dispose,getOrder:()=>active};
}
