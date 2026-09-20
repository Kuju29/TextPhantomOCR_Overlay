"""Conversation provider/model capability matrix, independent of production log coverage.

Exercises every registered API adapter under representative capability classes.
This is a mocked native provider boundary: it verifies TextPhantom request shape,
not live third-party service availability.
"""
from __future__ import annotations

import copy, runpy, sys
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
h=runpy.run_path(str(ROOT/'scripts/test-api-provider-boundary-matrix.py'),run_name='capability_helpers')
registry=list(h['compose_providers'](h['ProviderRegistry']()))
Client=h['BoundaryClient'];Response=h['Response'];gemini=h['cloud_gemini'];anthropic=h['cloud_anthropic']
GenerationRequest=h['GenerationRequest']

prior=(
    {'role':'user','text':'ANCHOR_ONCE\n<<I1_P0:A_SOURCE>>'},
    {'role':'assistant','text':'<<I1_P0:B_ANSWER>>'},
)
CURRENT='<<I2_P0:C_SOURCE>>'

SCENARIOS=(
    ('unknown_plain',{},'off'),
    ('structured_capable',{'structured_output':{'supported':True,'strict':True,'source':'matrix'}},'off'),
    ('optional_reasoning_off',{'reasoning':{'supported':True,'mandatory':False,'control':'levels','supported_efforts':['none','low']}},'off'),
    ('mandatory_reasoning',{'reasoning':{'supported':True,'mandatory':True,'default_enabled':True,'control':'provider','supported_efforts':['low'],'supports_max_tokens':True}},'on'),
    ('structured_mandatory_reasoning',{
        'structured_output':{'supported':True,'strict':True,'source':'matrix'},
        'reasoning':{'supported':True,'mandatory':True,'default_enabled':True,'control':'provider','supported_efforts':['low'],'supports_max_tokens':True},
    },'on'),
)

def dispatch(spec, request):
    captured=[];Client.calls=[]
    def gpost(*args,**kw):
        captured.append(args[2])
        return Response({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':'<<I2_P0:ไทย>>'}]}}],
                         'usageMetadata':{'promptTokenCount':23,'candidatesTokenCount':7,'totalTokenCount':30}})
    def apost(*args,**kw):
        captured.append(kw['json'])
        return Response({'content':[{'type':'text','text':'<<I2_P0:ไทย>>'}],
                         'stop_reason':'end_turn','usage':{'input_tokens':23,'output_tokens':7}})
    with ExitStack() as stack:
        stack.enter_context(patch.object(h['openai_chat'].httpx,'Client',Client))
        stack.enter_context(patch.object(gemini,'_post_once',side_effect=gpost))
        stack.enter_context(patch.object(anthropic,'post_json',side_effect=apost))
        result=spec.adapter.generate(request)
    captured += [x['json'] for x in Client.calls]
    assert len(captured)==1,(spec.provider_id,len(captured))
    return captured[0],result

def native_messages(payload):
    return payload.get('messages',payload.get('contents'))

def assert_no_conversation_schema(provider,payload):
    # Conversation owns I#_P# markers. Native JSON schema metadata is request-
    # varying and must remain absent even when the selected model supports it.
    assert 'response_format' not in payload,(provider,'response_format')
    assert 'output_config' not in payload,(provider,'output_config')
    assert 'format' not in payload,(provider,'format')
    cfg=payload.get('generationConfig') or {}
    assert 'responseSchema' not in cfg,(provider,'responseSchema')
    assert 'responseFormat' not in cfg,(provider,'responseFormat')
    assert cfg.get('responseMimeType') != 'application/json',(provider,'json_mime')

