import assert from 'node:assert/strict';
import { getCanonicalPrompt } from '../src/background/ai/prompt-cache.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { appendPreparedMessages } from '../src/shared/ai/conversation/prompt.js';
import { localAiPreset, localProviderCatalog, localProviderContinuationStrategy } from '../src/shared/ai/providers/local-registry.js';
import { SCHEMA_OBJECT_CONTRACT } from '../src/shared/ai/direct-local/output-contract.js';

const plan=await getCanonicalPrompt('', 'th', {wantMemo:false});
const originalFetch=globalThis.fetch;
const calls=[];
function conversationContext(){
  return {
    async prepare(input){
      return {current:'<<I2_P0:CURRENT_SOURCE>>',history:[
        {role:'user',text:'ANCHOR_ONCE\n<<I1_P0:A_SOURCE>>',imageDataUri:''},
        {role:'assistant',text:'<<I1_P0:B_ANSWER>>'},
      ],layout:input.layout,evidence:{prefixSha256:'matrix-prefix'},origins:[],image:''};
    },
    messages:appendPreparedMessages,
    capture(){},
  };
}
function response(spec, text){
  const body=spec.protocol==='ollama'
    ? {message:{role:'assistant',content:text},done:true,done_reason:'stop',prompt_eval_count:23,eval_count:7}
    : {choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:23,completion_tokens:7,total_tokens:30}};
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
}
function noSchema(spec,body){
  assert.equal(body.format,undefined,`${spec.id}: Conversation must not use Ollama format schema`);
  assert.equal(body.response_format,undefined,`${spec.id}: Conversation must not use OpenAI response_format schema`);
}
const capabilityCases=[
  ['plain',{structuredOutput:{supported:false,contract:SCHEMA_OBJECT_CONTRACT,source:'matrix'},reasoning:{supported:false,control:'none'}},'off'],
  ['structured',{structuredOutput:{supported:true,contract:SCHEMA_OBJECT_CONTRACT,source:'matrix'},reasoning:{supported:false,control:'none'}},'off'],
  ['optional-thinking',{structuredOutput:{supported:true,contract:SCHEMA_OBJECT_CONTRACT,source:'matrix'},reasoning:{supported:true,mandatory:false,control:'boolean'}},'off'],
  ['mandatory-levels',{structuredOutput:{supported:true,contract:SCHEMA_OBJECT_CONTRACT,source:'matrix'},reasoning:{supported:true,mandatory:true,control:'levels',supported_efforts:['low']}},'minimum'],
];
let conversationCases=0, independentCases=0;
try{
  for(const spec of localProviderCatalog()){
    // The native LM Studio route has its own Independent-only HTTP fixture.
    if(spec.id==='lmstudio') continue;
    assert.equal(localProviderContinuationStrategy(spec.id),'message_replay',
      `${spec.id}: explicit low-level Conversation uses replay for this endpoint`);
    for(const [label,caps,thinking] of capabilityCases){
      calls.length=0;
      globalThis.fetch=async(url,init)=>{
        const body=JSON.parse(init.body);calls.push({url:String(url),body});
        return response(spec,'<<I2_P0:ไทย>>');
      };
      const result=await translateWithLocalOpenAi([{id:'I2_P0',text:'CURRENT_SOURCE'}],{
        ai:{provider:spec.id,model:'matrix-model',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
          prompt:'',translation_mode:'conversation',style_examples:true,
          // OpenAI-compatible model lists cannot prove a Thinking mode. The
          // provider-managed option is explicit here; Off requires evidence.
          thinking:spec.protocol==='openai'?'default':thinking,
          model_capabilities:caps},
        canonicalPrompt:plan,targetLang:'th',sourceLang:'en',conversationContext:conversationContext(),
      });
      assert.equal(calls.length,1,`${spec.id}/${label}: exactly one provider generation`);
      const body=calls[0].body;noSchema(spec,body);
      assert.equal(body.previous_response_id,undefined,`${spec.id}: no native thread cursor is sent`);
      assert.equal(body.store,undefined,`${spec.id}: no unrelated LM Studio store flag is sent`);
      assert.deepEqual(body.messages.map(m=>m.role),['system','user','assistant','user'],`${spec.id}/${label}: native chat history roles`);
      assert.equal(body.messages[1].content,'ANCHOR_ONCE\n<<I1_P0:A_SOURCE>>');
      assert.equal(body.messages[2].content,'<<I1_P0:B_ANSWER>>');
      assert.equal(body.messages[3].content,'<<I2_P0:CURRENT_SOURCE>>');
      assert.equal(body.messages[3].content.includes('H01\nEN:'),false,`${spec.id}/${label}: continuation current User is OCR-only`);
      assert.equal(result.translations[0].id,'I2_P0');
      assert.equal(result.translations[0].text,'ไทย');
      if(spec.id==='ollama'){
        if(label==='optional-thinking') assert.equal(body.think,false,'Ollama verified boolean Off is representable');
        if(label==='mandatory-levels') assert.equal(body.think,'low','Lowest available resolves to the verified minimum effort');
      }else{
        assert.equal(body.think,undefined,`${spec.id}: must not guess Ollama think field`);
        assert.equal(body.reasoning,undefined,`${spec.id}: generic local OpenAI adapter must not guess reasoning`);
        assert.equal(body.reasoning_effort,undefined,`${spec.id}: generic local OpenAI adapter must not guess reasoning_effort`);
      }
      conversationCases++;
    }

    if(spec.id==='ollama'){
      calls.length=0;
      const mandatory={supported:true,mandatory:true,control:'levels',supported_efforts:['low']};
      await assert.rejects(translateWithLocalOpenAi([{id:'I2_P0',text:'CURRENT_SOURCE'}],{
        ai:{provider:spec.id,model:'matrix-model',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
          prompt:'',translation_mode:'conversation',thinking:'off',
          model_capabilities:{structuredOutput:{supported:false},reasoning:mandatory}},
        canonicalPrompt:plan,targetLang:'th',sourceLang:'en',conversationContext:conversationContext(),
      }),error=>error.code==='local_model_thinking_unsupported' && error.requestDispatched===false);
      assert.equal(calls.length,0,'explicit Off on mandatory reasoning must stop before a generation');
    }
    if(spec.protocol==='openai'){
      for(const [choice,reasoning] of [
        ['off',{supported:true,mandatory:false,control:'boolean'}],
        ['off',{supported:false,control:'none',source:'unverified_model_list'}],
        ['on',{supported:true,control:'boolean'}],
        ['low',{supported:true,mandatory:true,control:'levels',supported_efforts:['high']}],
      ]){
        calls.length=0;
        await assert.rejects(translateWithLocalOpenAi([{id:'I2_P0',text:'CURRENT_SOURCE'}],{
          ai:{provider:spec.id,model:'matrix-model',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
            prompt:'',translation_mode:'conversation',thinking:choice,
            model_capabilities:{structuredOutput:{supported:false},reasoning}},
          canonicalPrompt:plan,targetLang:'th',sourceLang:'en',conversationContext:conversationContext(),
        }),error=>error.code==='local_model_thinking_unsupported' && error.requestDispatched===false);
        assert.equal(calls.length,0,`${spec.id}: ${choice} without an exact native control must stop before provider dispatch`);
      }
      calls.length=0;
      globalThis.fetch=async(url,init)=>{
        calls.push({url:String(url),body:JSON.parse(init.body)});
        return response(spec,'<<I2_P0:ไทย>>');
      };
      const unknownLowest=await translateWithLocalOpenAi([{id:'I2_P0',text:'CURRENT_SOURCE'}],{
        ai:{provider:spec.id,model:'matrix-model',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
          prompt:'',translation_mode:'conversation',thinking:'minimum',
          model_capabilities:{structuredOutput:{supported:false},reasoning:{supported:null,source:'openai_model_list'}}},
        canonicalPrompt:plan,targetLang:'th',sourceLang:'en',conversationContext:conversationContext(),
      });
      assert.equal(calls.length,1,`${spec.id}: unknown Lowest dispatches one real request`);
      assert.equal(calls[0].body.reasoning,undefined,`${spec.id}: no invented reasoning field`);
      assert.equal(unknownLowest.meta.thinkingApplied,'provider_managed_unverified');
    }

    // Frozen Independent reference: schema-capable behavior remains unchanged.
    calls.length=0;
    globalThis.fetch=async(url,init)=>{
      const body=JSON.parse(init.body);calls.push({url:String(url),body});
      return response(spec,JSON.stringify({P0:'ไทย'}));
    };
    const independent=await translateWithLocalOpenAi([{id:'original-id',text:'SOURCE'}],{
      ai:{provider:spec.id,model:'matrix-model',base_url:spec.baseUrl,local_adapter:localAiPreset(spec.id),
        prompt:'',translation_mode:'independent',style_examples:true,
        independent_examples:{source:'human',pairs:[],scopeStatus:'legacy_unscoped'},
        thinking:spec.protocol==='openai'?'default':'off',model_capabilities:{
          structuredOutput:{supported:true,contract:SCHEMA_OBJECT_CONTRACT,source:'matrix'},reasoning:{supported:false,control:'none'}
        }},canonicalPrompt:plan,targetLang:'th',sourceLang:'en',
    });
    const body=calls[0].body;
    if(spec.protocol==='ollama') assert.ok(body.format && body.format.type==='object',`${spec.id}: frozen Independent keeps native schema`);
    else assert.equal(body.response_format?.type,'json_schema',`${spec.id}: frozen Independent keeps native schema`);
    assert.equal(independent.translations[0].id,'original-id');
    assert.equal(independent.translations[0].text,'ไทย');
    independentCases++;
  }
}finally{globalThis.fetch=originalFetch;}
console.log(`PASS ${conversationCases} Direct Local Conversation capability cases across compatible runtime adapters; I#_P# marker-only + OCR-only continuation`);
console.log(`PASS ${independentCases} OpenAI-compatible/Ollama Independent schema cases; native LM Studio is covered by test-lmstudio-models-and-examples`);
