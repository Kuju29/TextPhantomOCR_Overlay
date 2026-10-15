/** Actual popup→inline account→Paid controller; synthetic account boundary. */
import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
const A='http://localhost:7860',B='http://localhost:7861';
const pack={id:'pkg_'+'a'.repeat(32),version:1,name:'Synthetic TP package',price_satang:2900,credits:'250000',months:6};
const order={id:'ord_'+'b'.repeat(32),package_id:pack.id,package_version:1,package_name:pack.name,
  amount_satang:2900,credits:'250000',months:6,method:'checkout',status:'creating',created_at:Date.now(),
  selection_result:'created',recheck_allowed:true};
const checks=[];
function harness(){
  let clock=Date.now(),phase='before',holdA=false,holdB=false;
  const reads={a:0,b:0},held={a:[],b:[]};
  const me=(who,credits)=>({email:who+'@example.test',credits:{available:String(credits),held:'0'},
    models:[{id:'qa/test',name:'QA model',eligible_tp:String(credits),pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'1',output_tp:'2'}}],addons:{entitlements:[]}});
  const balance=who=>who==='a'?(phase==='credited'?'260000':'10000'):(phase==='b_updated'?'30000':'20000');
  const account=who=>({...me(who,balance(who)),purchase:{ready:true},packages:[pack],
    history:Object.fromEntries(['orders','payments','usage','lots','refunds','ledger'].map(kind=>[kind,{items:kind==='orders'&&['waiting','credited'].includes(phase)?[{...order,status:phase==='credited'?'credited':'waiting'}]:[],total:0,offset:0,limit:25}])),addons:{products:[],orders:[],entitlements:[]}});
  const local={mode:'lens_text',sources:'ai',lang:'th',uiLanguageV1:'en',customApiUrl:A,apiUrlDefault:A,apiDefaultsFetchedAt:clock,
    aiServiceMode:'paid',paidTranslationSource:'tp',paidSessionToken:'synthetic-a',paidApiBase:A,paidServiceApiBase:A,paidModel:'qa/test'};
  const reply=(value,status=200)=>Response.json(value,{status});
  const fetchReply=async(url,options={})=>{
    const parsed=new URL(url);assert([A,B].includes(parsed.origin),'No external fixture request');
    const who=parsed.origin===A?'a':'b',p=parsed.pathname;
    if(p==='/meta')return reply({ok:true,paid:{configured:true,available:true}});
    if(p==='/health')return reply({ok:true});
    if(p==='/paid/me'){
      assert.equal(options.headers.Authorization,'Bearer synthetic-'+who,'Request owner and API must agree');reads[who]++;
      const snapshot=me(who,balance(who));
      // Deliberately allow an already-sent response to settle after abort:
      // the production request identity fence must reject it independently.
      if(who==='a'&&holdA||who==='b'&&holdB)return new Promise(resolve=>held[who].push(()=>resolve(reply(snapshot))));
      return reply(snapshot);
    }
    if(p==='/paid/account')return reply(account(who));
    if(p==='/paid/orders'&&options.method==='POST'){
      const body=JSON.parse(options.body);assert.equal(body.package_id,pack.id);assert.equal(body.package_version,pack.version);
      phase='waiting';return reply(order);
    }
    if(p==='/paid/orders/'+order.id)return reply({...order,status:phase==='credited'?'credited':'waiting'});
    if(p==='/paid/auth/status')return reply({available:true,registration_enabled:true});
    return reply({});
  };
  return{local,reads,held,get clock(){return clock;},set phase(v){phase=v;},hold(who){if(who==='a')holdA=true;else holdB=true;},
    release(who){if(who==='a')holdA=false;else holdB=false;for(const resolve of held[who].splice(0))resolve();},
    async boot(){return popupEntryFixture({local,session:{},fetchReply,now:()=>clock,manualTimers:true});},
    async advance(h,ms){clock+=ms;h.runDueTimers();await h.settle(100);}};
}
const field=(h,id)=>h.fields.get(id);
const nodes=h=>field(h,'ai-paid-inline').querySelectorAll('*');
const button=(h,text)=>nodes(h).find(el=>el.tagName==='BUTTON'&&el.textContent===text);
// Bounded by turns AND real time: lazy module loads/fetch bodies finish on real
// I/O, so a busy machine needs more turns (HEAD .88 flaked the same way).
const wait=async(h,predicate,message)=>{const deadline=Date.now()+10000;for(let i=0;i<300||Date.now()<deadline;i++){if(predicate())return;await h.settle(2);}assert(predicate(),message+'; main balance='+field(h,'ai-paid-credits').textContent);};
async function catalog(h){field(h,'ai-paid-buy').click();await wait(h,()=>button(h,'Select package')&&!button(h,'Select package').disabled,'fresh owned catalog');}

