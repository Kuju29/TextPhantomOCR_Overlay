"""API-owned pages join the same bounded cross-page data policy as the browser.
Only provider requests own receipts; page projections carry shared references.
"""
from __future__ import annotations
import copy
from dataclasses import fields
import hashlib
import json
import uuid
from backend.ai import markers, wire_trace, trace_preview
from backend.ai.accounting import receipt_scope, adopt_receipt_references
from backend.ai.translation.invocation import translate
from backend.ai.usage import aggregate_usage
from backend.ai.errors import ModelOutputContractError
from backend.jobs.stages.ai_repair import _target_script_diagnostic
from backend.jobs.stage_admission import stage_slot
from .store import execution_scope
from .batch_policy import select_rows,learn
from .ready_registry import ReadyRegistry


def emit(value):
    trace_preview.note('AI conversation ready batch',value)
    wire_trace.write_json('03_conversation_batch.json',value)


def dispatch(rows,estimate,reason,profile):
    owners=list(dict.fromkeys(r['ticket'] for r in rows));first=owners[0]
    ai=type(first.ai)(**{f.name:copy.deepcopy(getattr(first.ai,f.name)) for f in fields(first.ai)});batch_id=str(uuid.uuid4());texts=[r['text'] for r in rows]
    origins=[]
    for t in owners:
        d=t.ai.conversation or {};own=[(i,r) for i,r in enumerate(rows) if r['ticket'] is t]
        origins.append({**{k:d[k] for k in ('pageId','pageIndex','pageOrder') if k in d},
          'pageId':d.get('pageId') or f'page-{t.order}',
          'unitIds':[r['id'] for i,r in own],'originalIds':[f"P{r['index']}" for i,r in own],
          'sourceFingerprint':hashlib.sha256(json.dumps(t.units,ensure_ascii=False).encode()).hexdigest()})
    ai.conversation={**ai.conversation,'origins':origins,'planner':'conversation_cross_page','batchId':batch_id,'orderPolicy':'request_arrival'}
    ai.workload={k:v for k,v in estimate.items() if k!='baseOutput'};ai.repair_enabled=False
    stopped=lambda:all(t.finished or (t.options.get('cancel_check') and t.options['cancel_check']()) for t in owners)
    evidence={'schema':'tp.conversation_batch/1','planner':'conversation_cross_page','phase':'dispatch','batchId':batch_id,
      'pageCount':len(owners),'unitCount':len(rows),'splitReason':reason,'idPolicy':'conversation_image_unit_v1',
      'readyQueueWaitMs':round(max(t.previous_wait_ms+t.source_wait_ms for t in owners),3),
      'previousTurnWaitMs':round(max(t.previous_wait_ms for t in owners),3),
      'sourceOrderWaitMs':round(max(t.source_wait_ms for t in owners),3),'estimatedInput':estimate['estimatedInput'],
      'predictedOutput':estimate['predictedOutput'],'legacyFallback':False,'providerCallsAdded':0,'usageOwner':'provider_request',
      'conversationCapacity':estimate.get('conversationCapacity'),
      'cacheConfirmed':profile.get('cacheConfirmed') is True,
      'cacheRatio':float(profile.get('cacheRatio') or 0.0)}
    token=wire_trace.begin({'operationId':batch_id,'recordKind':'provider_request','engine':'api','attemptKind':'initial','origins':origins,'batchId':batch_id})
    try:
        emit(evidence)
        with receipt_scope('runsapi',batch_id):
            with execution_scope(ai,first.target,stopped):
                with stage_slot('ai',first.options['admission_identity'],unlimited=first.options.get('admission_unlimited',False)):
                    result=translate(markers.apply(texts),first.target,ai,cancel_check=stopped,capture_request=first.options.get('capture_request',False))
        parsed=markers.extract_paragraphs_exact(result.get('aiTextFull',''),len(rows))
        values=parsed[0] if parsed else ['']*len(rows)
        # Preserve good records. The existing page renderer treats empty failed
        # records as unresolved instead of drawing an unvalidated foreign answer.
        values=[v if _target_script_diagnostic(v,first.target,s).get('decision')!='reject' else '' for s,v in zip(texts,values)]
        learn(profile,result,estimate)
        emit({**evidence,'phase':'distributed','mappedUnits':sum(bool(v.strip()) for v in values),
              'missingUnits':sum(not v.strip() for v in values),'providerCallsAdded':1,'providerRequestCount':1})
        wire_trace.write_json('08_batch_mapping.json',{'batchId':batch_id,'origins':origins,'values':values})
        wire_trace.terminal(state='succeeded',stage='response_mapping')
        return {'batchId':batch_id,'values':values,'meta':result.get('meta') or {}}
    except BaseException as exc:
        wire_trace.record_error(exc,stage='conversation_batch')
        details=getattr(exc,'structural_details',{}) or {}
        meta=dict(getattr(exc,'generationMeta',None) or details.get('generationMeta') or {})
        if isinstance(exc,ModelOutputContractError) and (meta.get('usage') or {}).get('receiptId') and not stopped():
            # A real generated contract failure enters the existing unit repair
            # pool. Keep earlier good chunks and the charged receipt, never
            # retry the whole combined initial batch to "fix" its history.
            meta.update(generation_attempts=1,provider_attempts=1,conversationBatchFailure=str(getattr(exc,'code','model_output_contract')))
            emit({**evidence,'phase':'failed','mappedUnits':0,'missingUnits':len(rows),'providerCallsAdded':1,'providerRequestCount':1})
            wire_trace.write_json('08_batch_mapping.json',{'batchId':batch_id,'origins':origins,'values':['']*len(rows),'failureCode':meta['conversationBatchFailure']})
            wire_trace.terminal(state='failed',stage='response_mapping')
            return {'batchId':batch_id,'values':['']*len(rows),'meta':meta}
        raise
    finally:wire_trace.end(token)


