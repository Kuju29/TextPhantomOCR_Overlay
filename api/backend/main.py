"""FastAPI entry point: routers, middleware, executors and admission gates.

Run with ``uvicorn backend.main:app --host 0.0.0.0 --port 7860 --no-proxy-headers``.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import os, asyncio

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

# Compose concrete providers before routes import services that resolve provider
# names. This is the API process's composition root; declaration modules remain
# side-effect free and repeated composition is safe.
from backend.ai.provider_bootstrap import ensure_provider_registry

ensure_provider_registry()

from backend.api.middleware import access_log_middleware, configure_uvicorn_access_log
from backend.api.errors import (
    ERROR_SCHEMA,
    payload as error_payload,
    failure_event,
    request_correlation,
    safe_cause_class,
    safe_validation_reason,
    validation_error_payload,
)
from backend.api.routes import (
    ai,
    ai_v1,
    repair_runs,
    lens_groups,
    local_wire_trace,
    health,
    lens_v1,
    logs,
    meta,
    paid,
    translate,
    translate_v1,
)
from backend import logfile, trace, trace_install, diagnostics
from backend.ai import wire_trace
from backend.jobs.admission import AdmissionGate
from backend.jobs import stage_admission
from backend.config import settings, lens_concurrency_limit
from backend.jobs.pipeline import process_payload
from backend.jobs.queue import JobQueue
from backend.lens import cookie as lens_cookie
from backend.lens.client import close_session as close_lens_session
from backend.log import event
from backend.utils.cpu_runtime import cpu_runtime_info
from backend.warmup import warmup as run_warmup

async def _warm_at_boot() -> None:
    """Prime the Lens cookie + fonts right after boot (not on first request)."""
    try:
        result = await asyncio.to_thread(run_warmup, settings.warmup_lang)
        event("warmup.boot", {
            "lang": result.get("lang"),
            "cookie_ok": result.get("cookie_ok"),
            "fonts_ok": result.get("fonts_ok"),
            "font_reason": result.get("font_warning") or None,
        })
    except Exception as e:  # noqa: BLE001 - warmup must never block startup
        event("warmup.boot", {"error": str(e)[:200]}, ok=False)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the job queue's worker pool when the server boots."""
    from backend.paid_center import gateway_key
    gateway_key()  # A configured but unreadable gateway key must fail at startup.
    configure_uvicorn_access_log()
    stage_admission.configure(
        asyncio.get_running_loop(),
        lens=app.state.admission_gate,
        grouping=app.state.grouping_admission_gate,
        ai=app.state.ai_admission_gate,
    )
    queue = JobQueue(process_payload)
    queue.start()
    app.state.job_queue = queue
    print(
        "[TextPhantom][api] shared stages "
        f"lens={app.state.admission_gate.stats().limit} "
        f"grouping={app.state.grouping_admission_gate.stats().limit} "
        f"ai={app.state.ai_admission_gate.stats().limit} "
        f"pipeline_threads={getattr(app.state, 'pipeline_executor_workers', '?')} "
        f"legacy_direct_workers={getattr(queue, '_direct_workers', '?')} "
        f"legacy_ai_workers={getattr(queue, '_ai_workers', '?')} "
        f"ai_http_threads={settings.ai_thread_workers}",
        flush=True,
    )
    _cpu = cpu_runtime_info()
    print(
        "[TextPhantom][api] CPU runtime "
        f"host={_cpu['host']} affinity={_cpu['affinity']} quota={_cpu['quota']} "
        f"effective={_cpu['effective']}",
        flush=True,
    )

    # Live rate learning never reads or writes restart state.
    if not settings.rate_gate_enabled:
        print(
            "[TextPhantom][api] proactive AI RPM gate OFF — provider quota/backpressure is authoritative; "
            "set TP_RATE_GATE=1 or send an explicit rate profile to enable pacing",
            flush=True,
        )
    else:
        print("[TextPhantom][api] AI rate memory: current process only; restart begins empty", flush=True)

    logfile.startup_banner()
    diagnostics.writer.emit("service.started", center_configured=bool(settings.center_url),
        lens_slots=app.state.admission_gate.stats().limit, grouping_slots=app.state.grouping_admission_gate.stats().limit,
        ai_slots=app.state.ai_admission_gate.stats().limit, log_file=logfile.is_enabled())
    # Say whether logs are written, so an empty folder is not mistaken for lost logs.
    if logfile.is_enabled():
        print(f"[TextPhantom][api] diagnostic logs -> {logfile.log_dir()}", flush=True)
    else:
        print(
            "[TextPhantom][api] diagnostic log FILES are off (set TP_LOG_FILE=1 to "
            "write them); events go to stdout only",
            flush=True,
        )

    # Report whether TP_TRACE took effect: the bash form `TP_TRACE=1 uvicorn`
    # silently does nothing in PowerShell/cmd.
    if trace.enabled():
        print(
            f"[TextPhantom][api] trace: {trace.mode()} -> {trace.path()} "
            f"({sum(_traced.values())} wrapped functions in {len(_traced)} modules)",
            flush=True,
        )
    else:
        print(
            "[TextPhantom][api] trace: off. PowerShell: $env:TP_TRACE=\"1\" "
            "for compact stage tracing, or \"full\" for function tracing; then restart",
            flush=True,
        )

    try:
        wire_session = wire_trace.start_session()
        if wire_session.get("enabled"):
            print(
                f"[TextPhantom][api] AI wire trace: on -> {wire_session.get('root')} "
                f"(pid={wire_session.get('pid')})", flush=True,
            )
        else:
            print("[TextPhantom][api] AI wire trace: off", flush=True)
    except Exception as exc:
        print(
            f"[TextPhantom][api] AI wire trace: FAILED ({type(exc).__name__}: {exc})",
            flush=True,
        )
        # Opting into content-bearing wire evidence is a fail-visible contract.
        # Starting without its requested evidence would make a healthy API look
        # traced while silently discarding the operator's diagnostic record.
        raise

    # Security posture, stated at boot: each of these silently weakens the
    # service and is otherwise invisible at runtime.
    if not lens_cookie.configured():
        print(
            "[TextPhantom][api] WARNING: no Google Lens cookie source — "
            "TP_LENS_COOKIE_SOURCE=firebase needs FIREBASE_URL. Every Lens request "
            "will fail until one is configured (default: direct-first).",
            flush=True,
        )
    print(f"[TextPhantom][api] AI endpoint policy: {settings.ai_endpoint_policy}; "
          "request-owned keys do not bypass network policy", flush=True)
    if settings.ai_endpoint_policy != "shared" or settings.ai_extra_hosts:
        print("[TextPhantom][api] WARNING: operator-enabled AI endpoints are trusted; "
              "protect this API with authentication/firewall before sharing it.", flush=True)
    if settings.allow_private_image_hosts:
        print(
            "[TextPhantom][api] WARNING: TP_ALLOW_PRIVATE_IMAGE_HOSTS=1 — the "
            "server will fetch private/loopback image URLs. Local use only.",
            flush=True,
        )
    if "*" in settings.allowed_origins:
        print(
            "[TextPhantom][api] note: CORS is open to all origins without "
            "credentials. Unset TP_ALLOWED_ORIGINS to admit extension origins only.",
            flush=True,
        )
    from backend.ai.login.login_routes import shared_cookie_login_blocked
    if shared_cookie_login_blocked():
        print("[TextPhantom][api] shared/public deployment: Gemini and DeepSeek Login "
              "(website session cookies) are disabled; TP_ALLOW_SHARED_COOKIE_LOGIN=1 "
              "re-enables them", flush=True)
    from backend.api.ingress import image_body_limit, job_body_limit, json_body_limit
    print(f"[TextPhantom][api] request body caps: job routes {job_body_limit()} B, "
          f"image routes {image_body_limit()} B, other JSON {json_body_limit()} B", flush=True)
    # No periodic Lens-cookie poll: lens_cookie.state() refreshes lazily with a
    # singleflight, and warmup/first use start a non-blocking refresh when the
    # jar is near expiry (lens_cookie.prefetch). An idle Space makes no
    # cookie-source requests at all.
    background_tasks = {
        asyncio.create_task(_warm_at_boot(), name="tp-warmup"),
    }
    try:
        yield
    finally:
        from backend.ai.login.login_auth import shutdown as login_shutdown
        await asyncio.to_thread(login_shutdown)
        for task in background_tasks:
            task.cancel()
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)
        diagnostics.writer.emit("service.stopping")
        await queue.shutdown(timeout=5.0)
        stage_admission.clear()
        # Thread work already executing cannot be force-killed safely. Cancel
        # only futures that never started and do not hold ASGI shutdown open.
        for name in (
            "ai_executor", "login_executor", "lens_executor", "grouping_executor",
            "pipeline_executor",
        ):
            executor = getattr(app.state, name, None)
            if executor is not None:
                executor.shutdown(wait=False, cancel_futures=True)
        await asyncio.to_thread(close_lens_session)
        from backend.ai.center_http import close as close_center_http
        await asyncio.to_thread(close_center_http)
        trace.flush()

