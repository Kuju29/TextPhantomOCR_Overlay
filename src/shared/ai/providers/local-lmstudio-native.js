// LM Studio native chat is the reviewed path for its model identity and
// reasoning control. It retains the shared translation/prompt contract while
// adapting the native SSE envelope to the normal Direct Local reader.
import { createOpenAiCompatibleAdapter, LOCAL_CONTEXT_METADATA_MAX } from './local-openai-compatible.js';
import { localOpenAiBase } from '../direct-local/endpoint.js';
import { LocalAiError } from '../direct-local/error.js';
import { localProviderUsage } from '../usage-values.js';
import { dispatchProviderRequest } from './local-transport-runtime.js';

const safeName = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
// CPU-only local models may spend minutes loading or processing a prompt.
// Bound genuinely stuck requests without using the much shorter cloud limit.
export const LMSTUDIO_REQUEST_TIMEOUT_MS = 30 * 60_000;
export const LMSTUDIO_TERMINAL_GRACE_MS = 60_000;
function modelMismatch(requested, actual) {
  const error = new LocalAiError(`LM Studio returned ${safeName(actual) || 'no model identity'} instead of ${safeName(requested)}. Load and select the same model in LM Studio.`, {
    code:'local_model_identity_mismatch', attempted:true, retryable:false,
    diagnostics:{validatorSubtype:'provider_model_mismatch',requestedModel:safeName(requested),reportedModel:safeName(actual)},
  });
  error.providerResponded = true;
  throw error;
}
function assertModel(data, requested) {
  if (data?.type && data.type !== 'chat.start' && data.type !== 'chat.end') return;
  const actual = String(data?.model_instance_id || data?.result?.model_instance_id || '').trim();
  if (!actual || actual !== String(requested || '').trim()) modelMismatch(requested,actual);
}
function assertStatelessReply(data, requested) {
  assertModel(data, requested);
  if (data?.type && data.type !== 'chat.end') return;
  const result = data?.type === 'chat.end' ? data.result : data?.result || data;
  if (result && typeof result === 'object' &&
      Object.hasOwn(result, 'response_id') && result.response_id !== null) {
    const error = new LocalAiError('LM Studio returned a stored response ID despite store:false', {
      code:'local_provider_response_contract',attempted:true,retryable:false,
      diagnostics:{validatorSubtype:'unexpected_stateless_response_id'},
    });
    error.providerResponded = true;
    throw error;
  }
}
function contentOf(result, type) {
  return (Array.isArray(result?.output) ? result.output : [])
    .filter(row => row?.type === type).map(row => String(row.content || '')).join('');
}
function nativeUsage(result) {
  const stats = result?.stats || {};
  const input = stats.input_tokens, output = stats.total_output_tokens;
  return localProviderUsage({usage:{
    ...(Number.isSafeInteger(input)&&input>=0 ? {prompt_tokens:input}:{}),
    ...(Number.isSafeInteger(output)&&output>=0 ? {completion_tokens:output}:{}),
    ...(Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0 ? {total_tokens:input+output}:{}),
    ...(Number.isSafeInteger(stats.reasoning_output_tokens)&&stats.reasoning_output_tokens>=0
      ? {completion_tokens_details:{reasoning_tokens:stats.reasoning_output_tokens}}:{}),
  }},'openai');
}
export function normalizeLmStudioNativeLine(line) {
  let value=String(line || '').trim();
  if (!value || value.startsWith(':') || /^(?:event|id|retry):/.test(value)) return {kind:'empty'};
  if (!value.startsWith('data:')) return {kind:'malformed',subtype:'sse_non_data_line',chars:value.length};
  value=value.slice(5).trim();
  let item;
  try {item=JSON.parse(value);} catch {return {kind:'malformed',subtype:'invalid_sse_json',chars:value.length};}
  if (item?.type==='error') return {kind:'provider_error',code:safeName(item.error?.code||item.error?.type||'native_stream_error')};
  if (item?.type==='message.delta') return {kind:'data',item,content:String(item.content||'')};
  if (item?.type==='reasoning.delta') return {kind:'data',item,reasoning:String(item.content||'')};
  if (item?.type==='chat.end') return {kind:'data',item,providerDone:true};
  if (item?.type==='chat.start') return {kind:'data',item};
  // Other documented native events (model load / prompt progress) carry no
  // translated content. Unknown event types cannot be treated as successful.
  return {kind:'empty'};
}

