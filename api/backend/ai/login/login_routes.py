"""Authenticated Login routes and registered callbacks on the same API."""
import os
import asyncio
import html
import secrets
from fastapi import APIRouter, Request, Query
from pydantic import BaseModel, ConfigDict, Field
from fastapi.responses import JSONResponse, HTMLResponse
from .login_provider_registry import (PROVIDERS, get_provider, LoginError,
    translation_supported, TRANSLATION_UNDER_IMPROVEMENT, TRANSLATION_TESTING)
from . import login_entitlement, login_session_store as store, login_auth, login_profiles, login_native as native
from . import login_observability as diagnostic
from .login_oauth_common import public_base
from .endpoint import login_endpoint_session as web_session
from .endpoint import login_browser_relay as relay

router = APIRouter()

class SessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(pattern=r"^lgs_[a-f0-9]{48}$")

class StartInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quota_project: str = Field(default="", max_length=63)

class CancelInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flow_id: str = Field(pattern=r"^lgf_[a-f0-9]{48}$")

class CancelAuthInput(CancelInput):
    reason: str = Field(default="abandoned", pattern=r"^(abandoned|tab_closed)$")

class CompleteInput(CancelInput):
    state: str = Field(min_length=8, max_length=200)
    code: str | None = Field(default=None, min_length=1, max_length=4096)
    error: str | None = Field(default=None, min_length=1, max_length=200)
    client_id: str | None = Field(default=None, min_length=1, max_length=200)

class BrowserCompleteInput(CancelInput):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())
    state: str = Field(min_length=8, max_length=200)
    browser_instance: str = Field(pattern=r"^[a-f0-9]{48}$")
    model_label: str = Field(default="", max_length=160)
    thinking_off: bool = False

class EndpointImportInput(CancelInput):
    state: str = Field(min_length=8, max_length=200)
    browser_instance: str = Field(pattern=r'^[a-f0-9]{48}$')
    expected_identity: str = Field(pattern=r'^[a-f0-9]{64}$')
    credentials: dict[str, str] = Field(min_length=1, max_length=3, repr=False)

class BrowserProgressInput(CancelInput):
    state: str = Field(min_length=8, max_length=200)
    stage: str = Field(pattern=r"^(provider_challenge|session_validation|composer_detection|browser_ready)$")
    code: str = Field(default="", pattern=r"^(|login_[a-z_]{1,80})$")
    composer_present: bool
    composer_enabled: bool
    challenge_present: bool
    identity_present: bool
    session_http_status: int | None = Field(default=None, ge=100, le=599)

class BrowserTurnInput(SessionInput):
    browser_instance: str = Field(pattern=r"^[a-f0-9]{48}$")
    turn_id: str = Field(pattern=r"^lgt_[a-f0-9]{48}$")
    stage: str = Field(pattern=r"^(claimed|submitted|reply_started|reply_finished|failed|cancelled)$")
    text: str = Field(default="", max_length=524288)
    code: str = Field(default="", pattern=r"^(|login_[a-z_]{1,80})$")

class BrowserPendingInput(SessionInput):
    browser_instance: str = Field(pattern=r"^[a-f0-9]{48}$")
    run_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")
    operation_id: str = Field(min_length=1, max_length=160)

def bearer(request):
    header = request.headers.get("authorization", "")
    return header[7:] if header.startswith("Bearer ") else ""

# Providers whose website Login sends the person's website session cookies to
# this API (Gemini: __Secure-1PSID / __Secure-1PSIDTS; DeepSeek: user token +
# ds_session_id), held in this process's memory for the session lifetime.
# On a shared/public API (a HF Space, or TP_PUBLIC_DEPLOYMENT=1) one process
# would hold account sessions of everyone who connects, so these providers are
# off there unless the operator explicitly sets TP_ALLOW_SHARED_COOKIE_LOGIN=1.
# A person's own local or self-hosted API keeps them available.
COOKIE_SESSION_PROVIDERS = frozenset({"login_gemini", "login_deepseek"})
SHARED_COOKIE_REASON = "shared_deployment_cookie_session"
SHARED_COOKIE_MESSAGE = ("Disabled on this shared API: this Login would send your website session "
                         "cookies to a server used by other people. Use your own local or "
                         "self-hosted API for this provider.")


def shared_cookie_login_blocked():
    from backend.deployment import env_flag, public_deployment
    return public_deployment() and env_flag("TP_ALLOW_SHARED_COOKIE_LOGIN") is not True


