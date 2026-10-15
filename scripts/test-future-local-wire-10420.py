"""Read-only local/future model wire regression: metadata owns controls, not names."""
import json
from pathlib import Path
import sys
from dataclasses import replace
from unittest.mock import patch
import httpx
import pytest
def _project_root():
    for parent in Path(__file__).resolve().parents:
        for candidate in (parent, parent/'TextPhantom', parent/'source'/'TextPhantom'):
            if (candidate/'api/backend/ai/provider_bootstrap.py').is_file():
                return candidate
    raise RuntimeError('Place this fixture under TextPhantom/scripts or in the workspace')
PROJECT=_project_root();sys.path.insert(0,str(PROJECT/'api'))
from backend.ai.provider_bootstrap import ensure_provider_registry
from backend.ai.provider_contract import GenerationRequest
from backend.ai.clients.base import ChatResult
from backend.ai.providers import local_openai_runtime,local_lmstudio,local_ollama
from backend.ai.translation_paths.store import ConversationError
from backend.ai.workload import WorkloadBudgetError
from backend.ai.reasoning_preference import resolve_reasoning_preference
REG=ensure_provider_registry();GENERIC=['jan','textgen','koboldcpp','vllm','llamafile','gpt4all','llamacpp']
FUTURE=['future-model-99','openai-gpt-unknown-2040','qwen-oss-reasoner-new']
STYLE='QA_STYLE_UNCHANGED: preserve the original names.'
SOURCE='<<TP_P0:OCR_ONLY_SOURCE>>'
def req(provider,model,**kw):
    return GenerationRequest(provider=provider,model=model,base_url='http://127.0.0.1:23456/v1',system_text=STYLE,user_parts=(SOURCE,),source_unit_texts=('OCR_ONLY_SOURCE',),expected_ids=('P0',),unit_count=1,thinking='default',cache_context={'thinkingRequested':'minimum'},**kw)

@pytest.mark.parametrize('provider',GENERIC)
@pytest.mark.parametrize('model',FUTURE)
def test_future_generic_slug_cannot_invent_optional_controls(provider,model):
    payload=REG.require(provider).adapter.prepare_payload(req(provider,model,model_capabilities={'limits':{'contextTokens':4096,'maxOutputTokens':96}}))
    assert payload['model']==model
    assert payload['messages']==[{'role':'system','content':STYLE},{'role':'user','content':SOURCE}]
    assert payload['max_tokens']==96
    assert not ({'temperature','provider','reasoning','think','reasoning_effort','cache_control'} & payload.keys())

@pytest.mark.parametrize('provider',GENERIC)
def test_known_input_limit_stops_before_any_transport(provider):
    with patch.object(local_openai_runtime,'execute_chat_completion') as gen:
        with pytest.raises(WorkloadBudgetError):REG.require(provider).adapter.prepare_payload(req(provider,FUTURE[0],model_capabilities={'limits':{'maxInputTokens':1}}))
        gen.assert_not_called()

@pytest.mark.parametrize('provider',GENERIC)
@pytest.mark.parametrize('preference',['minimum','off','high'])
def test_generic_runtime_dispatch_has_no_provider_family_guess(provider,preference):
    model=FUTURE[2];adapter=REG.require(provider).adapter;real=httpx.Client;gets=[]
    def metadata(request):
        gets.append(request.url.path)
        assert request.method=='GET' and request.url.host=='127.0.0.1'
        if request.url.path=='/api/extra/true_max_context_length':return httpx.Response(200,json={'value':4096})
        return httpx.Response(200,json={'data':[{'id':model,'max_model_len':4096,'meta':{'n_ctx':4096}}]})
    r=replace(req(provider,model),cache_context={'thinkingRequested':preference})
    with patch.object(local_openai_runtime.httpx,'Client',side_effect=lambda *,timeout:real(transport=httpx.MockTransport(metadata),timeout=timeout)),patch.object(local_openai_runtime,'execute_chat_completion',return_value=ChatResult('<<TP_P0:answer>>',model)) as gen:
        if preference=='minimum':
            result=adapter.generate(r);wire=gen.call_args.kwargs['payload']
            assert wire['model']==model and 'temperature' not in wire
            assert not ({'reasoning','think','reasoning_effort','provider'} & wire.keys())
            assert result.thinking_applied=='provider_managed_unverified'
            assert wire['messages'][0]['content']==STYLE
        else:
            with pytest.raises(ConversationError) as exc:adapter.generate(r)
            assert exc.value.code=='ai_local_thinking_unsupported';gen.assert_not_called()

