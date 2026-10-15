"""In-process OAuth provider dispatch and single-flight token rotation."""
import time
from contextlib import contextmanager
from threading import RLock
from . import login_provider_chatgpt, login_provider_gemini, login_provider_claude, login_provider_deepseek, login_provider_openrouter, login_provider_huggingface
from . import login_session_store as store
from .login_provider_registry import LoginError
from . import login_observability as diagnostic

MODULES = {m.PROVIDER.id: m for m in (login_provider_chatgpt, login_provider_gemini, login_provider_claude, login_provider_deepseek, login_provider_openrouter, login_provider_huggingface)}
_lock = RLock()
_leases = {}
_model_cache = {}

# The catalogue lists only model ids, so plan access ("Upgrade" models) is
# unknown at connect. A 403 for a chat turn with one model is remembered for
# this connected session (Reconnect/Refresh forgets it): the model is shown
# disabled and never sent again.
DENIED_STEPS = frozenset({'claude_completion', 'chatgpt_completion'})


def with_model_access(rows, access):
    access = access if isinstance(access, dict) else {}
    return [{**row, 'availability': dict(access[row['id']])}
            if isinstance(row, dict) and isinstance(access.get(row.get('id')), dict) else row for row in rows]


def model_access(row):
    """``None`` when usable (or unknown), else the recorded availability."""
    value = row.get('availability') if isinstance(row, dict) else None
    return value if isinstance(value, dict) and value.get('usable') is False else None


def remember_model_denied(session, model_id, step):
    """Record the website's 403 for this model; returns whether it was stored."""
    if step not in DENIED_STEPS or not isinstance(model_id, str) or not model_id:
        return False
    current = store.credential_for_session(session)
    tokens = current['tokens']
    if tokens.get('transport') != 'web_endpoint' or \
            not any(isinstance(row, dict) and row.get('id') == model_id for row in tokens.get('models', [])):
        return False
    access = dict(tokens.get('model_access') or {})
    access[model_id] = {'usable': False, 'reason': 'website_denied', 'evidence': 'http_403_' + step}
    store.update_native(session, current['revision'], {**tokens, 'model_access': access})
    return True


def module(provider):
    if provider not in MODULES:
        raise LoginError("login_provider_unavailable", "This Login provider is not available yet.", 409)
    return MODULES[provider]

@contextmanager
def account_lock(credential):
    with _lock:
        entry = _leases.setdefault(credential, [RLock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _lock:
            entry[1] -= 1
            if entry[1] == 0:
                _leases.pop(credential, None)


@diagnostic.session_operation("credential")
def token_snapshot(session):
    diagnostic.stage("session_validation")
    with account_lock(session["credential"]):
        current = store.credential_for_session(session)
        value = current.get("tokens", {})
        if not value.get("no_refresh") and value.get("expires_at", 0) <= time.time()+60:
            try:
                updated = module(session["provider"]).refresh(value)
            except LoginError as error:
                # A lost response may have consumed a rotating refresh token.
                # Never replay it or borrow another customer's credential.
                if getattr(error, "oauth_terminal", False) or getattr(error, "oauth_ambiguous", False):
                    store.invalidate_native(session, revision=current["revision"])
                raise error
            store.update_native(session, current["revision"], updated)
        return store.credential_for_session(session)

def availability(provider):
    from .endpoint.login_endpoint_session import PROVIDERS
    if provider in PROVIDERS:
        return None
    try:
        module(provider).configuration()
        return None
    except LoginError as error:
        return "setup_required" if error.code == "login_setup_required" else "unavailable"

def clear_models():
    with _lock:
        _model_cache.clear()

def purge_models(session_id):
    with _lock:
        _model_cache.pop(session_id, None)

def seed_models(session, rows):
    from copy import deepcopy
    current = store.credential_for_session(session)
    with _lock:
        for key, value in list(_model_cache.items()):
            if value[0] <= time.monotonic():
                del _model_cache[key]
        if len(_model_cache) < 512:
            _model_cache[session["id"]] = (time.monotonic()+30, current["revision"], deepcopy(rows))

@diagnostic.session_operation("models")
def models(session):
    current = store.credential_for_session(session)
    if current["tokens"].get("transport") == "web_endpoint":
        # A site module may add newer verified controls (DeepSeek's thinking
        # switch) to saved rows without forcing a reconnect.
        upgrade = getattr(module(session["provider"]), "endpoint_model_rows", None)
        rows = upgrade(current["tokens"]["models"]) if upgrade else current["tokens"]["models"]
        return with_model_access(rows, current["tokens"].get("model_access"))
    if current["tokens"].get("transport") == "browser_webchat":
        raise LoginError('login_reconnect_required', 'Reconnect with the endpoint Login extension.', 401)
    current = token_snapshot(session)
    with _lock:
        cached = _model_cache.get(session["id"])
        if cached and cached[0] > time.monotonic() and cached[1] == current["revision"]:
            import copy
            return copy.deepcopy(cached[2])
    try:
        rows = module(session["provider"]).models(current["tokens"])
        store.credential_for_session(session)
        with _lock:
            for key, value in list(_model_cache.items()):
                if value[0] <= time.monotonic():
                    del _model_cache[key]
            if len(_model_cache) < 512:
                import copy
                _model_cache[session["id"]] = (time.monotonic()+30, current["revision"], copy.deepcopy(rows))
        return rows
    except LoginError as error:
        if error.code == "login_session_expired":
            store.invalidate_native(session, revision=current["revision"])
        raise
    except (KeyError, TypeError, ValueError, AttributeError):
        raise LoginError("login_provider_contract", "Invalid AI Login model catalogue.", 503) from None

@diagnostic.session_operation("inference")
def generate(session, payload, *, cancel_check=None):
    from backend.ai import accounting
    current = token_snapshot(session)
    dispatched = False
    def dispatch():
        nonlocal dispatched
        store.credential_for_session(session)
        if cancel_check and cancel_check():
            raise LoginError("login_cancelled", "Translation was cancelled.", 409)
        accounting.mark_dispatched()
        dispatched = True
    try:
        data = module(session["provider"]).generate(current["tokens"], payload, dispatch=dispatch)
        store.credential_for_session(session)
        return data
    except LoginError as error:
        if error.code == "login_session_expired":
            store.invalidate_native(session, revision=current["revision"])
        error.requestDispatched = error.requestDispatched or dispatched
        raise
    except (KeyError, TypeError, ValueError, AttributeError):
        error = LoginError("login_response_invalid", "The provider returned an invalid translation response.", 502)
        error.requestDispatched = dispatched
        raise error from None
