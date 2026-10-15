"""Unknown-name cloud native wires, all HTTP synthetic. Run separate Center tests."""
import os
import json
from dataclasses import replace
import sys
from pathlib import Path

os.environ['TP_AI_WIRE_TRACE'] = '0'
os.environ['TP_USAGE_RECEIPTS'] = 'off'
os.environ['TP_CENTER_URL'] = 'https://center.example'
HERE = Path(__file__).resolve()
PROJECT = next((candidate for parent in HERE.parents
    for candidate in (parent,parent/'source/TextPhantom')
    if (candidate/'api/backend/ai/provider_contract.py').is_file()),None)
if PROJECT is None: raise RuntimeError('Cannot locate TextPhantom API source')
sys.path.insert(0, str(PROJECT / 'api'))
import httpx
import pytest
from backend.ai.providers import (cloud_anthropic, cloud_deepseek, cloud_featherless,
    cloud_gemini, cloud_groq, cloud_huggingface, cloud_openai, cloud_openrouter,
    cloud_paid, cloud_together)
from backend.ai.provider_contract import GenerationRequest
from backend.ai.cloud_reasoning import ensure_cloud_reasoning_preflight, CloudReasoningPreferenceUnavailable
from backend.ai import provider_resolution as resolution

MODULES = {m.SPEC.provider_id:m for m in (cloud_anthropic, cloud_deepseek, cloud_featherless,
    cloud_gemini, cloud_groq, cloud_huggingface, cloud_openai, cloud_openrouter,
    cloud_paid, cloud_together)}
ORIGINAL_CLIENT = httpx.Client
ANSWER = '<<TP_P0:สวัสดี>>'


@pytest.fixture
def synthetic(monkeypatch):
    calls = []
    def handle(request):
        assert request.method == 'POST', request.url
        outgoing = json.loads(request.content)
        calls.append(outgoing)
        if request.url.path.endswith('/messages'):
            data = {'id':'msg-QA','content':[{'type':'text','text':ANSWER}], 'stop_reason':'end_turn',
                'usage':{'input_tokens':20,'output_tokens':7,'cache_read_input_tokens':10,'cache_creation_input_tokens':0}}
        elif request.url.path.endswith(':generateContent'):
            data = {'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':ANSWER}]}}],
                'usageMetadata':{'promptTokenCount':30,'candidatesTokenCount':7,'totalTokenCount':37,'cachedContentTokenCount':10}}
        else:
            data = {'id':'gen-QA', 'model':outgoing['model'],
                'choices':[{'message':{'content':ANSWER},'finish_reason':'stop'}],
                'usage':{'prompt_tokens':30,'completion_tokens':7,'total_tokens':37,
                    'prompt_tokens_details':{'cached_tokens':10},'cost':'0.00001'},
                'charged_tp':'9','balance_tp':'9991'}
            if outgoing.get('stream') is True:
                frames = [
                    {'id':'gen-QA','model':outgoing['model'],'choices':[{'delta':{'content':ANSWER},'finish_reason':None}]},
                    {'id':'gen-QA','model':outgoing['model'],'choices':[{'delta':{},'finish_reason':'stop'}], 'usage':data['usage']},
                ]
                return httpx.Response(200,headers={'content-type':'text/event-stream'},
                    text=''.join('data: '+json.dumps(f,ensure_ascii=False)+'\n\n' for f in frames)+'data: [DONE]\n\n')
        return httpx.Response(200,json=data)
    def client(*args,**kwargs):
        kwargs['transport'] = httpx.MockTransport(handle)
        return ORIGINAL_CLIENT(*args,**kwargs)
    monkeypatch.setattr(httpx,'Client',client)
    monkeypatch.setattr(cloud_paid,'center_base_url',lambda:'https://center.example')
    monkeypatch.setattr(cloud_paid,'center_origin',lambda:'https://center.example')
    return calls


def request(provider,caps):
    m=MODULES[provider]
    return GenerationRequest(provider=provider,model='qa/future-2099-unknown-model',api_key='QA-only-key',
        base_url=m.SPEC.default_base_url,system_text='My exact custom instructions',
        user_parts=('<<TP_P0:Hello>>',),thinking='off',
        model_capabilities=caps,cache_context={'operationId':'QA-unknown-model'},
        workload={'predictedOutput':16})


@pytest.mark.parametrize('provider',sorted(MODULES))
def test_scope_proven_unsupported_sampling_is_omitted_actual_wire(provider,synthetic):
    caps={'reasoning':{'supported':False},'supported_parameters':['max_tokens'],
        'limits':{'contextTokens':32768,'maxOutputTokens':512}}
    req=request(provider,caps)
    result=MODULES[provider].ADAPTER.generate(req)
    assert result.text == ANSWER
    assert len(synthetic)==1
    payload=synthetic[0]
    sampling=payload.get('generationConfig',payload)
    assert 'temperature' not in sampling, {'provider':provider,'sampling':sampling}
    assert 'top_p' not in sampling and 'topP' not in sampling
    assert req.system_text == 'My exact custom instructions' and req.thinking == 'off'


@pytest.mark.parametrize('provider',sorted(MODULES))
@pytest.mark.parametrize('parameters',[None,False,{'temperature':False}])
def test_missing_or_malformed_sampling_metadata_does_not_crash_unknown_model(provider,parameters,synthetic):
    caps={'reasoning':{'supported':False},'limits':{'contextTokens':32768,'maxOutputTokens':512}}
    if parameters is not None: caps['supported_parameters']=parameters
    req=request(provider,caps)
    result=MODULES[provider].ADAPTER.generate(req)
    assert result.text==ANSWER
    assert len(synthetic)==1
    assert req.model=='qa/future-2099-unknown-model'


