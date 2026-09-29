"""Run without the optional HTTP server dependencies: PYTHONPATH=api python scripts/test-conversation-continuation-budget.py"""
from types import SimpleNamespace
from dataclasses import replace
from unittest.mock import patch

from backend.ai.translation_paths.batch_policy import select_rows
from backend.ai.translation_paths.mode import scope_material
from backend.ai.wire_trace import folder_name
from backend.ai.workload import WorkloadBudgetError
from backend.ai.translation.contracts import AiConfig

limits = {'contextTokens': 65536, 'maxOutputTokens': 8192}
ai = AiConfig(api_key='fixture',provider='huggingface',model='fixture',
    base_url='https://router.huggingface.co/v1',thinking='off', model_capabilities={'limits':limits},
    prompt_editable='', prompt_mode=None, glossary=[], characters=[], char_memory=False,
    context_frozen=False, image_b64='', series_state='', speakers={}, prev_context=[],
    page_context=[], source_context=[], source_lang='en', style_examples=True,
    memory_mode='off', output_contract='tp.translation.lines/1')
owners = [object() for _ in range(10)]
rows = [{'ticket':owner, 'index':i,'text':'ก'*35} for owner in owners for i in range(10)]

def plan(profile, config=ai, ready=rows):
    # This fixture's exact selected/account catalogue owns the numeric facts.
    with patch('backend.ai.provider_resolution.discovered_model_capabilities',
               return_value=(True,config.model_capabilities)):
        return select_rows(ready, config, 'th', profile)

anchor, first_estimate, _ = plan({'successes':0})
continuation, estimate, reason = plan({'successes':1})
assert len(anchor) == 80 and first_estimate['target'] == 7372
assert len(continuation) == 80 and estimate['target'] == 7372
assert reason == 'conversation_page_output_target'
assert continuation == rows[:80]
assert plan({'successes':1}, ready=rows[80:])[0] == rows[80:]
three, _, reason_three = plan({'successes':0}, ready=rows[:30])
assert three == rows[:30] and reason_three == 'ready_queue_drained'

reasoning_ai = replace(ai,thinking='on',
    model_capabilities={'limits':limits,'reasoning':{'mandatory':True,'supports_max_tokens':True}})
reasoning_rows, reasoning_estimate, _ = plan({'successes':1},reasoning_ai)
assert 0 < len(reasoning_rows) < len(continuation) and reasoning_estimate['reasoningReserve'] > 0

for bounds in ({'contextTokens':65536,'maxOutputTokens':4096},
        {'maxOutputTokens':8192},
        {'contextTokens':65536,'maxOutputTokens':8192,'outputHintTokens':4096}):
    narrower = replace(ai,model_capabilities={'limits':bounds})
    selected, _, _ = plan({'successes':1},narrower)
    assert len(selected) == (40 if bounds.get('maxOutputTokens') == 4096 else
        80 if bounds.get('contextTokens') else 10), bounds

small_context = replace(ai,
    model_capabilities={'limits':{'contextTokens':8192,'maxOutputTokens':8192}})
try:
    plan({'successes':1},small_context)
except WorkloadBudgetError as error:
    assert error.diagnostics['constraint'] == 'context_window'
else:
    raise AssertionError('A model that cannot fit the system prompt must not dispatch')

restricted, restricted_estimate, _ = plan({'successes':1,'restricted':True})
assert len(restricted) == 80 and restricted_estimate['target'] == 7372
length, length_estimate, _ = plan({'successes':1,'outcomes':['length']})
assert len(length) == 60 and length_estimate['target'] == 6144
assert len(plan({'successes':1,'outcomes':['length','ok','ok','ok','ok']})[0]) == 80
vertical_owners = [object() for _ in range(10)]
vertical = [{'ticket':owner,'index':i,'text':'ก'*12} for owner in vertical_owners for i in range(20)]
vertical_picked, _, _ = plan({'successes':1}, ready=vertical)
assert len(vertical_picked) == 160, 'short vertical records must not hit the old 128-unit gate'
cached, cached_estimate, _ = plan({'successes':1,'cacheRatio':.9,'cacheConfirmed':True})
assert len(cached) == len(continuation) and cached_estimate['target'] == estimate['target']
chat = SimpleNamespace(conversation={'owner':'fixture-owner','documentId':'fixture-document','branch':'initial'},
    provider='huggingface',model='fixture',base_url='https://fixture.invalid',api_key='fixture',
    source_lang='en',prompt_editable='',prompt_mode=None,memory_mode='off',thinking='off',
    send_image=False,image_b64='',output_contract='tp.translation.lines/1')
initial_scope = scope_material(chat, 'th')
chat.conversation['branch'] = 'repair'
assert scope_material(chat, 'th') == initial_scope, 'repair stays in the document chat scope'
assert '--repair--' in folder_name({'operationId':'repair:run:task','attemptKind':'repair'})
print('API Conversation 8K window: 3/10 ready pages, 8+2, vertical text, model cap, reasoning and cache passed.')
