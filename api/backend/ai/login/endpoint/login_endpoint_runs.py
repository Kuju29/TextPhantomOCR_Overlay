"""Owner/session/run-pinned native conversations and bounded no-replay ledger."""
import hashlib
import json
import os
import time
from threading import RLock, Event
from copy import deepcopy
from contextlib import contextmanager
from .. import login_session_store as store, login_observability as diagnostic
from ..login_provider_contract import LoginError
from ..login_answer_policy import reject_policy_refusal, reject_provider_error_reply

_lock = RLock()
_runs = {}
_accounts = {}
MAX_RUNS, MAX_SESSION_RUNS, MAX_OPERATIONS, TTL = 4096, 128, 256, 600

MAX_IMAGE_BYTES = 10 * 1024 * 1024


def decode_image(value):
    """Base64 page image -> (bytes, mime). Type from the bytes, never a name."""
    import base64, binascii
    try:
        data = base64.b64decode(str(value).split(',', 1)[-1], validate=True)
    except (binascii.Error, ValueError):
        raise LoginError('login_image_invalid', 'The page image could not be read.', 400) from None
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise LoginError('login_image_invalid', 'The page image is empty or larger than 10 MB.', 400)
    if data[:3] == b'\xff\xd8\xff':
        return data, 'image/jpeg'
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return data, 'image/png'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return data, 'image/webp'
    raise LoginError('login_image_invalid', 'Only JPEG, PNG or WebP page images can be sent to a website.', 400)


def clear():
    with _lock:
        for run in _runs.values():
            run['cancel'].set()
        _runs.clear()
        _accounts.clear()

def _interval_seconds():
    try:
        value = int(os.environ.get('TP_LOGIN_ENDPOINT_MIN_INTERVAL_MS', '0'))
    except (TypeError, ValueError):
        value = 0
    return max(0, min(60000, value)) / 1000

@contextmanager
def _account_admission(session, check):
    """Serialize the same account and honor provider/explicit local cooldowns.

    This is a local pacing policy, not a claim about the provider's limits.
    Account credentials themselves never enter this queue or its diagnostics.
    """
    key = session.get('credential') or session['id']
    began = time.monotonic()
    with _lock:
        for old_key, gate in list(_accounts.items()):
            if not gate['users'] and began - gate['finished'] > TTL:
                del _accounts[old_key]
        gate = _accounts.get(key)
        if gate is None:
            if len(_accounts) >= store.MAX_ACTIVE:
                raise LoginError('login_capacity_reached', 'The API Login queue is full. Try again shortly.', 503)
            gate = {'lock': RLock(), 'users': 0, 'finished': 0.0, 'blocked_until': 0.0}
            _accounts[key] = gate
        gate['users'] += 1
    acquired = False
    try:
        while not gate['lock'].acquire(timeout=.1):
            check()
        acquired = True
        while True:
            check()
            remaining = max(gate['finished'] + _interval_seconds(), gate['blocked_until']) - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(.1, remaining))
        yield round((time.monotonic() - began) * 1000, 1)
    except LoginError as error:
        retry_after = getattr(error, 'retry_after_ms', 0)
        if acquired and error.status == 429 and type(retry_after) in (int, float) and retry_after > 0:
            gate['blocked_until'] = max(gate['blocked_until'], time.monotonic() + min(300000, retry_after) / 1000)
        raise
    finally:
        if acquired:
            gate['finished'] = time.monotonic()
            gate['lock'].release()
        with _lock:
            gate['users'] -= 1

def purge(session_id):
    with _lock:
        for key, run in list(_runs.items()):
            if key[0] == session_id:
                run['cancel'].set()
                del _runs[key]