app = FastAPI(title="TextPhantom OCR API", version="2.0", lifespan=lifespan)
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware
from backend.paid_center import trusted_proxy_hosts
from backend.api.ingress import BodyLimitMiddleware, IdentityQuotaMiddleware
# Order (outermost first): diagnostics, access log, CORS, proxy headers, body
# limit, identity quota, routes. Both ingress guards sit inside the proxy
# middleware so they see the trusted client address, and inside CORS/access log
# so their 413/429 answers are readable by the extension and logged.
app.add_middleware(IdentityQuotaMiddleware)
app.add_middleware(BodyLimitMiddleware)
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=trusted_proxy_hosts())

@app.exception_handler(HTTPException)
async def tp_http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Normalise legacy route errors while preserving status, headers and detail."""
    if isinstance(exc.detail, dict) and exc.detail.get("schema") == ERROR_SCHEMA:
        detail = exc.detail
    else:
        legacy = exc.detail if isinstance(exc.detail, dict) else {}
        message = str(legacy.get("message") or exc.detail or "Request failed")
        status = int(exc.status_code)
        raw_code = str(legacy.get("code") or "")
        raw_message = message.lower()
        expected_cancel = status == 409 and (raw_code == "cancelled" or "cancel" in raw_message)
        diagnostics_disabled = status == 503 and request.url.path in ("/v1/logs", "/v1/trace")
        code = raw_code or (
            "cancelled" if expected_cancel else
            ("diagnostic_logging_disabled" if request.url.path == "/v1/logs" else
             "trace_disabled") if diagnostics_disabled else
            "invalid_request" if status < 500 else "service_unavailable"
        )
        detail = error_payload(
            code=code,
            message=message,
            user_message=str(legacy.get("userMessage") or message),
            origin="client" if status < 500 else "api",
            stage=str(legacy.get("stage") or ("cancel" if expected_cancel else
                      request.url.path.strip("/").replace("/", "_") or "http")),
            category=("lifecycle" if expected_cancel else "configuration"
                      if diagnostics_disabled else "input" if status < 500 else "service"),
            retryable=bool(legacy.get("retryable", status in (429, 502, 503, 504))),
            http_status=status,
            trace_id=str(legacy.get("traceId") or request.headers.get("x-tp-trace-id") or ""),
            upstream_status=legacy.get("upstreamStatus"),
            extra={**({"validation": safe_validation_reason(exc.detail)}
                      if status in (400, 422) else {}), **{k: v for k, v in legacy.items() if k not in {
                "schema", "code", "message", "userMessage", "origin", "stage",
                "failedStage", "category", "retryable", "httpStatus", "traceId",
                "upstreamStatus",
            }}},
            correlation=request_correlation(request),
        )
        if not expected_cancel and not diagnostics_disabled:
            failure_event(request.url.path, detail)
    headers = dict(exc.headers or {})
    # Internal marker used only to prevent the access middleware from emitting
    # a second, cause-less "Bad Gateway" line for this already-classified error.
    headers["X-TP-Error-Schema"] = ERROR_SCHEMA
    return JSONResponse(status_code=exc.status_code, content={"detail": detail}, headers=headers)

@app.exception_handler(RequestValidationError)
async def tp_validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Keep FastAPI's 422 body while adding one safe, searchable log event."""
    detail = validation_error_payload(
        exc.errors(), trace_id=str(request.headers.get("x-tp-trace-id") or ""),
        correlation=request_correlation(request),
    )
    failure_event(request.url.path, detail)
    # A canonical body is required here: advertising tp.error/1 while returning
    # FastAPI's raw list made the schema header false and could echo `input`.
    return JSONResponse(status_code=422, content={"detail": detail},
                        headers={"X-TP-Error-Schema": ERROR_SCHEMA})