def disabled_reason(spec):
    """Why an otherwise supported provider is disabled on this API, or None."""
    selected = {x.strip() for x in os.environ.get("TP_LOGIN_ENABLED_PROVIDERS", "login_chatgpt,login_claude,login_gemini,login_deepseek").split(",")}
    if spec.id not in selected:
        return "operator_disabled"
    if spec.id in COOKIE_SESSION_PROVIDERS and shared_cookie_login_blocked():
        return SHARED_COOKIE_REASON
    return None


def enabled(spec):
    return spec.supported and disabled_reason(spec) is None

def failure_response(exc, request=None):
    from .endpoint.login_endpoint_http import ENDPOINT_STEPS
    from .login_http import PROVIDER_REASONS
    if not getattr(exc, "diagnostic_logged", False):
        diagnostic.emit("failed", exc)
    error = {"code": exc.code, "message": str(exc), "stage": getattr(exc, "stage", "request"),
             "trace_id": getattr(exc, "trace_id", ""), "flow_ref": getattr(exc, "flow_ref", ""),
             "terminal": getattr(exc, "auth_terminal", False) is True,
             "requestDispatched": exc.requestDispatched is True,
             "upstream_status": getattr(exc, "upstream_status", None),
             "provider_reason": getattr(exc, "provider_reason", "") if isinstance(getattr(exc, "provider_reason", ""), str) and getattr(exc, "provider_reason", "") in PROVIDER_REASONS else "",
             "retryable": getattr(exc, "retryable", False) is True and not getattr(exc, "auth_terminal", False)}
    if getattr(exc, 'endpoint_step', '') in ENDPOINT_STEPS:
        error['endpoint_step'] = exc.endpoint_step
    if getattr(exc, 'identity_verified', None) is True:
        error['identityVerified'] = True
    if request is not None:
        request.state.diagnostic_error = exc.code
    return JSONResponse({"error": error}, status_code=exc.status,
        headers={"Cache-Control": "no-store", "X-TP-Error-Schema": "tp.error/1", "X-TP-Trace-ID": error["trace_id"]})

def _public():
    from backend.deployment import public_deployment
    return public_deployment()


def _cookie_disabled_error(spec):
    return LoginError("login_provider_unavailable", SHARED_COOKIE_MESSAGE, 409)


async def call(action, request, provider="", operation="request", flow_id=""):
    with diagnostic.context(provider, operation, request.headers.get("x-tp-trace-id", ""), flow_id):
        try:
            result = await asyncio.to_thread(action)
            return JSONResponse(result, headers={"Cache-Control": "no-store", "X-TP-Trace-ID": diagnostic.current_trace()})
        except LoginError as exc:
            return failure_response(exc, request)

@router.get("/login/providers")
async def providers(request: Request):
    token = bearer(request)
    def action():
        diagnostic.stage("entitlement")
        owner = login_entitlement.authorize(token)
        sessions = store.owned(owner)
        reasons = {p.id: p.unavailable_reason if not p.supported else "disabled" if not enabled(p) else native.availability(p.id) for p in PROVIDERS.values()}
        # "reason" stays "disabled" for existing clients; disabled_reason/message
        # say why (e.g. cookie-session Login refused on a shared deployment).
        why = {p.id: disabled_reason(p) if p.supported else None for p in PROVIDERS.values()}
        return {"ok": True, "session_storage": "process_memory",
            "deployment": "shared" if _public() else "private",
            "providers": [{"id": p.id, "name": p.label, "channel": p.channel,
            "supported": p.supported, "available": reasons[p.id] is None, "reason": reasons[p.id],
            **({"disabled_reason": why[p.id]} if reasons[p.id] == "disabled" and why[p.id] else {}),
            **({"message": SHARED_COOKIE_MESSAGE} if why[p.id] == SHARED_COOKIE_REASON else {}),
            "sign_in_available": reasons[p.id] is None,
            "translation_supported": reasons[p.id] is None and translation_supported(p.id),
            # Testing providers keep their "under improvement" label.
            "support_status": "under_improvement" if p.id in TRANSLATION_UNDER_IMPROVEMENT | TRANSLATION_TESTING else
                "supported" if reasons[p.id] is None and translation_supported(p.id) else "unavailable",
            "transport": "web_endpoint" if p.id in web_session.PROVIDERS else "oauth",
            "session": (web_session.public_session if p.id in web_session.PROVIDERS else login_auth.public_session)(next(x for x in sessions if x["provider"] == p.id)) if any(x["provider"] == p.id for x in sessions) else None}
            for p in PROVIDERS.values()]}
    return await call(action, request, operation="providers")