def generate(session, request, module):
    from backend.ai import accounting
    context = request.cache_context
    run_id, operation = context.get('webchatRunId'), context.get('operationId')
    if not isinstance(run_id, str) or not run_id or len(run_id) > 160 or \
            not isinstance(operation, str) or not operation or len(operation) > 160:
        raise LoginError('login_run_required', 'Endpoint translation requires its original run and operation identifiers.', 400)
    # Images go only to a website whose upload path is implemented
    # (ENDPOINT_IMAGES); the model row's vision flag is checked before this.
    image = None
    if request.image_b64:
        if not getattr(module, 'ENDPOINT_IMAGES', False):
            raise LoginError('login_image_unsupported',
                'This website connection cannot receive images yet. Turn off Page image to AI for this Login model.', 400)
        image = decode_image(request.image_b64)
    branch = context.get('webchatBranch', 'initial')
    user = '\n'.join(request.user_parts)
    source = context.get('conversationSource')
    source = source if isinstance(source, str) and source else user
    system_hash = hashlib.sha256(request.system_text.encode()).hexdigest()
    # Mutable memory and local parser history must not change the same operation.
    # Pin its actual source; the remote run owns the one-time bootstrap.
    image_hash = hashlib.sha256(image[0]).hexdigest() if image else ''
    fingerprint = hashlib.sha256(json.dumps([source, system_hash, request.model, branch] + ([image_hash] if image else []), ensure_ascii=False).encode()).hexdigest()
    key, op = (session['id'], run_id), (operation, branch)
    with _lock:
        store.credential_for_session(session)
        active = store.active_session_ids()
        for stale in list(_runs):
            if stale[0] not in active:
                _runs[stale]['cancel'].set()
                del _runs[stale]
            elif _runs[stale]['expires'] <= time.monotonic():
                old = _runs[stale]
                old['cancel'].set()
                # Keep a bounded no-replay tombstone until disconnect/restart.
                # Network code owns its lock and clears state on unwind.
                if old['lock'].acquire(blocking=False):
                    try:
                        old['remote'].clear()
                        for item in old['operations'].values():
                            item.pop('result', None)
                    finally:
                        old['lock'].release()
        run = _runs.get(key)
        if run is None:
            if len(_runs) >= MAX_RUNS or sum(k[0] == session['id'] for k in _runs) >= MAX_SESSION_RUNS:
                raise LoginError('login_run_limit', 'Reconnect before starting more endpoint conversations.', 429)
            if request.history_messages:
                raise LoginError('login_chat_lost', 'The original endpoint conversation is unavailable. Start a new translation run.', 409)
            run = {'lock': RLock(), 'cancel': Event(), 'system_hash': system_hash,
                   'model': request.model, 'remote': {}, 'operations': {}, 'expires': time.monotonic() + TTL}
            _runs[key] = run

    def check():
        store.credential_for_session(session)
        if run['expires'] <= time.monotonic():
            run['cancel'].set()
            raise LoginError('login_run_expired', 'The endpoint conversation expired. Start a new run.', 409)
        if run['cancel'].is_set() and run.get('stopped_by'):
            # Pages after a failed sent turn report that failure, not a bare
            # "cancelled".
            code, message, status = run['stopped_by'][:3]
            error = LoginError(code, 'An earlier page of this run failed: ' + message, status)
            # Nothing is sent for this page. It reports the earlier sent page's
            # provider outcome (not an authorization/entitlement fault).
            error.stage, error.earlier_page_failed = 'endpoint_run_stopped', True
            error.retryable = run['stopped_by'][3] if len(run['stopped_by']) > 3 else False
            raise error
        if run['cancel'].is_set() or (request.cancel_check and request.cancel_check()):
            run['cancel'].set()
            raise LoginError('login_cancelled', 'Endpoint translation was cancelled. Start a new run.', 409)

    while not run['lock'].acquire(timeout=.25):
        check()
    row = None
    try:
        check()
        if run['system_hash'] != system_hash:
            raise LoginError('login_chat_instructions_changed', 'Translation instructions changed. Start a new run.', 409)
        if run['model'] != request.model:
            raise LoginError('login_chat_model_changed', 'The conversation model changed. Start a new run.', 409)
        rollover = context.get('webchatRolloverReason')
        trimmed = context.get('webchatTrimmedTurns')
        # Local budgeting may retire parser history; the verified session/run
        # still owns the remote thread and its original bootstrap. Never replay
        # that bootstrap or use a different thread to hide actual context loss.
        local_only = (rollover == 'context_budget' and run.get('native_confirmed') is True and bool(run['remote']) and
                      isinstance(context.get('conversationSource'), str) and bool(context['conversationSource']))
        if (trimmed or rollover not in (None, '', 'none')) and not local_only:
            raise LoginError('login_chat_context_changed', 'The original conversation context changed. Start a new run.', 409)
        row = run['operations'].get(op)
        if row:
            if row['fingerprint'] != fingerprint:
                raise LoginError('login_turn_conflict', 'This endpoint operation already has different input.', 409)
            if row.get('result'):
                return deepcopy(row['result'])
            error = LoginError(row.get('code') or 'login_send_ambiguous',
                'This endpoint operation ended without a confirmed answer and will not be resent.', 409)
            error.requestDispatched = row['dispatched']
            raise error
        if len(run['operations']) >= MAX_OPERATIONS:
            raise LoginError('login_run_limit', 'Start a new endpoint conversation.', 429)
        row = {'fingerprint': fingerprint, 'dispatched': False}
        run['operations'][op] = row
        tokens = store.credential_for_session(session)['tokens']
        first = not bool(run['remote'])
        current_user = user if first else source
        prompt = request.system_text + '\n\n' + current_user if first else current_user
        delivery = {'transport': 'provider_remote_thread', 'firstTurn': first,
                    'systemDelivery': 'current_request' if first else 'provider_native_state',
                    'systemChars': len(request.system_text) if first else 0,
                    'currentUserChars': len(current_user),
                    'bootstrapUserChars': max(0, len(user) - len(source)) if first else 0,
                    'continuationUserOcrOnly': not first and bool(context.get('conversationSource')),
                    'repairInstructionChars': 0}
        from backend.ai import wire_trace
        wire_trace.write_json('04_provider_request.json', {'schema': 'tp.login_endpoint_request/1', **delivery})
        wire_trace.write_text('04_login_endpoint_prompt.txt', prompt)

        def dispatch():
            check()
            row['dispatched'] = True
            accounting.mark_dispatched()

        diagnostic.stage('endpoint_account_queue')
        with _account_admission(session, check) as account_wait_ms:
            diagnostic.stage('endpoint_generation')
            # Only a site with a verified thinking switch receives the user's choice.
            extra = {'thinking': request.thinking} if getattr(module, 'ENDPOINT_THINKING', False) else {}
            if getattr(module, 'ENDPOINT_MODEL_ROW', False):
                # The site's own per-model control (claude.ai chat picker),
                # from this session's verified catalogue, never from the request.
                base_model = request.model.split('/', 1)[-1]
                extra['model_row'] = deepcopy(next((item for item in tokens.get('models', [])
                    if isinstance(item, dict) and item.get('id') == base_model), None))
            if image:
                extra['image'] = image
            from . import login_browser_relay as relay
            with relay.owner(session.get('owner', '')):
                result = module.endpoint_generate(tokens['credentials'], prompt, run['remote'], request.model.split('/', 1)[-1], check, dispatch, **extra)
        check()
        if not isinstance(result.get('text'), str) or not result['text'].strip() or result.get('completed') is not True:
            raise LoginError('login_endpoint_response_invalid', 'The endpoint did not confirm a completed answer.', 502)
        # Wire capture is already opt-in and includes source/prompt text. Save
        # the assembled answer here, never provider cookies or HTTP form data.
        wire_trace.write_text('05_provider_response.assembled.txt', result['text'])
        wire_trace.write_json('05_provider_response.meta.json', {
            'status': (result.get('statuses') or [None])[-1],
            'streamed': True, 'complete': True, 'upstreamProvider': session['provider']})
        wire_trace.write_json('05_login_endpoint_evidence.json', {
            'schema': 'tp.login_endpoint_response/1', 'provider': session['provider'],
            'httpStatuses': result.get('statuses', []), 'terminal': result.get('terminal', ''),
            'terminalCompleted': True, 'textChars': len(result['text']), 'accountWaitMs': account_wait_ms})
        reject_policy_refusal(result['text'])
        reject_provider_error_reply(result['text'], session['provider'], (result.get('statuses') or [None])[-1])
        result = {**result, 'prompt_delivery': delivery, 'account_wait_ms': account_wait_ms}
        run['native_confirmed'] = True
        row['result'] = deepcopy(result)
        run['expires'] = time.monotonic() + TTL
        diagnostic.stage('endpoint_completed')
        return result
    except LoginError as error:
        if row is not None:
            row['code'] = error.code
            error.requestDispatched = error.requestDispatched or row['dispatched']
            if row['dispatched']:
                # Never continue a conversation after an uncertain sent turn.
                run.setdefault('stopped_by', (error.code, str(error)[:300], getattr(error, 'status', 409) or 409,
                                              getattr(error, 'retryable', False) is True))
                run['cancel'].set()
        if error.code == 'login_session_expired':
            store.invalidate_native(session)
        shape = getattr(error, 'response_shape', None)
        if isinstance(shape, dict):
            # Opt-in wire capture keeps the reply's structure (never its text).
            from backend.ai import wire_trace as capture
            capture.write_json('05_login_endpoint_response_shape.json', shape)
            diagnostic.emit('provider_response_shape', responseKind=shape.get('kind'), bodyBytes=shape.get('bytes'),
                            providerCode=shape.get('code'), providerBizCode=shape.get('bizCode'),
                            endpointStep=shape.get('endpointStep'))
        raise
    except Exception:
        error = LoginError('login_endpoint_response_invalid', 'The endpoint response could not be confirmed. Start a new run.', 502)
        if row is not None:
            row['code'] = error.code
            error.requestDispatched = row['dispatched']
            if row['dispatched']:
                run.setdefault('stopped_by', (error.code, str(error)[:300], getattr(error, 'status', 502) or 502))
                run['cancel'].set()
        raise error from None
    finally:
        if run['expires'] <= time.monotonic():
            run['remote'].clear()
            for item in run['operations'].values():
                item.pop('result', None)
        run['lock'].release()
