"""Offline regression: preserve upstream status and same-model router policy."""
import sys, pathlib
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'api'))
import httpx
from backend.ai.clients.provider_error import safe_http_error, http_error_evidence, ProviderTransportError
from backend.ai.failure_reason import provider_http_failure, is_rate_limited
from backend.ai.providers.cloud_openrouter import _apply_official_routing
from backend.ai.wire_trace import _safe_response_meta
providers=['gemini','openai','openrouter','anthropic','groq','deepseek','together','huggingface','featherless',
           'ollama','lmstudio','jan','textgen','koboldcpp','vllm','llamafile','gpt4all','llamacpp','customlocal']
cases=0
for provider in providers:
    for status in [400,401,402,403,404,413,429,500,503,504]:
        response=httpx.Response(status,request=httpx.Request('POST','https://fixture.invalid/chat'),
            json={'error':{'code':status,'message':'fixture model-429 is overloaded; no private text'}},
            headers={'Retry-After':'7'})
        error=safe_http_error(provider,response,'model-429')
        assert is_rate_limited(error)==(status==429),(provider,status)
        assert (provider_http_failure(error).code=='provider_rate_limited')==(status==429)
        cases+=1
response=httpx.Response(429,request=httpx.Request('POST','https://fixture.invalid/chat'),headers={'retry-after':'7'},
    json={'error':{'code':429,'message':'Provider returned error','metadata':{
        'provider_name':'Example Vendor','error_type':'rate_limit_exceeded','raw':'PRIVATE PROMPT sk-testsecret123'}}})
error=safe_http_error('openrouter',response,'chosen-model')
evidence=_safe_response_meta(http_error_evidence(error,streamed=True))
assert evidence['status']==429 and evidence['retryAfterMs']==7000
assert evidence['providerType']=='rate_limit_exceeded' and evidence['upstreamProvider']=='Example Vendor'
assert 'PRIVATE' not in str(evidence) and 'raw' not in evidence and 'sk-testsecret123' not in str(error)
assert 'upstreamProvider' not in _safe_response_meta({'status':429,'upstreamProvider':'Bearer sk-secret123456','raw':'PRIVATE'})
assert _safe_response_meta({'status':503,'streamed':False,'providerCode':'','retryAfterMs':None}) == {'status':503,'streamed':False,'bodyStored':False}
assert not is_rate_limited(ProviderTransportError('timeout model-429',provider='fixture',model='model-429'))
url='https://openrouter.ai/api/v1/chat/completions'
payload={'model':'chosen-model','messages':[{'role':'user','content':'source'}]}
# Signature is kept concrete: the policy belongs only to OpenRouter.
result=_apply_official_routing(payload,url)
assert result['provider']['allow_fallbacks'] is True and result['model']=='chosen-model'
explicit={**payload,'provider':{'allow_fallbacks':False,'only':['Example Vendor']}}
assert _apply_official_routing(explicit,url)['provider']['allow_fallbacks'] is False
assert _apply_official_routing(payload,'https://another.invalid/v1/chat/completions')==payload
assert 'provider' not in payload
print(f'Provider rate evidence: {cases} HTTP/provider cases; safe metadata and same-model routing passed')