export function createLmStudioNativeAdapter(settings={}) {
  const compat=createOpenAiCompatibleAdapter(settings);
  const base=localOpenAiBase(settings.baseUrl || '');
  if (!base.endsWith('/v1') || (settings.chatPath && settings.chatPath!=='/chat/completions'))
    throw new LocalAiError('LM Studio native chat requires a /v1 server URL and the default chat path',
      {code:'invalid_local_endpoint',attempted:false});
  const adapter={...compat,
    id:'lmstudio_native',streamMode:'lmstudio_native_sse',
    defaultTimeoutMs:LMSTUDIO_REQUEST_TIMEOUT_MS,
    // Complete translation records do not replace chat.end: it owns the
    // authoritative model identity and token usage. If LM Studio never sends
    // that event, stop waiting and report a protocol error instead of keeping
    // this Local AI lane busy indefinitely.
    drainGraceMs:LMSTUDIO_TERMINAL_GRACE_MS,recordsDrainStatus:true,
    drainCancelReason:'textphantom_missing_provider_terminal',
    shouldDrainAfterCompletion:providerDone=>!providerDone,
    requestUrl:()=>`${base.slice(0,-3)}/api/v1/chat`,
    payload:({model,messages,outputTokens,thinkingMode,thinkingCapability,responseSchema,
      providerConversation=null,contextTokens=null})=>{
      if(responseSchema) throw new LocalAiError('LM Studio native chat does not accept this structured-output contract',
        {code:'local_provider_response_contract',attempted:false});
      const stateful=providerConversation?.enabled===true;
      const previous=String(providerConversation?.previousResponseId||'');
      const historyTurns=Number(providerConversation?.historyTurns||0);
      const validHistory=stateful && Number.isSafeInteger(historyTurns) && historyTurns>=0 &&
        messages?.length===2+historyTurns*2 &&
        messages.slice(1,-1).every((message,index)=>message?.role===(index%2?'assistant':'user'));
      if (!Array.isArray(messages) || messages[0]?.role!=='system' || messages.at(-1)?.role!=='user' ||
          (stateful ? !validHistory || (historyTurns>0)!==Boolean(previous) ||
            Boolean(previous) && !/^resp_[A-Za-z0-9_-]{1,256}$/.test(previous) :
            messages.length!==2 || Boolean(previous)))
        throw new LocalAiError('LM Studio conversation history is not linked to a verified provider response',
          {code:'local_provider_response_contract',attempted:false});
      const user=messages.at(-1).content;
      const input=typeof user==='string' ? user : Array.isArray(user) ? user.map(part =>
        part?.type==='text' ? {type:'text',content:String(part.text||'')} :
        part?.type==='image_url' && typeof part.image_url?.url==='string'
          ? {type:'image',data_url:part.image_url.url} : null) : null;
      if (input==null || Array.isArray(input)&&input.some(part=>part===null))
        throw new LocalAiError('LM Studio native chat cannot encode this prompt',
          {code:'local_provider_response_contract',attempted:false});
      const body={model,input,stream:true,store:stateful,max_output_tokens:outputTokens};
      if(contextTokens!==null) {
        if(!Number.isSafeInteger(contextTokens)||contextTokens<=0||
            contextTokens>LOCAL_CONTEXT_METADATA_MAX)
          throw new LocalAiError('LM Studio JIT context request is not bounded',
            {code:'local_provider_response_contract',attempted:false});
        body.context_length=contextTokens;
      }
      if(previous) body.previous_response_id=previous;
      else body.system_prompt=String(messages[0].content||'');
      if(thinkingMode!=='default' && !(thinkingMode==='off'&&thinkingCapability?.supported===false)) {
        const supported=thinkingCapability?.supported_efforts;
        if (thinkingMode==='off'&&thinkingCapability?.mandatory===true ||
            !Array.isArray(supported) || !supported.includes(thinkingMode) ||
            !['off','on','low','medium','high'].includes(thinkingMode))
          throw new LocalAiError('LM Studio cannot verify the selected Thinking mode for this model',
            {code:'local_model_thinking_unsupported',attempted:false});
        body.reasoning=thinkingMode;
      }
      return body;
    },
    thinkingApplied:(mode,{payload,reasoning})=>mode==='off'&&reasoning?.supported===false
      ?'not_applicable_non_reasoning_model':payload?.reasoning===mode?`requested_${mode}`:'unverified',
    normalizeLine:normalizeLmStudioNativeLine,
    assertResponseModel:assertModel,
    emptyEnvelope:()=>({reasoningDeltaObserved:false}),
    // Keep only a boolean. A reasoning.delta event still proves that the
    // provider ignored Off when its content is empty or token stats are absent.
    mergeEnvelope:(target,item)=>{
      if(item.type==='reasoning.delta')target.reasoningDeltaObserved=true;
      if(item.type==='chat.end')target.result=item.result;
    },
    finalizeEnvelope:(value,content)=>({ ...value.result,
      reasoningDeltaObserved:value.reasoningDeltaObserved===true,
      // Keep the exact streamed text for incremental page projection. The
      // authoritative end event owns usage and model identity.
      output:Array.isArray(value.result?.output) ? value.result.output : [],
      streamedContent:content }),
    terminalCompleted:({providerDone})=>providerDone,
    finishReason:(data,maxOutput)=>data?.model_instance_id
      ? Number.isSafeInteger(data?.stats?.total_output_tokens) &&
          Number.isSafeInteger(maxOutput) && data.stats.total_output_tokens>=maxOutput
        ? 'length' : 'stop' : 'unknown',
    responseText:data=>contentOf(data,'message') || String(data?.streamedContent||''),
    responseReasoning:data=>contentOf(data,'reasoning'),
    usage:nativeUsage,
    timing:data=>({loadMs:Number.isFinite(data?.stats?.model_load_time_seconds)?
      Math.round(data.stats.model_load_time_seconds*1000):null,
      promptEvalMs:null,evalMs:null,
      tokensPerSecond:Number.isFinite(data?.stats?.tokens_per_second)?data.stats.tokens_per_second:null}),
  };
  // A single native adapter may serve concurrent requests. Bind response
  // validation to this request's store policy without mutable shared state.
  adapter.generate=(request,context)=>dispatchProviderRequest(
    request.providerConversation?.enabled===true ? adapter :
      {...adapter,assertResponseModel:assertStatelessReply},request,context);
  return adapter;
}
