"""Actual request budget keeps physical model evidence separate from browser hints."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.provider_resolution import (
    discovered_model_capabilities, effective_model_capabilities,
    forget_model_capabilities, remember_model_capabilities,
)
from backend.ai.workload import (
    WorkloadBudgetError, bounded_source_workload, estimate_provider_input,
    guard_output_budget, guard_request_budget,
)
from backend.ai.provider_contract import GenerationRequest

client = {'limits': {'contextTokens': 256, 'maxOutputTokens': 999999,
                     'source': 'browser', 'modelRevision': 'rev2'},
          'vision': {'supported': True}}
stale = effective_model_capabilities(discovery_fresh=False, server={}, client=client)
assert stale['limits'] == {'source': 'browser', 'modelRevision': 'rev2'}
assert stale['vision']['supported'] is True
server = {'limits': {'contextTokens': 32768, 'maxOutputTokens': 2048,
                     'source': 'provider_catalogue'}}
fresh = effective_model_capabilities(discovery_fresh=True, server=server, client=client)
assert fresh['limits'] == server['limits']
base_model = 'publisher/exact-model'
base_url, key = 'https://router.huggingface.co/v1', 'fixture-secret'
try:
    remember_model_capabilities('huggingface', base_url, key, {
        base_model: {'provider_limits': {
            'novita': {'contextTokens': 16384, 'source': 'provider-route'},
            'together': {'contextTokens': 32768, 'source': 'provider-route'},
        }}}, models=[base_model])
    for route, context in (('novita', 16384), ('together', 32768)):
        fresh_route, caps = discovered_model_capabilities(
            'huggingface', base_url, base_model + ':' + route, key)
        assert fresh_route and caps['limits']['contextTokens'] == context
    _, auto_caps = discovered_model_capabilities('huggingface', base_url, base_model, key)
    _, unknown_caps = discovered_model_capabilities('huggingface', base_url, base_model + ':unknown', key)
    assert 'limits' not in auto_caps and 'limits' not in unknown_caps
finally:
    forget_model_capabilities('huggingface', base_url, key)

def rejected(fn):
    try:
        fn()
    except WorkloadBudgetError as error:
        assert error.requestDispatched is False
        assert error.providerAttempts == error.generationAttempts == 0
    else:
        raise AssertionError('expected pre-dispatch provider capacity error')

history = ({'role': 'user', 'text': 'earlier ' * 500},)
inp = estimate_provider_input(system='s' * 4000, parts=('short',), history=history)
assert inp > estimate_provider_input(system='s' * 4000, parts=('short',))
assert guard_output_budget(529, workload={'version': 1, 'predictedOutput': 247,
    'completionAvailable': 2}, limits={'contextTokens': 12000},
    system='s' * 4000, parts=('short',)) == 529
assert guard_output_budget(529, limits={'maxOutputTokens': 256}, parts=('short',)) == 256
assert guard_output_budget(8192, workload={'version': 1, 'predictedOutput': 12000},
    limits={'contextTokens': 32768}, parts=('long source',),
    source_unit_texts=('漢' * 6500,)) == 18000
assert guard_output_budget(8192, workload={'version': 1, 'predictedOutput': 10**8},
    parts=('short',), source_unit_texts=(' ' * 60000,)) == 8192
assert guard_output_budget(8192, workload={'version': 1, 'predictedOutput': 10**8,
    'reasoningReserve': 10**8}, parts=('short',)) <= 9216
bounded = bounded_source_workload({'version': 1, 'predictedOutput': 10**8,
    'reasoningReserve': 10**8}, ('Hello',))
assert bounded['predictedOutput'] == 1024 and bounded['reasoningReserve'] == 8192
rejected(lambda: guard_output_budget(529, limits={'maxInputTokens': 100},
    system='s' * 4000, parts=('short',)))
rejected(lambda: guard_output_budget(529, workload={'version': 1,
    'predictedOutput': 3000}, limits={'maxOutputTokens': 512},
    parts=('漢' * 1200,), source_unit_texts=('漢' * 1200,)))
plain = GenerationRequest(provider='ollama', model='exact', system_text='s' * 4000,
    user_parts=('short',), source_unit_texts=('short',),
    model_capabilities={'limits': {'contextTokens': 8000},
                        'reasoning': {'supported': False}},
    workload={'version': 1, 'predictedOutput': 247, 'reasoningReserve': 7000},
    cache_context={'reasoningCapabilityVerified': True})
assert 0 < guard_request_budget(plain, 8192) < 8000
from dataclasses import replace
rejected(lambda: guard_request_budget(replace(plain,
    cache_context={'reasoningCapabilityVerified': False}), 8192))
print('PASS source-bounded requests, history, missing hints and exact provider provenance')