def project(t):
    meta={**t.meta,'usageScope':'shared_batch_receipts','sharedRequestRefs':t.refs,
          'ai_flow':'conversation_cross_page','translationMode':'conversation',
          'generation_attempts':len(t.refs),'provider_attempts':len(t.refs)}
    # Every generation has a stable receiptId. Returning receipt references with
    # several pages lets the existing ledger deduplicate even if one page is lost.
    if t.receipts:meta['usage']=aggregate_usage(t.receipts)
    if t.units and not any(str(v).strip() for v in t.values.values()):
        error=ModelOutputContractError('Conversation page has no validated translations',response_shape='conversation_page_projection',missingIds=[f'P{i}' for i in range(len(t.units))],generationMeta=meta)
        error.generationMeta=meta;error.generationAttempts=len(t.refs)
        error.providerAttempts=len(t.refs);error.requestDispatched=bool(t.refs)
        raise error
    return {'aiTextFull':markers.apply([t.values.get(i,'') for i in range(len(t.units))]),'meta':meta}


registry=ReadyRegistry(dispatch,select_rows,project,emit)

def reserve(ai,target):
    if ai is None or ai.translation_mode!='conversation':return None
    ticket=registry.reserve(ai,target);ai._ready_ticket=ticket
    return ticket


def finish(ticket):
    if ticket is not None:registry.finish(ticket)


def translate_ready(texts,target,ai,**options):
    ticket=getattr(ai,'_ready_ticket',None)
    if ticket is None or ticket.finished:ticket=reserve(ai,target)
    # Distinct live memory/speaker context and image attachments are not silently
    # combined. The next ready batch will pick up that context independently.
    options['compat']=json.dumps([ai.glossary,ai.characters,ai.series_state,ai.prev_context,ai.speakers,
        ai.page_context,ai.source_context,ai.context_frozen],ensure_ascii=False,sort_keys=True)
    try:
        result=registry.submit(ticket,texts,**options)
        adopt_receipt_references((result.get('meta') or {}).get('usage') or {})
        return result
    except Exception as exc:
        adopt_receipt_references((getattr(exc,'generationMeta',{}) or {}).get('usage') or {})
        raise
    finally:finish(ticket)
