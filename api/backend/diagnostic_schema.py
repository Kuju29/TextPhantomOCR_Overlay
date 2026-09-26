"""Bounded typed diagnostics. Cross-runtime fixtures enforce the JS wire contract."""
import json
import math
import re
from pathlib import Path
_TABLE = {k: set(v) for k, v in json.loads(Path(__file__).with_name('diagnostic-schema.json').read_text()).items()}
_ID = re.compile(r'^(?:[a-f0-9]{16,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|t[a-z0-9]{8,40}|(?:p|g|P|R|c|i)\d+(?:[-:]\w{1,12})?|tr:\d+|(?:ai|repair):[a-f0-9-]{16,64}(?::[a-zA-Z0-9-]{1,64}){0,5})$', re.ASCII)
def _id(v):
    return v if isinstance(v,str) and len(v)<=240 and _ID.fullmatch(v) else None
def _part(v, depth=0):
    if not isinstance(v,dict) or depth>3: return {}
    out={}
    for k,x in list(v.items())[:40]:
        if k in _TABLE['numeric']: out[k]=math.floor(x*1000+0.5)/1000 if type(x) in (int,float) and math.isfinite(x) else None
        elif k in _TABLE['ids']: out[k]=_id(x)
        elif k=='ids' and isinstance(x,list): out[k]=[_id(i) for i in x[:12]]
        elif k in ('before','after','timing','counts','planned','effective','observed','scope','evidence'): out[k]=_part(x,depth+1)
        elif k=='rows' and isinstance(x,list): out[k]=[_part(row,depth+1) for row in x[:12]]
        elif k=='boundary': out[k]=x if isinstance(x,str) and x in ('transport_reader','decoded_transport_reader') else 'unknown'
        elif k=='terminalKind': out[k]=x if isinstance(x,str) and x in ('none','protocol_done','provider_done','provider_terminal','finish_reason') else 'none'
        elif k=='reason': out[k]=x if isinstance(x,str) and x in _TABLE['reasons'] else 'unknown'
        elif k in ('imageHint','sourceRoute','compositionState','compositionKind','compositionGrid','compositionCode'):
            allowed={
                'imageHint':('scrambled','plain','unknown'),
                'sourceRoute':('url_with_referer','kagane_page'),
                'compositionState':('plain','detected','complete','failed'),
                'compositionKind':('plain','tiles','bytes','site','unknown'),
                'compositionGrid':('5x5','none','unknown'),
                'compositionCode':('metadata_missing','grid_unsupported','algo_unsupported','decode_failed','unavailable','size_invalid','encode_failed','failed','unknown'),
            }
            out[k]=x if isinstance(x,str) and x in allowed[k] else 'unknown'
        elif k in ('contextPolicy','contextReason','connectionStage','verificationStatus','errorCode','constraintScope','instructionLocale','memoryMode','estimateKind','cacheStatus','resultStatus','attemptKind'):
            allowed={
                'connectionStage':('list_models','verify_model','model_metadata','save_snapshot','result','ui_apply'),
                'verificationStatus':('passed','timeout','rejected','invalid_output','unreachable','thinking_required','not_tested','model_unavailable','unsupported_model','not_selected'),
                'errorCode':('local_ai_unreachable','local_ai_timeout','local_ai_discovery_failed','local_ai_invalid_response','local_ai_http_error','local_ai_invalid_adapter','local_ai_empty_models','local_models_empty','local_models_http_error','invalid_local_endpoint','local_provider_response_contract','ai_endpoint_missing','cancelled'),
                'constraintScope':('per_request','reliability','account_window','runtime_concurrency','unknown'),
                'instructionLocale':('th','en','ja'),
                'memoryMode':('off','terms','full','legacy_filtered'),
                'estimateKind':('script_weight_calibrated_from_valid_provider_usage','script_weight_with_output_calibration'),
                'contextPolicy':('ollama-request-context-v1',),
                'contextReason':('bounded_growth','bounded_limit','model_limit_unknown','current_window'),
                'cacheStatus':('not_reported','reported_hit','reported_zero'),
                'resultStatus':('complete_at_contract_boundary','incomplete_ids','wrong_language','output_truncated','cancelled','transport_failure','protocol_failure','rate_limited','input_budget_rejected','unverified'),
                'attemptKind':('initial','repair'),
            }
            default={'instructionLocale':'en','cacheStatus':'not_reported','resultStatus':'unverified','attemptKind':'initial'}.get(k,'unknown')
            out[k]=x if isinstance(x,str) and x in allowed[k] else default
        elif k=='phase': out[k]=x if isinstance(x,str) and x in _TABLE['phases'] else 'waiting'
        elif k=='contract': out[k]=x if isinstance(x,str) and x in _TABLE['contracts'] else 'unknown'
        elif k in ('persistence','decisionStatus'): out[k]=x if isinstance(x,str) and x in _TABLE['states'] else 'unknown'
        elif k in ('sourceKind','engine','route','thinking','direction','effectiveFrom'):
            allowed={'sourceKind':('original','translated','ai'),'engine':('extension','api'),
                'route':('direct-local','server','api','extension'),'thinking':('on','off','auto','default','minimum','minimal','low','medium','high','xhigh','max','ultra','unknown'),
                'direction':('h','v','tilted','unknown'),'effectiveFrom':('next_request','current_request','current_image','next_job','unknown')}
            out[k]=x if isinstance(x,str) and x in allowed[k] else 'unknown'
        elif k in ('hidden','hiddenAtStart','hiddenAtFinish','replayed','deduplicated','idempotent','contextVerified','requestDispatched','ready','reused','retryable','metadataOnly','wholePage','hardFits','reliabilityFits','cacheReported','examplesEnabled','changed','complete','pageImage','memoryEnabled','traceEnabled','rotated','eraseEnabled','unlimited'): out[k]=x if type(x) is bool else None
    return out
