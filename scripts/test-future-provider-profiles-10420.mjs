import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const roots=[new URL('../',import.meta.url),new URL('../../source/TextPhantom/',import.meta.url)];
const root=roots.find(candidate=>existsSync(new URL('src/shared/model-capabilities.js',candidate)));
assert(root,'Run this script from TextPhantom/scripts or the isolated e2e-work harness');
const m=path=>import(new URL(path,root));
const {cloudProviderCatalog}=await m('src/shared/ai/providers/cloud-registry.js');
const {localProviderCatalog,localAiPreset,canonicalLocalProviderId}=await m('src/shared/ai/providers/local-registry.js');
const {normalizeModelCapabilities}=await m('src/shared/model-capabilities.js');
const {resolveReasoningPreference}=await m('src/shared/reasoning-preference.js');
const {createAiProfiles,updateAiProfile,makeProviderIdentity,makeProfilePromptKey}=await m('src/shared/ai-profiles.js');
const {createAiProfileActivationController,resolveEffectiveAiProfile,buildEffectiveAiPayload}=await m('src/shared/ai-profile-activation.js');
const {paidEntry,putPaidEntry,PAID_PROFILE_KEY}=await m('src/shared/paid-profile.js');
const {getCanonicalPrompt}=await m('src/background/ai/prompt-cache.js');
const {translateWithLocalOpenAi}=await m('src/shared/ai/direct-local/generation.js');
const checks=[],wire=[],metadata=[];let failures=[];
const check=(name,value)=>{assert.ok(value,name);checks.push(name);};
const defaults={thinking:'minimum',tokenPolicy:{mode:'dynamic',maxOutputTokens:0},temperature:null,pageImage:'off',memoryMode:'off',styleExamples:true,concurrency:{mode:'auto',max:0},providerOptions:{},conversationReset:'0'};
const futureModels=['vendor/Futura-99-unknown','gpt-17-dream:Q4_K_M','NewFamily-2099-reasoner'];
const specs=[...cloudProviderCatalog().map(x=>({...x,runtime:'cloud'})),...localProviderCatalog().map(x=>({...x,runtime:'local'})),{id:'customlocal',runtime:'local',baseUrl:'http://localhost:9899/v1'}];
for(const spec of specs){
 let state=createAiProfiles();const a={runtime:spec.runtime,provider:spec.id,endpoint:spec.baseUrl,model:futureModels[0]},b={...a,model:futureModels[1]};
 state=updateAiProfile(state,{...a,defaults,patch:{thinking:'off',pageImage:'always',memoryMode:'full'},select:true,now:1});
 const identity=makeProviderIdentity(a.provider,a.endpoint);
 const prompts={[makeProfilePromptKey(identity,a.model,'th')]:{text:'CUSTOM_STYLE_'+spec.id,mode:'replace'}};
 const controller=createAiProfileActivationController({state,prompts,credentials:spec.runtime==='cloud'?{[identity]:'synthetic-key'}:{},defaults});
 const selected=controller.select(a,{language:'th'});const immutable=JSON.stringify(selected);
 const effective=resolveEffectiveAiProfile(selected);const payload=buildEffectiveAiPayload(effective);
 check(spec.id+' exact unfamiliar model identity retained',payload.ai.model===a.model);
 check(spec.id+' custom prompt/off/memory/image retained',payload.ai.prompt==='CUSTOM_STYLE_'+spec.id&&payload.ai.thinking==='off'&&payload.ai.memory_mode==='full'&&payload.ai.send_image===true);
 const newModel=resolveEffectiveAiProfile(controller.select(b,{language:'th'}));
 check(spec.id+' unseen model has its own Lowest/memory/image defaults',newModel.thinking==='minimum'&&newModel.memoryMode==='off'&&newModel.pageImage==='off'&&newModel.prompt==='');
 check(spec.id+' model discovery does not mutate an in-flight profile',JSON.stringify(selected)===immutable);
 check(spec.id+' route mode remains provider-based',payload.ai.translation_mode===(spec.runtime==='local'?'independent':'conversation'));
 check(spec.id+' sampling/outputfields not invented by profile projection',!Object.hasOwn(payload.ai,'temperature')&&!Object.hasOwn(payload.ai,'top_p')&&!Object.hasOwn(payload.ai,'max_tokens'));
}
let paidStore=putPaidEntry({},'https://api.example',futureModels[0],{profile:{thinking:'off',memoryMode:'terms',pageImage:'always'},prompts:{th:{text:'PAID_USER_STYLE',mode:'replace'}}});
const paidSettings={[PAID_PROFILE_KEY]:paidStore};const existing=paidEntry(paidSettings,'https://api.example',futureModels[0],'th');const unseen=paidEntry(paidSettings,'https://api.example',futureModels[1],'th');
check('Paid futuremodel preserves exact selected custom prompt/thinking/options',existing.profile.thinking==='off'&&existing.profile.memoryMode==='terms'&&existing.prompts.th.text==='PAID_USER_STYLE');
check('Paid futuremodel has separate Lowest defaults without modelslug heuristics',unseen.profile.thinking==='minimum'&&unseen.profile.memoryMode==='off'&&unseen.prompts.th.text!=='PAID_USER_STYLE');
check('Paid another API base does not inherit user style',paidEntry(paidSettings,'https://different.example',futureModels[0],'th').prompts.th.text!=='PAID_USER_STYLE');
for(const [alias,id] of Object.entries({'local':'ollama','llama.cpp':'llamacpp','llama-cpp':'llamacpp','lm-studio':'lmstudio','lm_studio':'lmstudio','lms':'lmstudio','jan.ai':'jan','text-generation-webui':'textgen','oobabooga':'textgen','ooba':'textgen','kobold':'koboldcpp','koboldai':'koboldcpp','gpt-4-all':'gpt4all','gpt-4all':'gpt4all'}))check('Frontend local alias '+alias,canonicalLocalProviderId(alias)===id);
const declared=normalizeModelCapabilities({supported_parameters:['temperature','max_completion_tokens','reasoning_effort','temperature']});
check('Future supportedparameter metadata survives normalization exactly',JSON.stringify(declared.supported_parameters)===JSON.stringify(['max_completion_tokens','reasoning_effort','temperature']));
check('Explicit empty supportedparameter metadata remains authoritative',JSON.stringify(normalizeModelCapabilities({supported_parameters:[]}).supported_parameters)==='[]');
check('Malformed supportedparameter metadata does not become authoritative',!Object.hasOwn(normalizeModelCapabilities({supported_parameters:['temperature',false]}),'supported_parameters'));
const originalFetch=globalThis.fetch;const plan=await getCanonicalPrompt('','th',{wantMemo:false});
try{
 for(const spec of localProviderCatalog())for(const model of futureModels){
  const calls=[];globalThis.fetch=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url:String(url),body});
   if(spec.id==='lmstudio')return Response.json({model_instance_id:model,output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],stats:{input_tokens:42,total_output_tokens:12}});
   const reply=spec.protocol==='ollama'?{message:{content:'<<TP_P0:สวัสดี>>'},done:true,done_reason:'stop',prompt_eval_count:42,eval_count:12}:{model,choices:[{finish_reason:'stop',message:{content:'<<TP_P0:สวัสดี>>'}}],usage:{prompt_tokens:42,completion_tokens:12,total_tokens:54}};
   return Response.json(reply);
  };
  const result=await translateWithLocalOpenAi([{id:'qa-unit',text:'Hello'}],{ai:{provider:spec.id,model,base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),prompt:'KEEP_USER_STYLE_EXACT',promptMode:'replace',thinking:'minimum',translation_mode:'independent',style_examples:true,independent_examples:{source:'human',pairs:[],scopeStatus:'document',storageStatus:'ready'},model_capabilities:{limits:{contextTokens:32768,maxOutputTokens:8192,source:'qa-runtime-metadata'},reasoning:{supported:null},structuredOutput:{supported:false}}},canonicalPrompt:plan,targetLang:'th',sourceLang:'en'});
  check(spec.id+'/'+model+' one synthetic dispatch with exact ID',calls.length===1&&calls[0].body.model===model);
  const body=calls[0].body,output=spec.id==='ollama'?body.options?.num_predict:spec.id==='lmstudio'?body.max_output_tokens:body.max_tokens;
  check(spec.id+'/'+model+' native outputfield and boundedtoken cap',Number.isSafeInteger(output)&&output>0&&output<=8192);
  check(spec.id+'/'+model+' does not invent cross-provider controls',!Object.hasOwn(body,'temperature')&&!Object.hasOwn(body,'top_p')&&!Object.hasOwn(body,'reasoning_effort')&&!Object.hasOwn(body,'think')/* 10488: unknown thinking metadata → provider default, Ollama included */&&!Object.hasOwn(body,'reasoning'));
  const system=spec.id==='lmstudio'?body.system_prompt:body.messages?.[0]?.content;
  check(spec.id+'/'+model+' usercustomstyle is exact and appears once',system.includes('KEEP_USER_STYLE_EXACT')&&system.split('KEEP_USER_STYLE_EXACT').length===2);
  check(spec.id+'/'+model+' translation completes with original unit identity',result.translations[0].id==='qa-unit'&&result.translations[0].text==='สวัสดี');
  wire.push({provider:spec.id,model,url:calls[0].url,keys:Object.keys(body),outputField:spec.id==='ollama'?'options.num_predict':spec.id==='lmstudio'?'max_output_tokens':'max_tokens',output,thinkingApplied:result.meta.thinkingApplied});
 }
}finally{globalThis.fetch=originalFetch;}
for(const capability of [{supported:true,mandatory:true,control:'levels',supported_efforts:['low','high'],minimum_unresolved:true},{supported:true,control:'provider',can_disable:true},{supported:true,control:'levels',supported_efforts:['low','high'],mandatory:true,minimum_unresolved:true,source:'native-api'}]){
 const normalized=normalizeModelCapabilities({reasoning:capability}).reasoning;const before=resolveReasoningPreference('minimum',capability),after=resolveReasoningPreference('minimum',normalized);metadata.push({capability,normalized,before,after});
 if(before!==after)failures.push({name:'Saved capability metadata changes Lowest resolution',before,after});
}
const report={passed:failures.length===0,scope:'19 nativeAPIfrontendprofile paths (9Cloud+9Local+Paid), plus CustomLocal extra; 27 mockedDirectLocal futuremodel dispatches. Cloud nativepayloads belongtoAPI, no live calls.',checks:checks.length,checkNames:checks,wire,metadata,failures};if(process.env.TP_QA_REPORT_DIR){const out=pathToFileURL(resolve(process.env.TP_QA_REPORT_DIR)+'/');mkdirSync(out,{recursive:true});writeFileSync(new URL('report.json',out),JSON.stringify(report,null,2));}console.log(JSON.stringify({passed:report.passed,checks:checks.length,mockedNativeCalls:wire.length,failures}));if(failures.length)process.exitCode=1;