{
 const s=harness(),h=await s.boot();try{
  await wait(h,()=>field(h,'ai-paid-credits').textContent==='10,000 TP','initial account');s.hold('a');await catalog(h);await wait(h,()=>s.held.a.length===1,'older pending me');
  button(h,'Select package').click();await wait(h,()=>field(h,'ai-paid-inline').querySelector('.tp-account-checkout-summary'),'actual purchase enters payment');await h.settle(150);
  s.phase='credited';await s.advance(h,11000);await wait(h,()=>/Credits added/.test(field(h,'ai-paid-inline').textContent),'terminal order reached inline account');
  assert.equal(field(h,'ai-paid-credits').textContent,'10,000 TP','Pending original me is not replaced by inline authority');s.release('a');
  await wait(h,()=>field(h,'ai-paid-credits').textContent==='260,000 TP','postpurchase requires a fresh queued me');assert(s.reads.a>=3);
  checks.push('Actual Buy→terminal poll queues a fresh owned me after an older reply, then updates main TP');
 }finally{h.close();}
}
{
 const s=harness(),h=await s.boot();try{
  await wait(h,()=>field(h,'ai-paid-credits').textContent==='10,000 TP','initial account');s.hold('a');await catalog(h);await wait(h,()=>s.held.a.length===1,'pending me');
  button(h,'Reload').click();await h.settle(100);h.writeLocal({paidSessionToken:'',paidApiBase:''});await h.settle(100);s.release('a');await h.settle(150);
  assert.equal(field(h,'ai-paid-credits').textContent,'— TP');assert.equal(field(h,'ai-paid-inline').hidden,true);assert.equal(s.reads.a,2,'Signout cannot drain a previous account queue into a new read');
  checks.push('Signout clears pending refresh and a late owned reply cannot restore balance or authority');
 }finally{h.close();}
}
{
 const s=harness(),h=await s.boot();try{
  await wait(h,()=>field(h,'ai-paid-credits').textContent==='10,000 TP','initial A');s.hold('a');await catalog(h);await wait(h,()=>s.held.a.length===1,'pending A');button(h,'Reload').click();await h.settle(100);
  h.writeLocal({customApiUrl:B,paidApiBase:'',paidServiceApiBase:B,paidSessionToken:''});await h.settle(200);
  h.writeLocal({paidApiBase:B,paidServiceApiBase:B,paidSessionToken:'synthetic-b'});
  await wait(h,()=>field(h,'ai-paid-credits').textContent==='20,000 TP','fresh account on changed API');s.hold('b');await catalog(h);await wait(h,()=>s.held.b.length===1,'pending B');
  s.phase='b_updated';button(h,'Reload').click();await h.settle(100);const bReads=s.reads.b;
  s.release('a');await h.settle(150);assert.equal(field(h,'ai-paid-credits').textContent,'20,000 TP','Old API/account cannot paint A');assert.equal(s.reads.b,bReads,'Old finally cannot start or drain a newer scope queue');
  s.release('b');await wait(h,()=>field(h,'ai-paid-credits').textContent==='30,000 TP','B pending queue survives canceled A finally');assert(s.reads.b>bReads);
  checks.push('API/account switch fences A and its canceled finally cannot drain a later B refresh queue');
 }finally{h.close();}
}
console.log(JSON.stringify({passed:checks.length,failed:0,scope:'Unchanged production popup entry and inline/controller consumers; synthetic HTTP boundary, no live account/payment/provider',checks}));
