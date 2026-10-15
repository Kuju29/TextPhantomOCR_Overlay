import assert from 'node:assert/strict';
import {paidModelRates} from '../src/popup/controllers/paid-model-pricing.js';
import {paidEntry, putPaidEntry, PAID_PROFILE_KEY} from '../src/shared/paid-profile.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS} from '../src/generated/canonical-prompt-plans.js';
import {createPromptController} from '../src/popup/controllers/prompt-controller.js';
import {diagnoseTargetScripts} from '../src/background/ai/script-diagnostics.js';
let checks=0;
const check=(value,message)=>{assert(value,message);checks++;};
check(paidModelRates({pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'1650',output_tp:'8250'}}).output==='8,250','integer rate');
check(paidModelRates({pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'0.00000001',output_tp:'107.25'}}).input==='<1','tiny positive is not free');
for (const pricing of [null,{status:'unavailable'}, {status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:'NaN',output_tp:'0'}]) check(paidModelRates({pricing})===null,'unknown rate');
for (const [value, expected] of [['0','0'],['0.49','<1'],['0.5','<1'],['0.99','<1'],['1.49','1'],['1.5','2'],['842.3775','842'],['4211.8875','4,212'],['336.951','337']]) {
 check(paidModelRates({pricing:{status:'estimated',unit:'TP_PER_1000_TOKENS',input_tp:value,output_tp:value}}).input===expected,'whole TP '+value);
}
const settings={aiThinking:'high',aiPrompt:'Manual custom',aiProfilesV1:{active:{model:'manual'}}};
const first=paidEntry(settings,'https://api.example','new','th');
check(first.profile.thinking==='minimum'&&first.profile.memoryMode==='off'&&first.profile.pageImage==='off','new isolated defaults');
check(first.prompts.th.text===BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle,'canonical style');
const store=putPaidEntry({},'https://api.example','old',{profile:{thinking:'high'},prompts:{th:{text:'',mode:'replace'}}});
check(paidEntry({...settings,[PAID_PROFILE_KEY]:store},'https://api.example','old','th').prompts.th.text==='','saved intentional empty');
check(paidEntry({...settings,[PAID_PROFILE_KEY]:store},'https://api.example','new','th').profile.thinking==='minimum','no other model inheritance');
for(const text of ['MAPLE TRANSLATION','+ MAPLE TRANSLATION','++ MAPLE TRANSLATIONS','MAPLE TRANSLATION M','@maple_translation']) {
 check(diagnoseTargetScripts([{id:'P0',text}],'th',[{id:'P0',text}])[0].decision==='accept','preserved attribution '+text);
}
for(const [text,source] of [['THIS TRANSLATION','THIS TRANSLATION'],['NO TRANSLATION','NO TRANSLATION'],['STOP TRANSLATION','STOP TRANSLATION'],['THIS OUTPUT WAS NOT TRANSLATED AT ALL','THIS OUTPUT WAS NOT TRANSLATED AT ALL'],['MAPLE TRANSLATION','DIFFERENT TRANSLATION'],['MAPLE TRANSLATION HELLO','MAPLE TRANSLATION HELLO']]) {
 check(diagnoseTargetScripts([{id:'P0',text}],'th',[{id:'P0',text:source}])[0].decision==='reject','untranslated prose remains rejected');
}
for(const paid of [false,true]) for(const transition of ['model','language','edit','aba','revert','api-input-aba','endpoint-input']) {
 let finish;const handlers={};
 const state={desiredLang:'th',desiredAiModel:'A',promptSeq:0,aiPromptByLang:{},aiPromptDirtyByLang:{}};
 const prompt={value:'Original',addEventListener:(name,fn)=>{handlers[name]=fn;}};
 const els={aiPrompt:prompt,apiUrl:{value:'http://localhost:7860',addEventListener:(name,fn)=>{handlers['api:'+name]=fn;}},
   aiBaseUrl:{value:'https://provider.example',addEventListener:(name,fn)=>{handlers['endpoint:'+name]=fn;}},
   aiPaidModel:{addEventListener:(name,fn)=>{handlers.model=fn;}},lang:{value:'th'}};
 const saves=[];
 const controller=createPromptController({els,state,canUseAiUi:()=>true,fetchDefaultPrompt:()=>new Promise(r=>finish=r),
   setStorage:async()=>{},broadcast:()=>{},updatePromptCount:()=>{},setFieldMessage:()=>{},fieldMessageType:()=>'',
   keyForPrompt:(lang,model)=>`${paid?'paid':'manual'}:${model}:${lang}`,saveProfilePrompt:async(lang,text)=>saves.push([state.desiredAiModel,lang,text])});
 const pending=controller.resetForLang('th');
 if(transition==='model') state.desiredAiModel='B';
 if(transition==='language') state.desiredLang='en';
 if(transition==='edit') prompt.value='New custom';
 if(transition==='aba') {state.desiredAiModel='B';handlers.model();state.desiredAiModel='A';handlers.model();}
 if(transition==='revert') {prompt.value='New custom';handlers.input();prompt.value='Original';handlers.input();}
 if(transition==='api-input-aba') {els.apiUrl.value='http://localhost:7861';handlers['api:input']();els.apiUrl.value='http://localhost:7860';handlers['api:input']();}
 if(transition==='endpoint-input') {els.aiBaseUrl.value='https://other.example';handlers['endpoint:input']();}
 finish('Late default');await pending;
 check(saves.length===0,'stale reset blocked '+paid+' '+transition);
}
for(const paid of [false,true]) {
 let finish;const handlers={};
 const state={desiredLang:'th',desiredAiModel:'A',promptSeq:0,aiPromptByLang:{},aiPromptDirtyByLang:{}};
 const els={aiPrompt:{value:'Original',addEventListener:(name,fn)=>{handlers[name]=fn;}},
   aiPromptBack:{disabled:false},aiPromptForward:{disabled:true}};
 const key=`${paid?'paid':'manual'}:A:th`;
 const controller=createPromptController({els,state,setStorage:async()=>{},broadcast:()=>{},updatePromptCount:()=>{},
   keyForPrompt:(lang,model)=>`${paid?'paid':'manual'}:${model}:${lang}`,
   saveProfilePrompt:()=>new Promise(resolve=>finish=resolve)});
 const pending=controller.applyHistoryResult(key,{text:'Restored',canBack:false,canForward:true},'Original',0);
 els.aiPrompt.value='New draft';handlers.input();
 finish();await pending;
 check(els.aiPrompt.value==='New draft','late history save retains newer draft '+paid);
 check(!els.aiPromptBack.disabled&&els.aiPromptForward.disabled,'late history save retains newer history controls '+paid);
}
console.log(JSON.stringify({passed:true,checks,scope:'Real profile/pricing/language validators and delayed reset controller, synthetic UI/storage'}));