@pytest.mark.parametrize('provider,model',[
    ('groq','qwen/qwen3.8-27b'),('together','Qwen/Qwen3.5-9B'),
])
def test_native_off_does_not_reintroduce_proven_unsupported_temperature(provider,model,synthetic):
    module=MODULES[provider]
    caps={'reasoning':module._reasoning_capability(model),
          'supported_parameters':['max_tokens','max_completion_tokens','reasoning','reasoning_effort'],
          'limits':{'contextTokens':32768,'maxOutputTokens':2048}}
    req=replace(request(provider,caps),model=model)
    result=module.ADAPTER.generate(req)
    assert result.text==ANSWER and len(synthetic)==1
    assert 'temperature' not in synthetic[0],synthetic[0]


def test_unknown_anthropic_on_cannot_pass_preflight_while_leaf_omits_its_wire_control():
    caps={'supported':True,'mandatory':False,'control':'toggle','supported_efforts':['none','on']}
    with pytest.raises(CloudReasoningPreferenceUnavailable):
        ensure_cloud_reasoning_preflight('anthropic','qa/future-2099-unknown-model','on','on',caps,
            capability_verified=True)


@pytest.mark.parametrize('provider',sorted(MODULES))
def test_inapplicable_null_effort_metadata_does_not_break_nonreasoning_unknown_model(provider,synthetic):
    caps={'reasoning':{'supported':False,'supported_efforts':None},
        'limits':{'contextTokens':32768,'maxOutputTokens':512}}
    req=request(provider,caps)
    result=MODULES[provider].ADAPTER.generate(req)
    assert result.text==ANSWER and len(synthetic)==1


def test_deepseek_disabled_thinking_rechecks_native_output_limit(synthetic):
    caps={'reasoning':{'supported':True,'mandatory':False,'default_enabled':True,
        'control':'levels','supported_efforts':['none','low','high']},
        'limits':{'contextTokens':32768,'maxOutputTokens':512}}
    req=request('deepseek',caps)
    result=cloud_deepseek.ADAPTER.generate(req)
    assert result.text==ANSWER and len(synthetic)==1
    assert synthetic[0]['thinking']=={'type':'disabled'}
    assert synthetic[0]['max_tokens']<=512


@pytest.mark.parametrize('provider',sorted(MODULES))
def test_native_usage_cache_units_and_cost_authority_do_not_cross_providers(provider,synthetic):
    req=request(provider,{'reasoning':{'supported':False},'limits':{'maxOutputTokens':512}})
    result=MODULES[provider].ADAPTER.generate(req)
    assert result.input_tokens==30 and result.output_tokens==7 and result.total_tokens==37
    assert result.usage_details['cachedInputTokens']==10
    if provider in {'paid','openrouter'}:
        assert result.usage_details['providerCostUsd']=='0.00001'
    else:
        assert result.usage_details['providerCostUsd'] is None
    payload=synthetic[0]
    config=payload.get('generationConfig',payload)
    output=config.get('maxOutputTokens',config.get('max_completion_tokens',config.get('max_tokens')))
    assert type(output) is int and output<=512
    # Cache counters are observations; this fixture cannot establish a real hit.
    assert req.system_text=='My exact custom instructions'


@pytest.mark.parametrize('provider',sorted(MODULES))
def test_catalogue_cache_effective_capabilities_to_native_wire_keeps_parameter_evidence(provider,synthetic):
    caps={'reasoning':{'supported':False},'supported_parameters':['max_tokens'],
          'limits':{'contextTokens':32768,'maxOutputTokens':512}}
    req=request(provider,caps)
    resolution.remember_selected_model_capability(provider,req.base_url,req.api_key,req.model,
        {'reasoning':{'supported':False}})
    resolution.remember_model_capabilities(provider,req.base_url,req.api_key,
        {req.model:caps},models=[req.model])
    fresh,discovered=resolution.discovered_model_capabilities(provider,req.base_url,req.model,req.api_key)
    assert fresh is True
    assert discovered.get('supported_parameters')==['max_tokens'],discovered
    effective=resolution.effective_model_capabilities(discovery_fresh=fresh,server=discovered,
        client={'supported_parameters':['max_tokens','temperature']})
    assert effective.get('supported_parameters')==['max_tokens']
    request2=replace(req,model_capabilities=effective)
    result=MODULES[provider].ADAPTER.generate(request2)
    assert result.text==ANSWER and len(synthetic)==1
    sampling=synthetic[0].get('generationConfig',synthetic[0])
    assert 'temperature' not in sampling


def test_observed_off_retention_merges_list_parameter_metadata_without_dict_coercion():
    model='qa/future-hf-model'
    provider='huggingface';base='https://router.huggingface.co/v1';key='QA-observed-off-cache'
    resolution.remember_model_capabilities(provider,base,key,
        {model:{'supported_parameters':['max_tokens']}},models=[model])
    revision=resolution.capture_capability_cache_revision(provider,base,key)
    assert resolution.retain_observed_off_control(provider,base,key,model,dispatch_revision=revision)
    fresh,caps=resolution.discovered_model_capabilities(provider,base,model,key)
    assert fresh and caps.get('supported_parameters')==['max_tokens']
    assert caps['reasoning']['supported_efforts']==['none']


def test_unknown_anthropic_name_does_not_guess_nondefault_sampling_without_evidence(synthetic):
    req=request('anthropic',{'reasoning':{'supported':False},'limits':{'maxOutputTokens':512}})
    result=cloud_anthropic.ADAPTER.generate(req)
    assert result.text==ANSWER and len(synthetic)==1
    assert 'temperature' not in synthetic[0]
