"""Explicit Login diagnostics: never log bodies, redirect queries or credentials."""
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import re
import secrets
import time
from functools import wraps
from backend import trace
from backend.log import event as log_event

_context = ContextVar("tp_login_diagnostics", default=None)

def current_trace():
    return (_context.get() or {}).get("traceId", "")

def reference(value):
    return hashlib.sha256(str(value).encode()).hexdigest()[:16] if value else ""

def safe_id(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", value) else ""

@contextmanager
def operation(provider, name):
    """Keep route correlation across refresh, catalogue and inference workers."""
    from backend.diagnostic_core import current
    from .login_provider_contract import LoginError
    existing = _context.get()
    if existing:
        if provider:
            existing["provider"] = safe_id(provider)
        try:
            yield existing
        except LoginError as failure:
            if not getattr(failure, "diagnostic_logged", False):
                emit("failed", failure)
            raise
    else:
        with context(provider, name, current().get("trace_id", "") or trace.current_trace()) as ctx:
            try:
                yield ctx
            except LoginError as failure:
                if not getattr(failure, "diagnostic_logged", False):
                    emit("failed", failure)
                raise

def session_operation(name):
    def decorate(fn):
        @wraps(fn)
        def wrapped(session, *args, **kwargs):
            with operation(session.get("provider", ""), name):
                return fn(session, *args, **kwargs)
        return wrapped
    return decorate

def adapter_operation(name):
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            with operation("", name):
                return fn(*args, **kwargs)
        return wrapped
    return decorate

@contextmanager
def context(provider="", operation="", trace_id="", flow_id="", progress=None):
    current = {"provider": safe_id(provider), "operation": safe_id(operation),
               "traceId": safe_id(trace_id) or "lgt_"+secrets.token_hex(16),
               "flowRef": reference(flow_id), "stage": operation or "request", "began": time.monotonic(), "progress": progress}
    token = _context.set(current)
    try:
        yield current
    finally:
        _context.reset(token)

def stage(name):
    ctx = _context.get()
    if ctx:
        ctx["stage"] = safe_id(name) or "request"
        if ctx["progress"]:
            ctx["progress"](ctx["stage"])
    emit("stage")

def emit(outcome, error=None, **metadata):
    from .endpoint.login_endpoint_http import ENDPOINT_STEPS
    ctx = _context.get() or {"provider": "", "operation": "request", "traceId": "", "flowRef": "", "stage": "request", "began": time.monotonic()}
    data = {k: ctx[k] for k in ("provider", "operation", "traceId", "flowRef", "stage")}
    data.update(schema="tp.login/1", outcome=safe_id(outcome), elapsedMs=round((time.monotonic()-ctx["began"])*1000))
    if error is not None:
        for key, attribute in (("stage", "stage"), ("traceId", "trace_id"), ("flowRef", "flow_ref")):
            value = safe_id(getattr(error, attribute, ""))
            if value:
                data[key] = value
        from .login_http import PROVIDER_REASONS
        reason = getattr(error, "provider_reason", "")
        step = getattr(error, 'endpoint_step', '')
        if step in ENDPOINT_STEPS:
            data['endpointStep'] = step
        data.update(code=safe_id(getattr(error, "code", "login_internal_error")), status=getattr(error, "status", 500),
                    upstreamStatus=getattr(error, "upstream_status", None), providerReason=reason if isinstance(reason, str) and reason in PROVIDER_REASONS else "",
                    causeClass=safe_id(getattr(error, "cause_class", type(error).__name__)),
                    terminal=getattr(error, "auth_terminal", False) is True,
                    requestDispatched=getattr(error, "requestDispatched", False) is True,
                    retryable=getattr(error, "retryable", False) is True and not getattr(error, "auth_terminal", False))
        if getattr(error, 'identity_verified', None) is True:
            data['identityVerified'] = True
        error.stage, error.trace_id, error.flow_ref = data["stage"], data["traceId"], data["flowRef"]
        error.diagnostic_logged = True
    for key in ("upstreamStatus", "modelCount", "session_http_status", "bodyBytes", "providerCode", "providerBizCode"):
        if type(metadata.get(key)) is int:
            data[key] = metadata[key]
    if error is not None and getattr(error, "earlier_page_failed", False) is True:
        data["earlierPageFailed"] = True
    # Browser relay evidence, so a failed tab answer has a reason in logs.
    if isinstance(metadata.get("relayWaitMs"), (int, float)):
        data["relayWaitMs"] = round(float(metadata["relayWaitMs"]))
    for key in ("composer_present", "composer_enabled", "challenge_present", "identity_present", "relayAccepted"):
        if type(metadata.get(key)) is bool:
            data[key] = metadata[key]
    for key in ("code", "stage", "sourceTrust", "relayError", "relayDetail", "transport", "relayProvider", "chatgptMode", "chatgptPlan", "responseKind"):
        if safe_id(metadata.get(key)):
            data[key] = metadata[key]
    if metadata.get('endpointStep') in ENDPOINT_STEPS:
        data['endpointStep'] = metadata['endpointStep']
    trace.write("api", "ai/login", data["operation"], "..", data, trace_id=data["traceId"])
    from backend.diagnostics import writer
    writer.emit("login."+safe_id(outcome), outcome=safe_id(outcome), context={"trace_id":data["traceId"]},
        provider=data["provider"], operation=data["operation"], stage=data["stage"], flow_ref=data["flowRef"],
        elapsed_ms=data["elapsedMs"], error_code=data.get("code"), http_status=data.get("status"),
        upstream_status=data.get("upstreamStatus"), provider_reason=data.get("providerReason"),
        endpoint_step=data.get('endpointStep'),
        identity_verified=data.get('identityVerified'),
        terminal=data.get("terminal"), retryable=data.get("retryable"), request_dispatched=data.get("requestDispatched"))
    if outcome in ("started", "accepted", "connected", "failed", "cancelled", "logged_out", "browser_probe"):
        log_event("login."+outcome, data, ok=error is None and not (outcome == "browser_probe" and data.get("code")))
    return data