@app.exception_handler(Exception)
async def tp_unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Expose no raw exception text, while retaining a useful safe cause class."""
    detail = error_payload(
        code="internal_error", message="The server could not complete this request.",
        user_message="The server could not complete this request.", origin="api",
        stage=request.url.path.strip("/").replace("/", "_") or "http",
        category="internal", retryable=False, http_status=500,
        trace_id=str(request.headers.get("x-tp-trace-id") or ""),
        extra={"errorType": type(exc).__name__, "causeClass": safe_cause_class(exc)},
        correlation=request_correlation(request),
    )
    failure_event(request.url.path, detail)
    return JSONResponse(status_code=500, content={"detail": detail},
                        headers={"X-TP-Error-Schema": ERROR_SCHEMA})

# Provider SDKs are synchronous and get their own executor. The AI admission
# gate never exceeds its worker count, so an admitted call starts immediately
# instead of waiting in the executor FIFO behind another user's requests.
_AI_THREADS = max(1, int(settings.ai_thread_workers))
app.state.ai_executor = ThreadPoolExecutor(
    max_workers=_AI_THREADS,
    thread_name_prefix="tp-ai-http",
)

# /v1/translate runs without a queue: a bounded gate, 503 when full. Built here,
# not in the lifespan, because /v1/capabilities reads it and may arrive before
# startup (or under a runner that skips lifespan). Public Lens/AI admission is
# pinned to executor capacity; TP_ADAPTIVE only affects legacy/internal gates.
_ADAPTIVE = str(os.environ.get("TP_ADAPTIVE", "1")).strip().lower() not in ("0", "false", "no", "off")
_LENS_LIMIT = lens_concurrency_limit(settings)
app.state.adaptive_gates = _ADAPTIVE
# Lens executor and admission limit match, so an admitted upload starts
# immediately. TP_LENS_UPSTREAM_MAX_CONCURRENCY caps upstream fan-out.
app.state.lens_executor = ThreadPoolExecutor(
    max_workers=_LENS_LIMIT,
    thread_name_prefix="tp-lens-http",
)
app.state.lens_executor_workers = _LENS_LIMIT
app.state.admission_gate = AdmissionGate(
    _LENS_LIMIT,
    max_waiters=settings.sync_max_waiters,
    max_wait_sec=settings.sync_max_wait_sec,
    adaptive=False,
    limit_min=_LENS_LIMIT,
    limit_max=_LENS_LIMIT,
)
# A SECOND lane, for jobs whose time is spent waiting on an AI provider rather
# than computing. Two gates, not one wider gate: a single pool means an image
# asleep on Gemini's socket is holding a slot that the next image's Lens upload
# needs, and the two have nothing to do with each other.
_GROUP_LIMIT = max(1, settings.sync_group_max_concurrency or _LENS_LIMIT)
app.state.grouping_executor = ThreadPoolExecutor(
    max_workers=_GROUP_LIMIT,
    thread_name_prefix="tp-group-http",
)
app.state.grouping_executor_workers = _GROUP_LIMIT
app.state.grouping_admission_gate = AdmissionGate(
    _GROUP_LIMIT,
    max_waiters=settings.sync_group_max_waiters,
    max_wait_sec=settings.sync_group_max_wait_sec,
    adaptive=False,
    limit_min=_GROUP_LIMIT,
    limit_max=_GROUP_LIMIT,
)

_AI_CONFIGURED = settings.sync_ai_max_concurrency or _AI_THREADS
_AI_LIMIT = max(1, min(_AI_CONFIGURED, _AI_THREADS))
app.state.ai_admission_gate = AdmissionGate(
    _AI_LIMIT,
    max_waiters=settings.sync_ai_max_waiters,
    max_wait_sec=settings.sync_ai_max_wait_sec,
    # Provider latency is not server overload, and provider 429/503 is handled
    # per key by the extension lane, so this gate stays at executor capacity.
    adaptive=False,
    limit_min=_AI_LIMIT,
    limit_max=_AI_LIMIT,
)
app.state.ai_executor_workers = _AI_THREADS
# Separate lane for AI Login (see config.login_thread_workers).
_LOGIN_THREADS = max(1, int(settings.login_thread_workers))
app.state.login_executor = ThreadPoolExecutor(
    max_workers=_LOGIN_THREADS,
    thread_name_prefix="tp-login-ai",
)
app.state.login_admission_gate = AdmissionGate(
    _LOGIN_THREADS,
    max_waiters=settings.sync_ai_max_waiters,
    max_wait_sec=settings.sync_ai_max_wait_sec,
    adaptive=False,
    limit_min=_LOGIN_THREADS,
    limit_max=_LOGIN_THREADS,
)

# runs:API owns a whole synchronous image pipeline per worker. This transport
# pool is deliberately wider than any one stage: it must not become a fourth
# highway that hides free Lens/Grouping/AI slots behind ThreadPoolExecutor FIFO.
# The sum is a natural upper bound for requests simultaneously resident in the
# three shared stages. Heavy resources remain protected by their stage gates.
_PIPELINE_LIMIT = _LENS_LIMIT + _GROUP_LIMIT + _AI_LIMIT
app.state.pipeline_executor = ThreadPoolExecutor(
    max_workers=_PIPELINE_LIMIT,
    thread_name_prefix="tp-pipeline",
)
app.state.pipeline_executor_workers = _PIPELINE_LIMIT
app.state.pipeline_admission_gate = AdmissionGate(
    _PIPELINE_LIMIT,
    max_waiters=settings.sync_max_waiters,
    max_wait_sec=settings.sync_max_wait_sec,
    adaptive=False,
    limit_min=_PIPELINE_LIMIT,
    limit_max=_PIPELINE_LIMIT,
)


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    """Open the interactive API docs when the Space root URL is visited."""
    return RedirectResponse(url="/docs")


@app.head("/", include_in_schema=False)
async def root_head() -> RedirectResponse:
    """Answer hosting availability probes without producing a 405 error."""
    return RedirectResponse(url="/docs")

# CORS. Chromium extension pages and the service worker fetch under their
# host permissions and do not need CORS; Firefox/Thunderbird do when the user
# has not granted host access. The default therefore admits browser-extension
# origins only (any id: store builds and Firefox per-install UUIDs differ), so
# an arbitrary web page cannot drive this API from a visitor's browser.
# TP_ALLOWED_ORIGINS replaces the default with an explicit list ("*" = any page,
# never with credentials). Server-to-server callers (curl, CLI) are unaffected.
from backend.config import EXTENSION_ORIGIN_REGEX
_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]
_wildcard = "*" in _origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=None if _origins else EXTENSION_ORIGIN_REGEX,
    # Credentials only for an explicit origin list; the extension authenticates
    # with Authorization headers, not cookies.
    allow_credentials=bool(_origins) and not _wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID", "X-TP-Trace-ID", "X-TP-Center-Request-ID", "Retry-After"],
)
app.middleware("http")(access_log_middleware)
app.add_middleware(diagnostics.DiagnosticsMiddleware, writer=diagnostics.writer)
diagnostics.writer.emit("service.configured", center_configured=bool(settings.center_url),
    log_file=logfile.is_enabled(), trace_enabled=trace.enabled())

# Each router owns one concern; see the module docstrings for details.
app.include_router(health.router)
app.include_router(meta.router)
app.include_router(paid.router)
from backend.ai.login.login_routes import router as login_router
app.include_router(login_router)
from backend.ai.login.login_provider_registry import LoginError

@app.exception_handler(LoginError)
async def login_error(request, error):
    from backend.ai.login.login_routes import failure_response
    from backend.ai.login import login_observability as login_diagnostic
    with login_diagnostic.context(operation="inference", trace_id=request.headers.get("x-tp-trace-id", "")):
        response = failure_response(error, request)
        # Existing translation clients consume detail; Login UI consumes error.
        import json
        body = json.loads(response.body)
        body["detail"] = {**body["error"], "userMessage": str(error),
            "requestDispatched": error.requestDispatched,
            "providerAttempts": int(error.requestDispatched), "generationAttempts": int(error.requestDispatched)}
        response.body = json.dumps(body).encode()
        response.headers["content-length"] = str(len(response.body))
        return response
app.include_router(translate.router)
app.include_router(translate_v1.router)
app.include_router(ai.router)
app.include_router(ai_v1.router)
app.include_router(repair_runs.router)
app.include_router(lens_v1.router)
app.include_router(lens_groups.router)
app.include_router(local_wire_trace.router)
app.include_router(logs.router)

# This must precede trace_install.install(). In full mode the installer wraps
# live functions, and no wrapper record is allowed to become line one of a file
# whose build/session identity has not been stated yet.
trace.start_session()

# Function tracing, installed LAST so every module is imported and every router
# is bound before anything is wrapped. No-op unless TP_TRACE=1.
_traced = trace_install.install()