def sanitize_audit(value):
    if not isinstance(value,dict) or value.get('schema')!='tp.audit/1': return None
    ev=value.get('event')
    return {'schema':'tp.audit/1','event':ev if isinstance(ev,str) and ev in _TABLE['events'] else 'unknown',**_part(value)}


def sanitize_prompt_layout(value):
    """Fixed layout allowlist: retain counts/hashes without arbitrary prompt text."""
    if not isinstance(value, dict) or value.get('schema') != 'tp.prompt_layout/1':
        return None
    out = {'schema': 'tp.prompt_layout/1'}
    for key in ('systemStyleCopies', 'userStyleCopies', 'styleChars', 'systemChars', 'userStaticChars', 'userPersistentStaticChars', 'bootstrapExamplesChars', 'dynamicChars'):
        if key in value:
            v = value[key]
            out[key] = v if type(v) is int and 0 <= v <= 9007199254740991 else None
    for key in ('styleSha256', 'systemSha256', 'userStaticSha256', 'userPersistentStaticSha256', 'staticPrefixSha256'):
        if key in value:
            v = value[key]
            out[key] = v if isinstance(v, str) and re.fullmatch(r'[a-f0-9]{64}', v) else None
    enums = {'styleRole': ('user', 'system', 'both', 'absent', 'unknown'), 'instructionLocale': ('th', 'en', 'ja'),
             'memoryMode': ('off', 'terms', 'full', 'legacy_filtered'), 'countUnit': ('unicode_characters',),
             'styleCountScope': ('instruction_blocks',), 'cacheSupport': ('unknown',)}
    for key, allowed in enums.items():
        if key in value:
            out[key] = value[key] if isinstance(value[key], str) and value[key] in allowed else 'unknown'
    for key in ('examplesEnabled', 'examplesIncluded', 'cacheHit'):
        if key in value:
            out[key] = value[key] if type(value[key]) is bool else None
    for key in ('targetLang', 'sourceLang'):
        if key in value:
            v = value[key]
            out[key] = v if isinstance(v, str) and re.fullmatch(r'(?:[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}|mixed|auto|)', v) else 'unknown'
    if 'policyVersion' in value:
        v = value['policyVersion']
        out['policyVersion'] = v if isinstance(v, str) and re.fullmatch(r'(?:system-style-single-owner|system-style-human-bootstrap|user-style-single-owner|localized-page-first)-\d{4}(?:\.\d{1,2}){3}', v) else 'unknown'
    if 'operationId' in value:
        out['operationId'] = _id(value['operationId'])
    return out


