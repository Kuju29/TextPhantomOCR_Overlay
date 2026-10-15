import assert from 'node:assert/strict';
import {createLoginServiceController} from '../src/popup/controllers/login-service-controller.js';

const element=()=>({value:'',textContent:'',style:{},children:[],disabled:false,
  addEventListener(){},removeEventListener(){},setAttribute(){},replaceChildren(...children){this.children=children;}});
globalThis.document={createElement:element};
const account={addons:{entitlements:[{code:'ai_login',status:'active'}]}},apiBase='http://localhost:7860',token='offline-fixture';
const until=async test=>{for(let n=0;n<100&&!test();n++)await new Promise(resolve=>setTimeout(resolve,2));assert.ok(test(),'Provider status did not settle.');};
for(const reason of ['official_registration_required','endpoint_browser_proof_required','consumer_endpoint_not_implemented']){
  const els=Object.fromEntries(['aiPaidSource','aiPaidSourceWrap','aiPaidTpModel','aiLoginPanel','aiLoginProvider','aiLoginModel','aiLoginModelWrap','aiLoginAccount','aiLoginStatus','aiLoginConnect','aiLoginRefresh','aiLoginLogout','aiLoginCancel'].map(key=>[key,element()]));
  const state={},storage={paidTranslationSource:'login',loginProvider:'login_chatgpt',loginModel:'',paidApiBase:apiBase,paidSessionToken:token};
  const controller=createLoginServiceController({els,state,getStorage:async()=>({...storage}),setStorage:async patch=>Object.assign(storage,patch),readAuth:async()=>({}),writeAuth:async()=>{},toggleUi(){},
    request:async path=>{assert.equal(path,'/login/providers');return {providers:[{id:'login_chatgpt',name:'ChatGPT',available:false,supported:false,reason}]};}});
  await controller.initialize(storage,{apiBase,token,account});controller.sync({active:true,account,accountVerified:true,apiBase,token});
  await until(()=>els.aiLoginStatus.textContent && !/Checking/.test(els.aiLoginStatus.textContent));
  assert.equal(els.aiLoginProvider.children[0].textContent,'ChatGPT · Endpoint unavailable',reason); // .77: ChatGPT is no longer hard-labelled; an unavailable API reply uses the generic label
  assert.match(els.aiLoginStatus.textContent,/browser-session endpoint translation is not implemented/,reason);
  assert.match(els.aiLoginStatus.textContent,/registration is not required/,reason);
  assert.doesNotMatch(els.aiLoginStatus.textContent,/approved official|Ask the app administrator|per-request browser verification|developers\.openai\.com/);
  assert.equal(state.loginConnected,false);assert.equal(els.aiLoginConnect.disabled,true);
  controller.dispose();
}
console.log('PASS current and legacy ChatGPT reasons explain missing browser-session adapter without OAuth or live-challenge prerequisite.');
