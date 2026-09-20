"""Evidence-only API status tests. No provider or external network calls."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from backend.ai.request_diagnostics import request_diagnostics
from backend.ai.prompts.builder import build_static_user_prefix
from backend.ai.prompts.layout import prompt_layout

checks=0
for cache in (None, 0, 256):
    for missing in (0, 2):
        for finish in ('stop','length'):
            usage={'inputTokens':1000,'outputTokens':100,'thinkingTokens':30}
            if cache is not None: usage['cachedInputTokens']=cache
            d=request_diagnostics({'usage':usage,'finishReason':finish,'requestedOutputTokens':512},
                workload={'estimatedInput':900,'predictedOutput':80},rate={'enabled':True,'rpm':10},missing=missing)
            assert d['httpStatus']==200 and d['contractStatus']==('partial' if missing else 'complete')
            assert d['languageStatus']=='pending_extension_validation' and d['placementStatus']=='not_started'
            assert d['visibleOutputActual']==70 and d['outputActual']==100
            assert d['cache']['hit']==(None if cache is None else cache>0)
            assert d['outputLimitReached']==(finish=='length')
            assert d['outputTruncated']==(finish=='length' and missing>0)
            assert d['quota']['tpmLimit'] is None and d['quota']['rpmConfigured']==10
            assert d['requestBudget']['estimatedInput']==900 and d['inputActual']==1000
            checks+=1
unknown=request_diagnostics({})
assert unknown['inputActual'] is None and unknown['reasoningActual'] is None
assert unknown['cache']['status']=='not_reported' and unknown['quota']['tpmLimit'] is None
bad=request_diagnostics({'usage':{'inputTokens':True,'outputTokens':4,'thinkingTokens':5,'cachedInputTokens':-1}})
assert bad['inputActual'] is None and bad['visibleOutputActual'] is None and bad['cache']['inputTokens'] is None
print(f'PASS {checks+2} API diagnostic cases: partial vs HTTP success, complete-at-limit vs truncation, null/zero/cache hit, no double reasoning, estimate vs actual, unknown TPM.')
