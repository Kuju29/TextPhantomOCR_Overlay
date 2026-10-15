"""One-shot browser Login import, verified by fixed consumer endpoints, RAM only."""
import hashlib
import secrets
import time
from threading import RLock
from copy import deepcopy
from .. import login_session_store as store, login_observability as diagnostic
from ..login_provider_contract import LoginError
from . import login_endpoint_runs as runs

PROVIDERS = {
    'login_chatgpt': ('ChatGPT', 'https://chatgpt.com/'),
    'login_gemini': ('Gemini', 'https://gemini.google.com/app'),
    'login_claude': ('Claude', 'https://claude.ai/new'),
    'login_deepseek': ('DeepSeek', 'https://chat.deepseek.com/'),
}
_lock, _flows, _closed = RLock(), {}, {}
MAX_CLOSED, CLOSED_TTL = 512, 300
AUTHENTICATION_ONLY_PROVIDERS = frozenset({'login_chatgpt', 'login_claude'})

def public_session(row):
    result = {key: row[key] for key in ('id', 'provider', 'account_id')} | {'transport': 'web_endpoint'}
    if row['provider'] in AUTHENTICATION_ONLY_PROVIDERS:
        tokens = store.credential_for_session(row)['tokens']
        if tokens.get('authentication_only') is True:
            result.update(authentication_only=True, authentication_validation='identity_verified',
                          generation_validation='not_tested')
    return result

def clear():
    with _lock:
        _flows.clear()
        _closed.clear()

def _prune_closed():
    now = time.monotonic()
    for key, row in list(_closed.items()):
        if row['expires'] <= now:
            del _closed[key]

def _close(flow_id, row):
    """Remember only cleanup ownership; never retain credentials or revive a flow."""
    _flows.pop(flow_id, None)
    _prune_closed()
    while len(_closed) >= MAX_CLOSED:
        del _closed[next(iter(_closed))]
    _closed[flow_id] = {'owner': row['owner'], 'provider': row['provider'],
                        'expires': time.monotonic() + CLOSED_TTL}

def _find(owner, provider, flow_id):
    flow = _flows.get(flow_id)
    if not flow or flow['owner'] != store.owner_scope(owner) or flow['provider'] != provider:
        raise LoginError('login_auth_expired', 'This sign-in ended. Start again.', 404)
    if flow['expires'] <= time.monotonic():
        _close(flow_id, flow)
        raise LoginError('login_auth_expired', 'This sign-in expired. Start again.', 410)
    return flow

def start(owner, provider):
    from ..login_provider_registry import get_provider
    spec = get_provider(provider)
    if not spec.supported:
        raise LoginError('login_endpoint_unsupported', 'This provider has no verified browser-free consumer translation route.', 409)
    with _lock:
        for key, row in list(_flows.items()):
            if row['expires'] <= time.monotonic() or (row['owner'] == store.owner_scope(owner) and row['provider'] == provider):
                _close(key, row)
        if len(_flows) >= 256:
            raise LoginError('login_auth_busy', 'Sign-in is busy. Try again shortly.', 429)
        flow_id = 'lgf_' + secrets.token_hex(24)
        row = {'owner': store.owner_scope(owner), 'provider': provider, 'state': secrets.token_urlsafe(32),
               'expires': time.monotonic() + 300, 'trace_id': diagnostic.current_trace()}
        _flows[flow_id] = row
        return {'ok': True, 'status': 'pending', 'transport': 'web_endpoint', 'flow_id': flow_id,
                'state': row['state'], 'url': PROVIDERS[provider][1], 'trace_id': row['trace_id'],
                'stage': 'awaiting_provider'}