count=0
for spec in registry:
    for scenario,caps,thinking in SCENARIOS:
        req=GenerationRequest(
            provider=spec.provider_id,model=spec.default_model,api_key='fixture',
            base_url=spec.default_base_url,system_text='SYSTEM_FIXED',
            user_parts=(CURRENT,),unit_count=1,expected_ids=('I2_P0',),
            thinking=thinking,history_messages=prior,model_capabilities=copy.deepcopy(caps),
            # Deliberately no response_schema: Conversation must stay marker-only.
            response_schema=None,
        )
        payload,_=dispatch(spec,req)
        native=native_messages(payload)
        assert native is not None,(spec.provider_id,scenario)
        roles=[m['role'] for m in native]
        if spec.provider_id=='gemini': expected=['user','model','user']
        elif spec.provider_id=='anthropic': expected=['user','assistant','user']
        else: expected=['system','user','assistant','user']
        assert roles==expected,(spec.provider_id,scenario,roles)
        flat=str(native)
        for needle,n in [('I1_P0',2),('I2_P0',1),('A_SOURCE',1),('B_ANSWER',1),('C_SOURCE',1)]:
            assert flat.count(needle)==n,(spec.provider_id,scenario,needle,flat)
        assert_no_conversation_schema(spec.provider_id,payload)
        for forbidden in ('previous_response_id','conversation_id'):
            assert forbidden not in payload,(spec.provider_id,scenario,forbidden)
        assert 'session_id' not in payload,(spec.provider_id,scenario,'app-global sticky session must not be injected')
        count+=1

# Provider-specific controls: use exact capability evidence only, never model-name
# guesses that can make another model on the same provider unusable.
from backend.ai.providers import cloud_deepseek, cloud_openrouter, cloud_huggingface, cloud_openai, cloud_gemini
base=lambda provider,model,caps,thinking='off': GenerationRequest(
    provider=provider,model=model,api_key='fixture',base_url='https://example.invalid/v1',
    system_text='SYSTEM_FIXED',user_parts=(CURRENT,),unit_count=1,expected_ids=('I2_P0',),
    thinking=thinking,history_messages=prior,model_capabilities=caps,response_schema=None)

# DeepSeek: future/unverified model receives no native thinking field; exact
# capability metadata is required before the leaf emits DeepSeek controls.
p=cloud_deepseek.build_payload(base('deepseek','future-chat',{},'off'),'future-chat',cloud_deepseek.POLICY)
assert 'thinking' not in p
p=cloud_deepseek.build_payload(base('deepseek','deepseek-v4-flash',{'reasoning':{'supported':True,'control':'toggle'}},'off'),'deepseek-v4-flash',cloud_deepseek.POLICY)
# build_payload is neutral; the leaf owns its verified thinking insertion. Cover it
# through the all-adapter matrix above and direct helper predicate here.
assert cloud_deepseek._verified_reasoning({'reasoning':{'supported':True,'control':'toggle'}})
assert cloud_deepseek._verified_reasoning({'reasoning':{'supported':True,'control':'levels','supported_efforts':['none','low']}})
assert not cloud_deepseek._verified_reasoning({'reasoning':{'supported':True,'control':'provider'}})

# OpenRouter mandatory reasoning must remain dispatchable even when user default is
# Off (invocation resolves mandatory to On); bounded native control is used when
# catalogue evidence provides one.
orq=base('openrouter','vendor/reasoner',{'reasoning':{'supported':True,'mandatory':True,'control':'toggle','supports_max_tokens':True}},'on')
op=cloud_openrouter.prepare_payload(orq)
assert 'max_completion_tokens' in op and 'temperature' not in op
assert op.get('reasoning',{}).get('max_tokens',0)>0

# HF/OpenAI level controls are sent only when exact metadata exposes those levels.
hreq=base('huggingface','vendor/reasoner',{'reasoning':{'supported':True,'control':'levels','supported_efforts':['none','low']}},'off')
assert cloud_huggingface._accepted_reasoning_effort(hreq)=='none'
hreq_unknown=replace(hreq,model_capabilities={})
assert cloud_huggingface._accepted_reasoning_effort(hreq_unknown) is None
oreq=base('openai','gpt-5.6-luna',{'reasoning':{'supported':True,'control':'levels','supported_efforts':['none','low']}},'off')
assert cloud_openai._verified_reasoning_mapping(oreq)[0]=='none'
assert cloud_openai._verified_reasoning_mapping(replace(oreq,model_capabilities={}))[0] is None

# Future/provider-managed Gemini metadata never invents a thinkingConfig or
# assume that a generic stale On maps to an active native mode. Provider default
# owns the behavior until exact levels/toggle metadata exists.
active,cfg,applied=cloud_gemini._thinking_state('gemini-future-x','on',{'reasoning':{'supported':True,'control':'provider'}})
assert active is False and cfg is None and applied=='provider_default_capability'

print(f'PASS {count} provider/model capability cases across {len(registry)} API adapters; Conversation stays I#_P# marker-only with native history roles')