@router.post("/login/providers/{provider_id}/auth/start")
async def start(provider_id: str, request: Request, body: StartInput | None = None):
    token = bearer(request)
    def action():
        diagnostic.stage("entitlement")
        owner = login_entitlement.authorize(token)
        diagnostic.stage("provider_registration")
        spec = get_provider(provider_id)
        if spec.supported and disabled_reason(spec) == SHARED_COOKIE_REASON:
            raise _cookie_disabled_error(spec)
        if not enabled(spec):
            if spec.unavailable_reason == 'consumer_endpoint_not_implemented':
                raise LoginError('login_endpoint_unsupported', native.module(provider_id).UNAVAILABLE_MESSAGE, 409)
            message = "This provider has no enabled consumer endpoint Login route."
            if spec.unavailable_reason == 'endpoint_browser_proof_required':
                message = "ChatGPT requires per-request browser verification; a browser-free endpoint route is unavailable in this version."
            raise LoginError('login_endpoint_unsupported', message, 409)
        if provider_id in web_session.PROVIDERS:
            return web_session.start(owner, provider_id)
        callback_base = public_base(str(request.base_url)) if provider_id != "login_chatgpt" else ""
        return login_auth.start(owner, provider_id, bearer=token, callback_base=callback_base, quota_project=body.quota_project if body else "")
    return await call(action, request, provider_id, "start")

@router.get("/login/providers/{provider_id}/auth/status")
async def status(provider_id: str, request: Request, flow_id: str = Query(pattern=r"^lgf_[a-f0-9]{48}$")):
    token = bearer(request)
    return await call(lambda: (web_session.status if provider_id in web_session.PROVIDERS else login_auth.status)(login_entitlement.authorize(token), provider_id, flow_id), request, provider_id, "status", flow_id)

@router.post("/login/providers/{provider_id}/auth/complete")
async def complete(provider_id: str, body: CompleteInput, request: Request):
    token = bearer(request)
    if provider_id in web_session.PROVIDERS:
        return failure_response(LoginError("login_transport_invalid", "Use website Login from the updated extension UI.", 409), request)
    return await call(lambda: login_auth.submit(login_entitlement.authorize(token), provider_id,
        body.flow_id, body.state, code=body.code, error=body.error, client_id=body.client_id,
        authorize_again=lambda: login_entitlement.authorize(token)), request, provider_id, "complete", body.flow_id)

@router.post("/login/providers/{provider_id}/auth/browser-complete")
async def browser_complete(provider_id: str, body: BrowserCompleteInput, request: Request):
    def action():
        login_entitlement.authorize(bearer(request))
        if provider_id not in web_session.PROVIDERS or not enabled(get_provider(provider_id)):
            raise LoginError("login_provider_unavailable", "This website Login is disabled.", 409)
        raise LoginError('login_reconnect_required', 'Update the extension and reconnect using endpoint Login.', 410)
    return await call(action, request, provider_id, "browser_complete", body.flow_id)

@router.post('/login/providers/{provider_id}/auth/endpoint-import')
async def endpoint_import(provider_id: str, body: EndpointImportInput, request: Request):
    token = bearer(request)
    loop = asyncio.get_running_loop()
    def reauthorize():
        disconnected = asyncio.run_coroutine_threadsafe(request.is_disconnected(), loop).result(timeout=2)
        if disconnected:
            raise LoginError('login_cancelled', 'The importing client disconnected. Start Login again.', 409)
        return login_entitlement.authorize(token)
    def action():
        owner = login_entitlement.authorize(token)
        if provider_id in COOKIE_SESSION_PROVIDERS and shared_cookie_login_blocked():
            # Refused before anything is validated or stored; the request's
            # credentials are discarded with the request.
            raise _cookie_disabled_error(None)
        if provider_id not in web_session.PROVIDERS or not enabled(get_provider(provider_id)):
            raise LoginError('login_endpoint_unsupported', 'This provider has no enabled endpoint Login route.', 409)
        return web_session.complete(owner, provider_id, body.flow_id, body.state, body.browser_instance,
            body.expected_identity, body.credentials, reauthorize)
    return await call(action, request, provider_id, 'endpoint_import', body.flow_id)