def credentials(provider, value):
    if provider == 'login_claude':
        import re
        # The claude.ai session stays in the customer's browser; requests leave
        # from their claude.ai tab. Only the selected organization is sent.
        if isinstance(value, dict) and 'session_key' in value:
            raise LoginError('login_reconnect_required',
                'Update the extension and API together, then connect Claude again.', 401)
        if not isinstance(value, dict) or value.keys() != {'organization'}:
            raise LoginError('login_credentials_invalid', 'The Claude session fields are invalid.', 400)
        if not isinstance(value['organization'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', value['organization']):
            raise LoginError('login_credentials_invalid', 'The Claude session format is invalid.', 400)
        return dict(value)
    if provider == 'login_chatgpt':
        # Mode/plan/account hash only; ChatGPT tokens stay in the browser.
        from ..login_provider_chatgpt import validate_credentials
        return validate_credentials(value)
    fields = {'login_gemini': ({'psid'}, {'psid', 'psidts', 'auth_user'}),
              'login_deepseek': ({'token'}, {'token', 'session_id'})}
    required, allowed = fields.get(provider, (set(), set()))
    if not required or not isinstance(value, dict) or not required <= value.keys() or not value.keys() <= allowed:
        raise LoginError('login_credentials_invalid', 'The provider session fields are invalid.', 400)
    if any(not isinstance(item, str) or (not item.isascii() or not item.isdigit() or len(item) > 2 if key == 'auth_user' else
           not 8 <= len(item) <= 8192 or any(ord(c) < 33 or ord(c) > 126 or c in ';,' for c in item)) for key, item in value.items()):
        raise LoginError('login_credentials_invalid', 'The provider session format is invalid.', 400)
    return dict(value)

def complete(owner, provider, flow_id, state, browser_instance, expected_identity, value, authorize_again):
    from .. import login_native as native
    from ..login_provider_registry import translation_supported
    value = credentials(provider, value)
    with _lock:
        row = _find(owner, provider, flow_id)
        if not isinstance(state, str) or not state.isascii() or not secrets.compare_digest(row['state'], state):
            raise LoginError('login_callback_invalid', 'This sign-in belongs to a different connection.', 400)
        credential_digest = hashlib.sha256(repr(sorted(value.items())).encode()).hexdigest()
        if row.get('result'):
            if row.get('browser_instance') != browser_instance or row.get('expected_identity') != expected_identity or row.get('credential_digest') != credential_digest:
                raise LoginError('login_callback_invalid', 'This sign-in was completed by another browser.', 409)
            store.get(row['result']['session']['id'], owner)
            return deepcopy(row['result'])
        if row.get('claim'):
            raise LoginError('login_auth_busy', 'This session is already being verified.', 409)
        claim = secrets.token_hex(16)
        row.update(claim=claim, browser_instance=browser_instance, expected_identity=expected_identity,
                   credential_digest=credential_digest, stage='endpoint_validation')
    def check():
        with _lock:
            live = _find(owner, provider, flow_id)
            if live.get('claim') != claim:
                raise LoginError('login_auth_expired', 'This sign-in was superseded.', 409)
    session = None
    try:
        check()
        diagnostic.stage('endpoint_validation')
        # This is a server-owned capability choice, never an import field. A
        # verified identity cannot imply usable models or request preparation.
        authentication_only = provider in AUTHENTICATION_ONLY_PROVIDERS and not translation_supported(provider)
        adapter = native.module(provider)
        from . import login_browser_relay as relay
        with relay.owner(store.owner_scope(owner)):
            verified = (adapter.endpoint_authenticate if authentication_only else adapter.endpoint_validate)(value, check)
        if not isinstance(verified, dict) or not isinstance(verified.get('models'), list):
            raise LoginError('login_endpoint_response_invalid', 'The provider catalogue is invalid.', 502)
        if authentication_only:
            invalid_models = verified.get('authentication_only') is not True or verified['models'] != []
        else:
            invalid_models = not 1 <= len(verified['models']) <= 100 or \
                'authentication_only' in verified and verified['authentication_only'] is not False
        if invalid_models:
            raise LoginError('login_endpoint_response_invalid', 'The provider catalogue is invalid.', 502)
        public_models = []
        for item in verified['models']:
            if not isinstance(item, dict) or not all(isinstance(k,str) for k in item) or not isinstance(item.get('id'), str) or not isinstance(item.get('name'), str) or not isinstance(item.get('model_capabilities'), dict):
                raise LoginError('login_endpoint_response_invalid', 'The provider catalogue is invalid.', 502)
            public_models.append({k:v for k,v in item.items() if not k.startswith('_')})
        if not isinstance(verified.get('credentials'), dict):
            raise LoginError('login_endpoint_response_invalid', 'The provider session is invalid.', 502)
        identity = verified['identity']
        if not isinstance(identity, str) or not identity or len(identity) > 320 or \
                not secrets.compare_digest(hashlib.sha256(identity.encode()).hexdigest(), expected_identity):
            raise LoginError('login_account_changed', 'The provider account differs between browser Login and the API. Sign in again.', 409)
        if authorize_again() != owner:
            raise LoginError('login_owner_changed', 'Your TextPhantom account changed. Start again.', 401)
        with _lock:
            check()
            if authentication_only and translation_supported(provider):
                raise LoginError('login_endpoint_response_invalid', 'Reconnect to verify the current provider capabilities.', 502)
            previous = store.owned(owner, provider)
            tokens = {'transport': 'web_endpoint', 'credentials': verified['credentials'],
                      'models': verified['models'], 'no_refresh': True}
            if authentication_only:
                tokens['authentication_only'] = True
            session = store.bind_native(owner, provider, identity, tokens)
            for old in previous:
                runs.purge(old['id'])
            row['result'] = {'ok': True, 'status': 'connected', 'session': public_session(session),
                'models': public_models,
                'endpoint_validation': 'identity_verified', 'generation_validation': 'not_tested'}
            if authentication_only:
                row['result'].update(authentication_only=True, authentication_validation='identity_verified')
            elif verified.get('preparation_validation') in ('proof_free', 'browser_preparation_required'):
                row['result']['preparation_validation'] = verified['preparation_validation']
            row['stage'] = 'endpoint_ready'
            diagnostic.stage('endpoint_ready')
            return deepcopy(row['result'])
    except LoginError:
        if session is not None:
            store.invalidate_native(session)
            runs.purge(session['id'])
        with _lock:
            if _flows.get(flow_id) is row:
                # Import is one-shot; never replay credentials after a failure.
                _close(flow_id, row)
        raise
    except Exception:
        if session is not None:
            store.invalidate_native(session)
            runs.purge(session['id'])
        with _lock:
            if _flows.get(flow_id) is row:
                _close(flow_id, row)
        raise LoginError('login_endpoint_response_invalid', 'The provider could not verify this session.', 502) from None
    finally:
        value.clear()

def status(owner, provider, flow_id):
    with _lock:
        row = _find(owner, provider, flow_id)
        if row.get('result'):
            store.get(row['result']['session']['id'], owner)
        return deepcopy(row.get('result')) or {'ok': True, 'status': 'pending',
                'stage': row.get('stage', 'awaiting_provider'), 'trace_id': row['trace_id']}

def cancel(owner, provider, flow_id, *, reason="abandoned"):
    with _lock:
        _prune_closed()
        row = _flows.get(flow_id)
        closed = _closed.get(flow_id) if row is None else None
        owned = row if row is not None else closed
        if not owned or owned['owner'] != store.owner_scope(owner) or owned['provider'] != provider:
            raise LoginError('login_auth_expired', 'This sign-in ended. Start again.', 404)
        if row is None:
            return {'ok': True, 'status': 'cancelled'}
        if row.get('result') and reason == 'tab_closed':
            # Closing the capture tab is flow cleanup, not account logout.
            # Keep the row so a later explicit abort can still revoke a result
            # whose browser owner/scope changed before local publication.
            store.get(row['result']['session']['id'], owner)
            return deepcopy(row['result'])
        if row.get('result'):
            session = store.get(row['result']['session']['id'], owner, allow_inactive=True)
            store.invalidate_native(session)
            runs.purge(session['id'])
        _close(flow_id, row)
    return {'ok': True, 'status': 'cancelled'}

def revoke_flows(owner, provider):
    with _lock:
        for key, row in list(_flows.items()):
            if row['owner'] == store.owner_scope(owner) and row['provider'] == provider:
                del _flows[key]


def disconnect(owner, provider, session_id):
    from .. import login_auth
    with _lock:
        session = store.get(session_id, owner, allow_inactive=True)
        if session['provider'] != provider:
            raise LoginError('login_session_expired', 'This connection is unavailable.', 401)
        revoke_flows(owner, provider)
        for current in store.owned(owner, provider):
            runs.purge(current['id'])
        return login_auth.logout(owner, provider, session_id)
