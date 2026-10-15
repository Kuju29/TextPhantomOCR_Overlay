"""Customer-bound native OAuth. Browser callbacks arrive through the extension."""
import hashlib
import secrets
import time
from threading import RLock
from urllib.parse import parse_qs, urlsplit
from . import login_native as native, login_session_store as store, login_profiles
from .login_provider_registry import LoginError, get_provider
from . import login_observability as diagnostic
from concurrent.futures import ThreadPoolExecutor

_lock = RLock()
_flows = {}
_executor = None
_jobs = set()
TTL = 300
MAX_FLOWS = 256

def failure_record(error):
    # Raised exceptions retain tracebacks containing OAuth code/token locals.
    # Keep only the safe public error fields, never an exception object.
    return {"code": error.code, "message": str(error), "status": error.status,
        **{key: getattr(error, key) for key in ("auth_terminal", "upstream_status", "provider_reason", "cause_class", "stage", "trace_id", "flow_ref", "diagnostic_logged") if hasattr(error, key)}}

def failure_error(record):
    error = LoginError(record["code"], record["message"], record["status"])
    for key, value in record.items():
        if key not in {"code", "message", "status"}:
            setattr(error, key, value)
    return error

def _find(owner, provider, flow_id):
    with _lock:
        flow = _flows.get(flow_id)
        if not flow or flow["owner"] != store.owner_scope(owner) or flow["provider"] != provider:
            raise LoginError("login_auth_expired", "Sign-in expired. Start again.", 404)
        if flow["expires"] <= time.monotonic():
            _flows.pop(flow_id, None)
            raise LoginError("login_auth_expired", "Sign-in expired. Start again.", 410)
        return flow