@router.post("/login/providers/{provider_id}/auth/browser-progress")
async def browser_progress(provider_id: str, body: BrowserProgressInput, request: Request):
    def action():
        login_entitlement.authorize(bearer(request))
        if provider_id not in web_session.PROVIDERS or not enabled(get_provider(provider_id)):
            raise LoginError("login_provider_unavailable", "This browser Login provider is unavailable.", 409)
        raise LoginError('login_reconnect_required', 'Browser chat relay has been retired. Reconnect with endpoint Login.', 410)
    return await call(action, request, provider_id, "browser_progress", body.flow_id)

def browser_session(request, session_id):
    store.get(session_id, login_entitlement.authorize(bearer(request)))
    raise LoginError('login_transport_retired', 'Translation through browser tabs has been retired.', 410)

@router.post("/login/webchat/pending")
async def browser_pending(body: BrowserPendingInput, request: Request):
    return await call(lambda: browser_session(request, body.session_id), request, operation="browser_pending")

@router.post("/login/webchat/cancel")
async def browser_cancel(body: BrowserPendingInput, request: Request):
    return await call(lambda: browser_session(request, body.session_id), request, operation="browser_cancel")

@router.post("/login/webchat/turn")
async def browser_turn(body: BrowserTurnInput, request: Request):
    return await call(lambda: browser_session(request, body.session_id), request, operation="browser_turn")

@router.post("/login/providers/{provider_id}/auth/cancel")
async def cancel(provider_id: str, body: CancelAuthInput, request: Request):
    token = bearer(request)
    def action():
        owner = login_entitlement.authorize(token)
        reason = getattr(body, "reason", "abandoned")
        result = (web_session.cancel(owner, provider_id, body.flow_id, reason=reason)
                  if provider_id in web_session.PROVIDERS else login_auth.cancel(owner, provider_id, body.flow_id))
        diagnostic.emit("connected" if result.get("status") == "connected" else "cancelled", close_reason=reason)
        return result
    return await call(action, request, provider_id, "cancel", body.flow_id)

@router.get("/login/providers/{provider_id}/models")
async def models(provider_id: str, request: Request, session_id: str = Query(pattern=r"^lgs_[a-f0-9]{48}$")):
    token = bearer(request)
    def action():
        session = store.get(session_id, login_entitlement.authorize(token))
        if session["provider"] != provider_id or not enabled(get_provider(provider_id)):
            raise LoginError("login_session_expired", "Sign in to your AI account again.", 401)
        return {"ok": True, "session": (web_session.public_session if provider_id in web_session.PROVIDERS else login_auth.public_session)(session), "models": login_profiles.public_models(login_profiles.model_list(session))}
    return await call(action, request, provider_id, "models")

@router.post("/login/providers/{provider_id}/logout")
async def logout(provider_id: str, body: SessionInput, request: Request):
    token = bearer(request)
    def action():
        owner = login_entitlement.authorize(token)
        session = store.get(body.session_id, owner, allow_inactive=True)
        if session['provider'] != provider_id:
            raise LoginError('login_session_expired', 'This Login connection is unavailable.', 401)
        result = web_session.disconnect(owner, provider_id, body.session_id) if provider_id in web_session.PROVIDERS else login_auth.logout(owner, provider_id, body.session_id)
        diagnostic.emit("logged_out")
        return result
    return await call(action, request, provider_id, "logout")

class RelayPollInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    wait_ms: int = Field(default=20000, ge=0, le=25000)

class RelayResultInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^lrj_[a-f0-9]{48}$")
    status: int | None = Field(default=None, ge=100, le=599)
    content_type: str = Field(default="", max_length=200)
    headers: dict[str, str] = Field(default_factory=dict, max_length=8)
    body: str = Field(default="", max_length=relay.MAX_BODY_CHARS)
    error: str = Field(default="", pattern=r"^(|tab_unavailable|network|not_allowed|signed_out|account_changed|chat_lost|challenge|limit|busy|not_ready|timeout)$")
    # The browser's own reason code (e.g. login_composer_missing); never a value from the website.
    detail: str = Field(default="", pattern=r"^[a-z_]{0,48}$")
    elapsed_ms: int = Field(default=0, ge=0, le=600000)

_relay_owner_cache = {}