@pytest.mark.parametrize('model',FUTURE)
@pytest.mark.parametrize('mode',['off','minimum','high'])
def test_lmstudio_native_controls_follow_exact_metadata_not_future_slug(model,mode):
    caps={'reasoning':{'supported':True,'supported_efforts':['off','low','high'],'mandatory':False},'limits':{'contextTokens':4096,'maxOutputTokens':96}}
    r=replace(req('lmstudio',model),thinking='off' if mode=='minimum' else mode,model_capabilities=caps,cache_context={'thinkingRequested':mode,'translationMode':'independent','reasoningCapabilityVerified':True})
    body,applied=local_lmstudio.ADAPTER.prepare_native_payload(r)
    assert body['model']==model and body['system_prompt']==STYLE and body['input']==SOURCE
    assert body['reasoning']==('off' if mode=='minimum' else mode)
    assert body['max_output_tokens']==96 and body['store'] is False
    assert 'temperature' not in body and 'previous_response_id' not in body

@pytest.mark.parametrize('model',FUTURE)
def test_lmstudio_unknown_lowest_independent_is_not_claimed_as_verified(model):
    r=replace(req('lmstudio',model),cache_context={'thinkingRequested':'minimum','translationMode':'independent'})
    with pytest.raises(ConversationError) as exc:local_lmstudio.ADAPTER.prepare_native_payload(r)
    assert exc.value.code=='ai_local_thinking_unsupported'

@pytest.mark.parametrize('model',FUTURE)
def test_ollama_unknown_slug_attempts_native_off_without_claiming_capability(model):
    r=req('ollama',model)
    with patch.object(local_ollama,'generate',return_value=ChatResult('<<TP_P0:answer>>',model)) as wire:
        result=local_ollama.ADAPTER.generate(r)
        args=wire.call_args
        assert args.args[1]==model and args.args[2]==STYLE and args.args[3]==[SOURCE]
        assert args.kwargs['thinking']=='off' and args.kwargs['reject_observed_thinking'] is True
        assert result.thinking_applied=='requested_off_unverified_metadata'

@pytest.mark.parametrize('model',FUTURE)
def test_ollama_future_unknown_native_effort_cannot_claim_minimum(model):
    caps={'reasoning':local_ollama._native_thinking_capability({'values':['turbo_future_2040'],'default':'turbo_future_2040'})}
    r=replace(req('ollama',model),model_capabilities=caps,cache_context={'thinkingRequested':'minimum','reasoningCapabilityVerified':True})
    with patch.object(local_ollama,'generate') as wire:
        with pytest.raises(ConversationError):local_ollama.ADAPTER.generate(r)
        wire.assert_not_called()


def test_registry_aliases_are_exact_and_unknown_provider_does_not_guess():
    local=[s for s in REG if s.local]
    assert len(local)==9
    assert sum(len(s.aliases) for s in local)==15
    for spec in local:
        for alias in spec.aliases:assert REG.resolve_id(' '+alias.upper()+' ')==spec.provider_id
    assert REG.get('qwenfutureprovider') is None

@pytest.mark.parametrize('jit',[False,True])
@pytest.mark.parametrize('options,known,supported,mandatory,control,minimum',[
    (['off','ultra_future','high'],['off','high'],True,False,'levels','off'),
    (['low','quantum_future','high'],['low','high'],True,True,'levels','default'),
    (['quantum_future'],[],None,True,'levels','default'),
    ([],[],False,False,'none','default'),
])
def test_lmstudio_native_future_efforts_preserve_known_controls(jit,options,known,supported,mandatory,control,minimum):
    model='future-unknown-model';real=httpx.Client
    def metadata(request):
        assert request.method=='GET' and request.url.host=='127.0.0.1'
        if request.url.path=='/v1/models':
            assert jit
            return httpx.Response(200,json={'data':[{'id':model}]})
        assert request.url.path=='/api/v1/models'
        entry={'type':'llm','key':model,'max_context_length':4096,
            'loaded_instances':[] if jit else [{'id':model,'config':{'context_length':4096}}],
            'capabilities':{'reasoning':{'allowed_options':options}}}
        return httpx.Response(200,json={'models':[entry]})
    with patch.object(local_lmstudio.httpx,'Client',side_effect=lambda *,timeout:real(transport=httpx.MockTransport(metadata),timeout=timeout)):
        result=local_lmstudio.ADAPTER.list_models(api_key='',base_url='http://127.0.0.1:1234/v1')
    caps=result.capabilities[model];reasoning=caps['reasoning']
    assert reasoning['supported_efforts']==known
    assert reasoning['supported'] is supported
    assert reasoning['mandatory'] is mandatory
    assert reasoning['control']==control
    assert resolve_reasoning_preference('minimum',reasoning)==minimum
    if mandatory:assert reasoning['minimum_unresolved'] is True
    if options==['quantum_future']:
        r=replace(req('lmstudio',model),model_capabilities=caps,cache_context={
            'thinkingRequested':'minimum','translationMode':'independent','reasoningCapabilityVerified':True})
        with pytest.raises(ConversationError) as exc:local_lmstudio.ADAPTER.prepare_native_payload(r)
        assert exc.value.code=='ai_local_thinking_unsupported'
