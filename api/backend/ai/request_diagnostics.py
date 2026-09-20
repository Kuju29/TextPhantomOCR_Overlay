"""Evidence-only request summary; usage, estimates and account quota never mix."""
from collections.abc import Mapping

def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None

def request_diagnostics(meta, *, workload=None, rate=None, missing=0):
    usage = meta.get('usage') if isinstance(meta.get('usage'), Mapping) else {}
    w = workload if isinstance(workload, Mapping) else {}
    r = rate if isinstance(rate, Mapping) else {}
    limits = meta.get('modelLimits') if isinstance(meta.get('modelLimits'), Mapping) else {}
    cached = _count(usage.get('cachedInputTokens'))
    output, reasoning = _count(usage.get('outputTokens')), _count(usage.get('thinkingTokens'))
    finish = str(meta.get('finishReason') or '')
    truncated = finish in ('length','max_tokens','max_output_tokens','truncated')
    return {'schema':'tp.request_diagnostics/1',
        'boundary':'api_response_mapping', 'httpStatus':200,
        'instructionLayout':{key: meta.get('promptLayout', {}).get(key) for key in (
            'policyVersion', 'styleRole', 'systemStyleCopies', 'userStyleCopies',
            'styleChars', 'styleSha256', 'systemChars', 'userStaticChars', 'userPersistentStaticChars',
            'bootstrapExamplesChars', 'examplesEnabled', 'examplesIncluded', 'staticPrefixSha256')}
            if isinstance(meta.get('promptLayout'), Mapping) else None,
        'cacheCoordination':meta.get('cacheCoordination'),
        'translationMode':meta.get('translationMode','independent'),
        'conversation':meta.get('conversation'),
        **{key: meta.get(key) for key in (
            'plannedOutputContract', 'selectedOutputContract', 'selectionReason',
            'decodedResponseShape', 'parserId', 'formatSwitch')},
        'contractStatus':'partial' if missing else 'complete',
        'languageStatus':'pending_extension_validation','placementStatus':'not_started',
        'outputLimitReached':truncated,'outputTruncated':truncated and missing>0,'finishReason':finish or None,
        'inputActual':_count(usage.get('inputTokens')),'outputActual':output,'reasoningActual':reasoning,
        'visibleOutputActual':output-reasoning if output is not None and reasoning is not None and reasoning<=output else None,
        'cache':{'status':'not_reported' if cached is None else 'reported_hit' if cached>0 else 'reported_zero',
                 'inputTokens':cached,'hit':None if cached is None else cached>0,
                 'support':'unknown','interpretation':'provider_report_not_support_probe'},
        'requestBudget':{'scope':'per_request','estimatedInput':_count(w.get('estimatedInput')),
            'estimatedOutput':_count(w.get('predictedOutput')),'reasoningReserve':_count(w.get('reasoningReserve')),
            'requestedMaxOutput':_count(meta.get('requestedOutputTokens')),
            'contextLimit':_count(limits.get('contextTokens')),'outputLimit':_count(limits.get('maxOutputTokens')),
            'estimateKind':'script_weight_calibrated_from_valid_provider_usage' if w else 'not_reported'},
        'quota':{'scope':'account_model_time_window','mode':meta.get('rateMode') or 'unknown',
            'rpmConfigured':r.get('rpm') if r.get('enabled') else None,
            'tpmLimit':None,'limitSource':'user_config' if r.get('enabled') else 'not_reported',
            'waitMs':meta.get('rateWaitMs')},
        'admission':{'scope':'server_concurrency','waitMs':meta.get('admissionWaitMs')},
        'timing':{'providerMs':meta.get('providerMs'),'firstContentMs':meta.get('firstContentMs'),'apiElapsedMs':meta.get('dt_ms'),
                  'cacheWaitMs':(meta.get('cacheCoordination') or {}).get('waitMs')},
        'missingCount':int(missing),'totalsRule':'output_includes_reasoning_input_includes_cache'}
