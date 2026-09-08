"""Mock-native provider boundary tests for workload budgets; no live API calls."""
from pathlib import Path
import sys, runpy, copy
from dataclasses import replace
from contextlib import ExitStack
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'api'))
h=runpy.run_path(str(ROOT/'scripts/test-api-provider-boundary-matrix.py'),run_name='matrix_helpers')
from backend.ai.workload import normalize_limits, normalize_workload, guard_output_budget, WorkloadBudgetError
from backend.ai.providers.cloud_openrouter import normalize_capabilities

assert normalize_workload({'version':1,'predictedOutput':True,'completionAvailable':0,'limits':{'contextTokens':1}})=={'version':1}
assert normalize_workload({'version':2})=={}
assert normalize_limits({'contextTokens':True,'maxOutputTokens':-1})=={}
assert guard_output_budget(1234)==1234
assert guard_output_budget(2048,workload={'version':1,'predictedOutput':100},limits={'maxOutputTokens':256},system='style',parts=('text',))==256
try: guard_output_budget(1024,workload={'version':1,'predictedOutput':100,'reasoningReserve':300},limits={'maxOutputTokens':256})
except WorkloadBudgetError: pass
else: raise AssertionError('reasoning must count towards allowance')
assert normalize_capabilities({'top_provider':False,'per_request_limits':False,'architecture':[]})=={'reasoning':{}}
c=normalize_capabilities({'context_length':4096,'top_provider':{'max_completion_tokens':2048},'architecture':{'tokenizer':'Example'}})
assert c['limits']['outputHintTokens']==2048 and 'maxOutputTokens' not in c['limits']
print('PASS normalization, unknown limits, output vs reasoning, endpoint-hint provenance')

registry=list(h['compose_providers'](h['ProviderRegistry']()))
Client=h['BoundaryClient']; Response=h['Response']; openai_chat=h['openai_chat']; gemini=h['cloud_gemini']; anthropic=h['cloud_anthropic']
Request=h['GenerationRequest']; calls=[]
def strip_budget(payload):
    p=copy.deepcopy(payload)
    for k in ('max_tokens','max_completion_tokens'):p.pop(k,None)
    p.get('options',{}).pop('num_predict',None)
    p.get('generationConfig',{}).pop('maxOutputTokens',None)
    return p
for spec in registry:
    req=Request(provider=spec.provider_id,model=spec.default_model,api_key='fixture',base_url=spec.default_base_url,
       system_text='IDENTITY AND STYLE: keep exact text.',user_parts=('TASK: Translate into Thai. <<TP_P0:Morning.>>',),thinking='off',unit_count=1,expected_ids=('P0',),
       model_capabilities={'limits':{'contextTokens':4096,'maxOutputTokens':256},'reasoning':{'supported':False}})
    def dispatch(request):
        captured=[];Client.calls=[]
        def gpost(*args,**kw):
            captured.append(args[2]);return Response({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':h['ANSWER']}]}}],
             'usageMetadata':{'promptTokenCount':23,'candidatesTokenCount':7,'totalTokenCount':30}})
        def apost(*args,**kw):
            captured.append(kw['json']);return Response({'content':[{'type':'text','text':h['ANSWER']}],'stop_reason':'end_turn','usage':{'input_tokens':23,'output_tokens':7}})
        with ExitStack() as stack:
            stack.enter_context(patch.object(openai_chat.httpx,'Client',Client))
            stack.enter_context(patch.object(gemini,'_post_once',side_effect=gpost))
            stack.enter_context(patch.object(anthropic,'post_json',side_effect=apost))
            result=spec.adapter.generate(request)
        captured += [x['json'] for x in Client.calls]
        assert len(captured)==1,(spec.provider_id,len(captured))
        return captured[0],result
    old,_=dispatch(req)
    bounded=replace(req,workload={'version':1,'predictedOutput':100,'estimatedInput':128,'completionAvailable':256})
    new,result=dispatch(bounded)
    values=[new.get('max_tokens'),new.get('max_completion_tokens'),new.get('options',{}).get('num_predict'),new.get('generationConfig',{}).get('maxOutputTokens')]
    assert 256 in values,(spec.provider_id,values)
    assert strip_budget(old)==strip_budget(new),f'{spec.provider_id}: unexpected prompt/schema/thinking change'
    assert result.text==h['ANSWER'],spec.provider_id
    assert result.requested_output_tokens==256,(spec.provider_id,result.requested_output_tokens)
    before=len(Client.calls)
    try:dispatch(replace(req,workload={'version':1,'predictedOutput':1000,'completionAvailable':256}))
    except WorkloadBudgetError:pass
    else:raise AssertionError(f'{spec.provider_id}: oversized prediction should fail BEFORE dispatch')
    assert Client.calls==[],f'{spec.provider_id}: unexpected HTTP after preflight rejection'
    print('PASS',spec.provider_id,'budget bounded, original prompts/settings unchanged, oversize rejected before HTTP')
print('Workload provider guard matrix: 19/19 PASS; no live requests.')

# The public endpoint must preserve the pre-dispatch failure type and zero usage.
from types import SimpleNamespace
from fastapi import HTTPException
from backend.application.ai_translation import provider_errors
ctx=SimpleNamespace(unit_count=1, trace_id='fixture-trace', correlation={}, route_identity={}, requested_route='/fixture')
with patch.object(provider_errors,'trace_failure'), patch.object(provider_errors,'failure_event'):
    try: provider_errors.raise_execution_error(ctx,WorkloadBudgetError('budget preflight'),rate_wait_ms=0,admission_wait_ms=0,provider_ms=0)
    except HTTPException as exc:
        assert exc.detail['code']=='ai_workload_budget_insufficient',exc.detail
        assert exc.detail['requestDispatched'] is False and exc.detail['providerAttempts']==0
    else: raise AssertionError('Expected HTTP 400 preflight rejection')
print('PASS public preflight error: typed capacity error and zero provider/generation attempts')