def start(owner, provider_id, *, bearer="", callback_base="", quota_project=""):
    spec = get_provider(provider_id)
    if not spec.supported:
        raise LoginError("login_provider_unavailable", "This Login provider is not available yet.", 409)
    with _lock:
        for key, value in list(_flows.items()):
            if value["expires"] <= time.monotonic():
                del _flows[key]
        scope = store.owner_scope(owner)
        for flow in _flows.values():
            if flow["owner"] == scope and flow["provider"] == provider_id and not flow.get("result") and not flow.get("failure"):
                if not flow.get("url"):
                    raise LoginError("login_auth_busy", "Sign-in is starting. Try again shortly.", 429)
                return _public_flow(flow)
        if len(_flows) >= MAX_FLOWS:
            raise LoginError("login_auth_busy", "Sign-in is busy. Try again shortly.", 429)
        flow = {"id": "lgf_"+secrets.token_hex(24), "owner": scope, "provider": provider_id,
            "state": secrets.token_urlsafe(32), "nonce": secrets.token_urlsafe(32),
            "verifier": secrets.token_urlsafe(96), "expires": time.monotonic()+TTL, "exchange_lock": RLock(),
            "trace_id": diagnostic.current_trace(), "stage": "awaiting_provider", "began": time.monotonic(),
            "callback_base": callback_base, "quota_project": quota_project}
        module = native.module(provider_id)
        module.prepare(flow)
        flow["bearer"] = bearer
        _flows[flow["id"]] = flow
    try:
        url = module.auth_url(flow)
        parsed = urlsplit(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if parsed.scheme != "https" or parsed.hostname != spec.auth_host or parsed.path != spec.auth_path or parsed.port not in (None, 443) or parsed.username or parsed.password or query.get("state") != [flow["state"]] or query.get(getattr(module, "CALLBACK_PARAMETER", "redirect_uri")) != [flow["redirect_uri"]]:
            raise LoginError("login_auth_unavailable", "AI Login cannot start a verified sign-in right now.", 503)
        with _lock:
            _find(owner, provider_id, flow["id"])
            flow["url"] = url
        with diagnostic.context(provider_id, "start", flow["trace_id"], flow["id"]):
            diagnostic.stage("callback_wait")
            diagnostic.emit("started")
        return _public_flow(flow)
    except LoginError:
        with _lock:
            _flows.pop(flow["id"], None)
        raise
    except (ValueError, TypeError, KeyError, AttributeError):
        with _lock:
            _flows.pop(flow["id"], None)
        raise LoginError("login_provider_contract", "The provider returned invalid sign-in metadata.", 503) from None

def _public_flow(flow):
    return {"ok": True, "status": "pending", "flow_id": flow["id"], "url": flow["url"],
        "trace_id": flow["trace_id"], "stage": flow["stage"],
        "callback": {"uri": flow["redirect_uri"], "delivery": flow["callback_delivery"]}}

def submit(owner, provider_id, flow_id, state, *, code=None, error=None, client_id=None, authorize_again=None):
    """Acknowledge once; provider exchange continues outside the HTTP request."""
    global _executor
    flow = _find(owner, provider_id, flow_id)
    if not isinstance(state, str) or not secrets.compare_digest(flow["state"], state) or bool(code) == bool(error) or (code and (not isinstance(code, str) or len(code) > 4096)) or (error and (not isinstance(error, str) or len(error) > 200)):
        raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
    digest = hashlib.sha256((("code\0"+code) if code else ("error\0"+error)).encode()+b"\0"+str(client_id or "").encode()).hexdigest()
    with _lock:
        _find(owner, provider_id, flow_id)
        if flow.get("submitted_digest"):
            if flow["submitted_digest"] != digest:
                raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
        else:
            if len(_jobs) >= 16:
                raise LoginError("login_auth_busy", "Sign-in completion is busy. Please wait.", 429)
            flow["submitted_digest"], flow["stage"] = digest, "queued"
            if _executor is None:
                _executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tp-login")
            def progress(stage):
                with _lock:
                    if _flows.get(flow_id) is flow:
                        flow["stage"] = stage
            def run():
                with diagnostic.context(provider_id, "complete", flow["trace_id"], flow_id, progress):
                    try:
                        complete(owner, provider_id, flow_id, state, code=code, error=error, client_id=client_id, authorize_again=authorize_again)
                        diagnostic.emit("connected" if flow.get("result") else "failed", failure_error(flow["failure"]) if flow.get("failure") else None)
                    except LoginError as failure:
                        if not getattr(failure, "diagnostic_logged", False):
                            diagnostic.emit("failed", failure)
                        with _lock:
                            if _flows.get(flow_id) is flow:
                                flow["failure"] = failure_record(failure)
                    except Exception as failure:
                        typed = LoginError("login_internal_error", "Sign-in failed inside the API. See its diagnostic reference.", 500)
                        typed.auth_terminal, typed.cause_class = True, type(failure).__name__
                        diagnostic.emit("failed", typed)
                        with _lock:
                            if _flows.get(flow_id) is flow:
                                flow["failure"] = failure_record(typed)
                    finally:
                        for key in ("verifier", "nonce", "bearer", "oauth_config", "url"):
                            flow.pop(key, None)
            flow["future"] = _executor.submit(run)
            _jobs.add(flow["future"])
            def finished(future):
                with _lock:
                    _jobs.discard(future)
            flow["future"].add_done_callback(finished)
    diagnostic.emit("accepted")
    return {"ok": True, "status": "received", "stage": flow["stage"], "trace_id": flow["trace_id"]}


def complete(owner, provider_id, flow_id, state, *, code=None, error=None, client_id=None, authorize_again=None):
    flow = _find(owner, provider_id, flow_id)
    if not isinstance(state, str) or not secrets.compare_digest(flow["state"], state) or bool(code) == bool(error) or (code and (not isinstance(code, str) or len(code) > 4096)) or (error and (not isinstance(error, str) or len(error) > 200)):
        raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
    digest = hashlib.sha256((("code\0"+code) if code else ("error\0"+error)).encode()+b"\0"+str(client_id or "").encode()).hexdigest()
    with flow["exchange_lock"]:
        _find(owner, provider_id, flow_id)
        if flow.get("callback_digest"):
            if flow["callback_digest"] != digest:
                raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
            if flow.get("failure"):
                raise failure_error(flow["failure"])
            return {"ok": True, "status": "received"}
        flow["callback_digest"] = digest
        if error:
            denied = LoginError("login_auth_failed", "AI account sign-in was not completed.", 401)
            denied.auth_terminal = True
            flow["failure"] = failure_record(denied)
            flow.pop("verifier", None)
            return {"ok": True, "status": "received"}
        try:
            module = native.module(provider_id)
            diagnostic.stage("token_exchange")
            identity, tokens = module.exchange(code, flow, client_id=client_id)
            if not isinstance(identity, str) or not identity or len(identity) > 1024:
                raise LoginError("login_account_ambiguous", "Could not verify the AI account. Sign in again.", 409)
            diagnostic.stage("model_catalogue")
            rows = module.models(tokens)
            if not rows:
                raise LoginError("login_models_unavailable", "No verified translation model is available for this account.", 409)
            diagnostic.stage("entitlement_recheck")
            if authorize_again and authorize_again() != owner:
                raise LoginError("login_entitlement_required", "Login access is unavailable.", 403)
            with _lock:
                _find(owner, provider_id, flow_id)
                diagnostic.stage("session_binding")
                session = store.bind_native(owner, provider_id, identity, tokens)
                native.seed_models(session, rows)
                flow["result"] = {"ok": True, "status": "connected", "session": public_session(session),
                    "models": login_profiles.public_models(rows)}
        except LoginError as failure:
            failure.auth_terminal = True
            diagnostic.emit("failed", failure)
            flow["failure"] = failure_record(failure)
            raise
        except (ValueError, TypeError, KeyError, AttributeError):
            failure = LoginError("login_auth_failed", "The provider returned an invalid sign-in response. Start again.", 502)
            failure.auth_terminal = True
            flow["failure"] = failure_record(failure)
            raise failure from None
        finally:
            flow.pop("verifier", None)
            flow.pop("nonce", None)
        return {"ok": True, "status": "received"}

def status(owner, provider_id, flow_id):
    flow = _find(owner, provider_id, flow_id)
    with _lock:
        if flow.get("failure"):
            raise failure_error(flow["failure"])
        if flow.get("result"):
            store.credential_for_session(store.get(flow["result"]["session"]["id"], owner))
            return flow["result"]
        return {"ok": True, "status": "pending", "stage": flow.get("stage", "awaiting_provider"),
                "trace_id": flow.get("trace_id", ""), "elapsed_ms": round((time.monotonic()-flow["began"])*1000)}

def cancel(owner, provider_id, flow_id):
    with _lock:
        flow = _flows.get(flow_id)
        if flow and flow["owner"] == store.owner_scope(owner) and flow["provider"] == provider_id:
            _flows.pop(flow_id, None)
            if flow.get("result"):
                try:
                    session = store.get(flow["result"]["session"]["id"], owner)
                    store.invalidate_native(session)
                    native.purge_models(session["id"])
                except LoginError:
                    pass
        return {"ok": True, "status": "cancelled"}

def public_session(row):
    return {"id": row["id"], "provider": row["provider"], "account_id": row["account_id"]}

def logout(owner, provider_id, session_id):
    with _lock:
        session = store.get(session_id, owner, allow_inactive=True)
        if session["provider"] != provider_id:
            raise LoginError("login_session_expired", "Sign in to your AI account again.", 401)
        for current in store.owned(owner, provider_id):
            store.invalidate_native(current)
            native.purge_models(current["id"])
        for key, flow in list(_flows.items()):
            if flow["owner"] == store.owner_scope(owner) and flow["provider"] == provider_id:
                del _flows[key]
        return {"ok": True, "status": "logged_out", "remote_revocation": "unconfirmed"}

def shutdown():
    global _executor
    with _lock:
        executor, _executor = _executor, None
        _flows.clear()
        store.clear()
        native.clear_models()
    from .endpoint import login_endpoint_session, login_endpoint_runs
    login_endpoint_session.clear()
    login_endpoint_runs.clear()
    if executor:
        executor.shutdown(wait=False, cancel_futures=True)

def hosted_callback(provider, state, *, code=None, error=None, client_id=None):
    from . import login_entitlement
    with _lock:
        flow = next((x for x in _flows.values() if x["provider"] == provider and x.get("callback_delivery") == "server"
            and isinstance(state, str) and secrets.compare_digest(x["state"], state)), None)
        if not flow:
            raise LoginError("login_auth_expired", "Sign-in expired. Start again.", 404)
        if flow["expires"] <= time.monotonic():
            raise LoginError("login_auth_expired", "Sign-in expired. Start again.", 410)
        if flow.get("submitted_digest"):
            if bool(code) == bool(error) or code and (not isinstance(code, str) or len(code) > 4096) or error and (not isinstance(error, str) or len(error) > 200):
                raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
            digest = hashlib.sha256((("code\0"+code) if code else ("error\0"+error)).encode()+b"\0"+str(client_id or "").encode()).hexdigest()
            if not secrets.compare_digest(flow["submitted_digest"], digest):
                raise LoginError("login_callback_invalid", "Invalid Login callback.", 400)
            return {"ok": True, "status": "received", "trace_id": flow["trace_id"]}
        token = flow.get("bearer", "")
    owner = login_entitlement.authorize(token)
    return submit(owner, provider, flow["id"], state, code=code, error=error, client_id=client_id,
        authorize_again=lambda: login_entitlement.authorize(token))