def relay_scope(token):
    """Owner scope for the extension's relay pump. A pump polls only while one of
    its own Login requests is in flight; cache the Center check briefly so a
    long poll does not call the Center on every reconnect."""
    import hashlib, time as _time
    key = hashlib.sha256(token.encode()).hexdigest() if isinstance(token, str) else ""
    now = _time.monotonic()
    row = _relay_owner_cache.get(key)
    if row and row[1] > now:
        return row[0]
    scope = store.owner_scope(login_entitlement.authorize(token))
    if len(_relay_owner_cache) > 1024:
        _relay_owner_cache.clear()
    _relay_owner_cache[key] = (scope, now + 60)
    return scope

@router.post("/login/relay/poll")
async def relay_poll(body: RelayPollInput, request: Request):
    """Long poll: hand the next website request of this owner to its extension."""
    token = bearer(request)
    with diagnostic.context("", "relay_poll", request.headers.get("x-tp-trace-id", "")):
        try:
            scope = await asyncio.to_thread(relay_scope, token)
        except LoginError as exc:
            return failure_response(exc, request)
        deadline = asyncio.get_running_loop().time() + body.wait_ms / 1000
        while True:
            job = relay.take(scope)
            if job is not None:
                return JSONResponse({"ok": True, "job": job}, headers={"Cache-Control": "no-store"})
            if asyncio.get_running_loop().time() >= deadline or await request.is_disconnected():
                return JSONResponse({"ok": True, "job": None}, headers={"Cache-Control": "no-store"})
            await asyncio.sleep(.05)

@router.post("/login/relay/result")
async def relay_result(body: RelayResultInput, request: Request):
    token = bearer(request)
    with diagnostic.context("", "relay_result", request.headers.get("x-tp-trace-id", "")):
        try:
            scope = await asyncio.to_thread(relay_scope, token)
        except LoginError as exc:
            return failure_response(exc, request)
        result = {"status": body.status, "content_type": body.content_type, "headers": body.headers,
                  "body": body.body, "elapsed_ms": body.elapsed_ms}
        if body.error:
            result = {"error": body.error, "detail": body.detail, "elapsed_ms": body.elapsed_ms}
        provider = relay.job_provider(scope, body.id)
        accepted = relay.complete(scope, body.id, result)
        # Which job answered and how; a late answer shows accepted=False.
        diagnostic.emit("relay_result", relayAccepted=accepted, relayProvider=provider or "unknown",
                        relayError=body.error or "", relayDetail=body.detail or "", relayWaitMs=body.elapsed_ms,
                        **({"upstreamStatus": body.status} if body.status else {}))
        return JSONResponse({"ok": True, "accepted": accepted}, headers={"Cache-Control": "no-store"})

@router.get("/login/oauth/callback/{provider_name}", response_class=HTMLResponse)
async def hosted_callback(provider_name: str, request: Request):
    provider_id = "login_"+provider_name
    if provider_name == "gemini":
        provider_id = "login_gemini"
    query = request.query_params
    keys = ("state", "code", "error", "client_id")
    valid = provider_id in PROVIDERS and all(len(query.getlist(k)) <= 1 for k in keys) and 8 <= len(query.get("state", "")) <= 200
    status, message, reference = 400, "Sign-in was not accepted. Return to TextPhantom and start again.", ""
    with diagnostic.context(provider_id, "callback", request.headers.get("x-tp-trace-id", "")):
        if valid:
            try:
                result = await asyncio.to_thread(login_auth.hosted_callback, provider_id, query.get("state"),
                    code=query.get("code"), error=query.get("error"), client_id=query.get("client_id"))
                status, message, reference = 200, "Sign-in received. TextPhantom is verifying your connection. Return to the extension to see progress.", result.get("trace_id", "")
            except LoginError as failure:
                response = failure_response(failure, request)
                status, message, reference = response.status_code, str(failure), getattr(failure, "trace_id", "")
        else:
            failure = LoginError("login_callback_invalid", "Invalid Login callback.", 400)
            failure_response(failure, request)
            reference = failure.trace_id
    nonce = secrets.token_hex(16)
    page = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>TextPhantom Login</title><h1>TextPhantom</h1><p>"+html.escape(message)+"</p><p>Reference: "+html.escape(reference)+"</p>"
    page += '<script nonce="'+nonce+'">history.replaceState(null,"",location.pathname);</script>'
    return HTMLResponse(page, status_code=status,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-TP-Error-Schema": "tp.error/1" if status >= 400 else "",
                 "Content-Security-Policy": "default-src 'none'; script-src 'nonce-"+nonce+"'; frame-ancestors 'none'"})
