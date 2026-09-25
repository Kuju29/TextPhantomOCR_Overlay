"""The 8K context guard learns only from provider input measured in its own lease."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'api'))
from backend.ai.translation_paths.store import Lease, _current
from backend.ai.workload import estimate_provider_input, observed_input_scale, guard_output_budget, WorkloadBudgetError

assert observed_input_scale([])==1
assert observed_input_scale([(1248,7559)])==.45
assert observed_input_scale([(1248,7559),(6000,7000)])==1
assert observed_input_scale([(0,7559),(1248,7559)])==.45
system='Translate exactly the supplied marked units.'
parts=['ตัวอย่างการแปล'*320]
history=[{'role':'user','text':'ตัวอย่างก่อนหน้า'*160},{'role':'assistant','text':'คำแปล'*80}]
raw=estimate_provider_input(system=system,parts=parts,history=history)
assert raw>2000
hint={'version':1,'estimatedInput':1,'predictedOutput':512}
limits={'contextTokens':min(8191,raw+511)}
try:
    guard_output_budget(1024,workload=hint,limits=limits,system=system,parts=parts,history=history)
except WorkloadBudgetError as error:
    assert not error.requestDispatched
else: raise AssertionError('An untrusted client hint cannot lower the input guard')
lease=Lease()
lease.input_estimate_scale=observed_input_scale([(1248,7559)])
token=_current.set(lease)
try:
    measured=estimate_provider_input(system=system,parts=parts,history=history)
    assert measured>=raw*.45 and measured<=raw*.45+1
    assert guard_output_budget(1024,workload=hint,limits=limits,system=system,parts=parts,history=history)>0
finally:_current.reset(token)
assert estimate_provider_input(system=system,parts=parts,history=history)==raw
from dataclasses import dataclass, replace
from types import SimpleNamespace
from backend.ai.translation_paths.conversation import prepare
from backend.ai.translation_paths.batch_policy import _estimate

@dataclass
class Request:
    system_text: str
    user_parts: tuple
    provider: str='openrouter'
    model: str='openai/gpt-4'
    base_url: str='https://openrouter.ai/api/v1'
    model_capabilities: dict=None
    response_schema: dict=None
    workload: dict=None
    image_b64: str=''
    image_mime: str='image/png'
    cache_context: dict=None
    unit_count: int=1
    history_messages: tuple=()

static='ก'*5100
prompt=Request('Translator', (static+'\n\n'+'ป'*320,), model_capabilities={'limits':{'contextTokens':8191}},
               workload={'version':1,'predictedOutput':450},cache_context={})
ai=SimpleNamespace(conversation={},provider='openrouter')
turn={'user':static+'\n\n'+'ข'*300,'assistant':'คำแปล'*80,'anchor':True,'pages':[],
      'inputTokens':1248,'rawEstimatedInput':7559}
layout={'userStaticChars':len(static),'instructionLocale':'th'}
def prepare_with(turn):
    lease=Lease(history=[turn]);lease.source_texts=['ป'*320]
    marker=_current.set(lease)
    try:return prepare(prompt,layout,ai),lease.evidence
    finally:_current.reset(marker)

calibrated,evidence=prepare_with(turn)
uncalibrated,old=prepare_with({**turn,'inputTokens':None})
assert evidence['inputEstimateScale']==.45
assert evidence['historyTurns']==1 and len(calibrated.history_messages)==2
assert old['historyTurns']==0 and not uncalibrated.history_messages
assert evidence['estimatedInput'] < evidence['rawEstimatedInput']
planner_ai=SimpleNamespace(provider='openrouter',model_capabilities={'limits':{'contextTokens':8191}},
    thinking='off',output_contract='markers',prompt_editable='',prompt_mode='default',glossary='',
    characters=None,char_memory=False,context_frozen=False,image_b64='',series_state=None,
    speakers=None,prev_context=None,page_context=None,source_context=None,source_lang='en',memory_mode='off')
# Planner uses the same measured profile for its *next* batch, while its first
# request and other providers retain the conservative raw budget.
rows=[{'text':'Hello', 'ticket':object()}]
before=_estimate(rows,planner_ai,'th',{},1536,200)
after=_estimate(rows,planner_ai,'th',{'inputSamples':[(1248,7559)]},1536,200)
assert after['estimatedInput']<=before['estimatedInput'] and after['inputEstimateScale']==.45
print('PASS measured input calibration is private, bounded and leaves default guard intact')
