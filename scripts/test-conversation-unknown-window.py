"""PYTHONPATH=api python scripts/test-conversation-unknown-window.py"""
from types import SimpleNamespace
from dataclasses import replace
from unittest.mock import patch

from backend.ai.translation_paths.batch_policy import select_rows
from backend.ai.translation.contracts import AiConfig
from backend.ai.workload import WorkloadBudgetError

limits={'contextTokens':1310720,'outputHintTokens':943718}
ai=AiConfig(api_key='fixture',provider='openrouter',model='fixture',
    base_url='https://openrouter.ai/api/v1',thinking='off',model_capabilities={'limits':limits},
    prompt_editable='',prompt_mode=None,glossary=[],characters=[],char_memory=False,
    context_frozen=False,image_b64='',series_state='',speakers={},prev_context=[],
    page_context=[],source_context=[],source_lang='en',style_examples=True,
    memory_mode='off',output_contract='compact_markers_v1')
owners=[object() for _ in range(10)]
rows=[{'ticket':owner,'index':i,'text':'ก'*35} for owner in owners for i in range(10)]

def plan(rows,config,profile):
    with patch('backend.ai.provider_resolution.discovered_model_capabilities',
               return_value=(True,config.model_capabilities)):
        return select_rows(rows,config,'th',profile)

first,estimate,_=plan(rows,ai,{})
assert estimate['target']==7372 and len(first)==80
assert plan(rows[80:],ai,{})[0]==rows[80:]
assert plan(rows[:30],ai,{})[0]==rows[:30]
for cap in ({'maxOutputTokens':4096},{'outputHintTokens':4096}):
    narrower=replace(ai,model_capabilities={'limits':{**limits,**cap}})
    assert len(plan(rows,narrower,{})[0])==(40 if 'maxOutputTokens' in cap else 80)
other=replace(ai,provider='groq',base_url='https://api.groq.com/openai/v1')
assert plan(rows,other,{})[1]['target']==7372
unknown=replace(other,model_capabilities={})
assert plan(rows,unknown,{})[1]['target']==1536
low=replace(ai,model_capabilities={'limits':{'contextTokens':8192}})
try:
    plan(rows,low,{})
except WorkloadBudgetError:
    pass
else:
    raise AssertionError('small context must not use the 8K application ceiling')
assert plan(rows,ai,{'outcomes':['length']})[1]['target']==6144
assert plan(rows,ai,{'outcomes':['length','ok','ok','ok','ok']})[1]['target']==7372
thinking_rows,thinking_estimate,_=plan(rows,ai,{'reasoningSeen':True,'reasoning':372})
assert 0<len(thinking_rows)<=len(first)
assert thinking_estimate['reasoningReserve']>0
assert thinking_estimate['predictedOutput']+thinking_estimate['reasoningReserve']<=8192
repair_rows,repair_estimate,_=plan(rows,ai,{'reasoningSeen':True,'reasoning':8192,'outcomes':['length']})
assert 0<len(repair_rows)<len(thinking_rows)
assert repair_estimate['reasoningReserve']>thinking_estimate['reasoningReserve']
active=replace(ai,thinking='on',model_capabilities={
    'limits':limits,'reasoning':{'supported':True,'mandatory':False,'control':'toggle','supports_max_tokens':False}})
active_rows,active_estimate,_=plan(rows,active,{})
assert active_rows and active_estimate['completionAvailable']>=8192
assert active_estimate['reasoningReserve']>=2048
print('PASS API immediate 8K application window matches browser whole-page selection')
