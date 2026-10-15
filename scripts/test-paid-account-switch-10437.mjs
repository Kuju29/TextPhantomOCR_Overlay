import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPaidServiceController} from '../src/popup/controllers/paid-service-controller.js';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const element=(value='')=>({value,textContent:'',style:{},disabled:false,handlers:{},
  addEventListener(name,fn){this.handlers[name]=fn;},removeEventListener(){},
  setAttribute(){},replaceChildren(...children){this.children=children;},focus(){}});
globalThis.document={createElement:()=>element(),visibilityState:'visible'};
const tick=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
const base='http://localhost:7860';
const customer=(letter)=>({email:`account-${letter}@example.com`,credits:{available:letter==='a'?'1234':'9876',held:'0'},
  models:[{id:'demo/model',name:'Demo',eligible_tp:'1234'}],paid_paused:false});

function fixture({signedIn=true,deferReads=false}={}){
  const changes=new Set(),store={aiServiceMode:'paid',customApiUrl:base,paidApiBase:signedIn?base:'',
    paidSessionToken:signedIn?'account-a-session':'',paidEmail:signedIn?customer('a').email:'',paidModel:'demo/model'};
  globalThis.chrome={runtime:{},storage:{session:{get:(_keys,callback)=>callback({})},
    onChanged:{addListener:fn=>changes.add(fn),removeListener:fn=>changes.delete(fn)}}};
  const emit=patch=>{const event={};for(const[key,value]of Object.entries(patch)){if(store[key]!==value)event[key]={oldValue:store[key],newValue:value};store[key]=value;}
    for(const fn of changes)fn(event,'local');};
  const names=['mode','sources','apiUrl','aiService','aiPaidCredits','aiPaidEmailLabel','aiPaidHeld','aiPaidAccountState',
    'aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidRefresh','aiPaidLogout','aiPaidStatus','aiPaidVerify','aiPaidEmail','aiPaidCode'];
  const els=Object.fromEntries(names.map(name=>[name,element()]));
  els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value=base;
  const state={lastSavedApiUrl:base},requests=[],reads=[];
  let blockReads=deferReads,controller;
  globalThis.fetch=async(url,options)=>new Promise(resolve=>requests.push({url,options,resolve:value=>resolve({ok:true,json:async()=>value})}));
  controller=createPaidServiceController({els,state,getStorage:async keys=>{
    const snapshot=Object.fromEntries(keys.map(key=>[key,structuredClone(store[key])]));
    return blockReads?new Promise(resolve=>reads.push(()=>resolve(snapshot))):snapshot;
  },setStorage:async patch=>emit(structuredClone(patch)),toggleUi:()=>controller.applyVisibility()});
  return {controller,els,state,store,emit,requests,reads,unblock(){blockReads=false;},respond(path,data){
    const request=requests.find(x=>x.url.endsWith(path)&&!x.done);assert.ok(request,`Missing ${path}`);request.done=true;request.resolve(data);return request;
  }};
}

{
  const f=fixture();await f.controller.initialize();f.controller.setAvailability(true,base);await tick();
  f.respond('/paid/me',customer('a'));await tick();assert.equal(f.state.paidReady,true);
  const refresh=f.controller.reconnect();await tick();const old=f.requests.at(-1);
  f.emit({paidSessionToken:'account-b-session',paidEmail:customer('b').email});
  assert.equal(f.state.paidReady,false,'Changing the stored account must synchronously revoke the old account authority.');
  assert.notEqual(f.els.aiPaidEmailLabel.textContent,customer('a').email,'Old account details must disappear before reading the replacement account.');
  assert.equal(old.options.signal.aborted,true,'The previous account request must be cancelled.');
  await tick();
  const replacement=f.requests.find(x=>x.options.headers.Authorization==='Bearer account-b-session');
  assert.ok(replacement,'The controller should restore and verify the replacement session.');
  old.resolve(customer('a'));await refresh;await tick();assert.equal(f.state.paidReady,false);
  replacement.resolve(customer('b'));await tick();
  assert.equal(f.els.aiPaidEmailLabel.textContent,customer('b').email);assert.equal(f.state.paidReady,true);
  f.controller.dispose();
}
{
  const f=fixture();await f.controller.initialize();f.controller.setAvailability(true,base);await tick();
  f.respond('/paid/me',customer('a'));await tick();
  const pending=f.controller.reconnect();await tick();const old=f.requests.at(-1);
  // Simulate another window committing a replacement while its event is queued.
  f.store.paidSessionToken='account-b-session';f.store.paidEmail=customer('b').email;
  old.resolve(customer('a'));await pending;await tick();
  assert.equal(f.state.paidReady,false);assert.notEqual(f.els.aiPaidEmailLabel.textContent,customer('a').email);
  const replacement=f.requests.find(x=>x.options.headers.Authorization==='Bearer account-b-session');
  assert.ok(replacement);replacement.resolve(customer('b'));await tick();assert.equal(f.state.paidReady,true);f.controller.dispose();
}
{
  const f=fixture();await f.controller.initialize();f.controller.setAvailability(true,base);await tick();
  f.respond('/paid/me',customer('a'));await tick();
  f.emit({customApiUrl:'https://replacement.example'});
  assert.equal(f.state.paidReady,false);assert.notEqual(f.els.aiPaidEmailLabel.textContent,customer('a').email);
  await tick();assert.ok(!f.requests.some(x=>x.url.startsWith('https://replacement.example')&&x.options.headers.Authorization),'A newly selected API must never receive the previous API session.');
  f.controller.dispose();
}
{
  const f=fixture({signedIn:false});await f.controller.initialize();f.controller.setAvailability(true,base);await tick();
  f.respond('/paid/auth/status',{available:true});await tick();
  f.els.aiPaidEmail.value=customer('b').email;f.els.aiPaidCode.value='123456';
  const signingIn=f.els.aiPaidVerify.handlers.click();await tick();
  f.respond('/paid/auth/verify',{token:'account-b-session'});await tick();
  f.respond('/paid/me',customer('b'));await signingIn;await tick();
  assert.equal(f.state.paidReady,true,'Own OTP storage changes must not cancel the successful sign-in.');
  assert.equal(f.els.aiPaidEmailLabel.textContent,customer('b').email);f.controller.dispose();
}
{
  const f=fixture({deferReads:true});const initializing=f.controller.initialize();await tick();
  f.emit({paidSessionToken:'account-b-session',paidEmail:customer('b').email});
  f.unblock();for(const resolve of f.reads.splice(0))resolve();await initializing;await tick();
  f.controller.setAvailability(true,base);await tick();
  const current=f.requests.find(x=>x.url.endsWith('/paid/me'));
  assert.equal(current?.options.headers.Authorization,'Bearer account-b-session','A late startup read must never restore the former account.');
  current.resolve(customer('b'));await tick();assert.equal(f.els.aiPaidEmailLabel.textContent,customer('b').email);f.controller.dispose();
}
console.log('PASS account switches clear authority immediately, fence old/startup results, and preserve own OTP sign-in.');