def sanitize_cache_coordination(value):
    """Cache scheduling is evidence, never proof of a provider cache entry."""
    if not isinstance(value, dict) or value.get('schema') != 'tp.cache_coordination/1':
        return None
    out = {'schema': 'tp.cache_coordination/1'}
    enums = {
        'phase': ('waiting', 'admitted', 'dispatch', 'finished'),
        'mode': ('best_effort', 'observe_only', 'runtime_managed', 'disabled', 'unsupported', 'missing_prefix'),
        'role': ('leader', 'observer', 'follower', 'reuse', 'passive', 'bypass'),
        'reason': ('cold_group','recent_group','leader_pending','leader_terminal','leader_failed','leader_cancelled',
                   'wait_limit','wait_disabled','runtime_managed','disabled','unsupported','missing_prefix',
                   'follower_cancelled','registry_expired','registry_evicted','released',
                   'new_group','next_request','lease_expired','leader_active','leader_capacity'),
        'releaseReason': ('leader_terminal','leader_failed','leader_cancelled','wait_limit','wait_disabled',
                          'runtime_managed','registry_expired','registry_evicted','stale_completion',
                          'lease_expired','lease_superseded','observation_complete'),
        'registryScope': ('api_process','extension_worker'),
        'coordinationPolicy': ('observe_no_wait',),
        'namespaceScope': ('credential_endpoint_model_prefix',),
        'leaderLeaseState': ('active','released','expired','superseded','not_tracked'),
        'cacheStatus': ('not_reported','reported_hit','reported_zero'),
        'missReason': ('unknown',),
    }
    for key, values in enums.items():
        if key in value:
            v = value[key]; out[key] = v if isinstance(v, str) and v in values else None
    for key in ('groupId','staticPrefixSha256'):
        if key in value:
            v=value[key];out[key]=v if isinstance(v,str) and re.fullmatch('[a-f0-9]{64}',v) else None
    for key in ('coordinationId','leaderCoordinationId','operationId'):
        if key in value: out[key]=_id(value[key])
    for key in ('waitMs','waitLimitMs','retentionMs','previousCompletions','cachedInputTokens',
                'leaderLeaseMs','observationLimit','activeLeaderLimit','observationOrder','previousObservationOrder','previousObservationAgeMs'):
        if key in value:
            v=value[key];out[key]=round(v,3) if type(v) in (int,float) and math.isfinite(v) and 0<=v<=9007199254740991 else None
    for key in ('reusedGroup','previousCacheHit','requestDispatched','terminalCompleted','observationRecorded','latestObservationApplied'):
        if key in value: out[key]=value[key] if type(value[key]) is bool else None
    # A client cannot assert cache-ready from completion or from a cache hit.
    if 'providerCacheReady' in value: out['providerCacheReady']=None
    if 'providerCacheTtlMs' in value: out['providerCacheTtlMs']=None
    for key in ('targetLang','sourceLang'):
        if key in value:
            v=value[key];out[key]=v if isinstance(v,str) and re.fullmatch(r'(?:[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}|mixed|auto|)',v) else 'unknown'
    return out

_CONVERSATION = json.loads(Path(__file__).with_name("conversation-diagnostic-schema.json").read_text())


def sanitize_conversation(value):
    """Content-free history provenance. No keys, source or answers in compact logs."""
    if not isinstance(value, dict) or value.get('schema') != 'tp.conversation/1':
        return None
    spec = _CONVERSATION
    out = {'schema':'tp.conversation/1'}
    for key, allowed in spec['enums'].items():
        if key in value: out[key] = value[key] if value[key] in allowed else None
    for key in spec['numeric']:
        if key in value:
            n = value[key]
            out[key] = math.floor(n*1000+0.5)/1000 if type(n) in (int,float) and math.isfinite(n) and 0<=n<=9007199254740991 else None
    for key in spec['booleans']:
        if key in value: out[key] = value[key] if isinstance(value[key], bool) else None
    for key in ('scope','historySha256','prefixSha256'):
        if key in value:
            v=value[key]
            out[key] = v if isinstance(v,str) and (re.fullmatch(r'[a-f0-9]{24}|[a-f0-9]{64}',v) or key=='scope' and v=='ephemeral') else None
    if 'historyMessageRoles' in value:
        v=value['historyMessageRoles']
        out['historyMessageRoles'] = v if isinstance(v,str) and len(v)<=4096 and (not v or re.fullmatch(r'user,assistant(?:,user,assistant)*',v)) else None
    for key in ('hfInferenceProviderAffinity','resolvedUpstreamProvider'):
        if key in value:
            v=value[key]
            out[key]=v if isinstance(v,str) and re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}',v) else None
    return out

_BATCH = json.loads(Path(__file__).with_name("conversation-batch-diagnostic-schema.json").read_text())
def sanitize_conversation_batch(value):
    if not isinstance(value,dict) or value.get("schema")!="tp.conversation_batch/1":return None
    out={"schema":"tp.conversation_batch/1"}
    for k,allowed in _BATCH["enums"].items():
        if k in value:out[k]=value[k] if value[k] in allowed else None
    for k in _BATCH["numeric"]:
        if k in value:
            v=value[k];out[k]=math.floor(v*1000+0.5)/1000 if type(v) in (int,float) and math.isfinite(v) and 0<=v<=9007199254740991 else None
    for k in _BATCH["booleans"]:
        if k in value:out[k]=value[k] if type(value[k]) is bool else None
    if "validationField" in value:
        v=value["validationField"]
        out["validationField"] = v if isinstance(v,str) and len(v)<=120 and re.fullmatch(r"conversation\.origins(?:\.[a-zA-Z0-9]+)*",v) else None
    if "batchId" in value:out["batchId"]=_id(value["batchId"])
    return out
