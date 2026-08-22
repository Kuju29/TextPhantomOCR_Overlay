"""FastAPI application entry point for the TextPhantom OCR API.


Wires the routers, CORS, the custom access log, and the async job queue
together.  Run with::

    uvicorn backend.main:app --host 0.0.0.0 --port 7860
"""

from __future__ import annotations

import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from backend.api.middleware import access_log_middleware, configure_uvicorn_access_log
from backend.api.errors import ERROR_SCHEMA, payload as error_payload, failure_event
from backend.api.routes import (
    blocks_v1,
    ai,
    ai_v1,
    groups_v1,
    health,
    lens_v1,
    logs,
    meta,
    translate,
    translate_v1,
)
from backend import logfile, trace, trace_install
from backend.ai.rategate import rate_gate
from backend.jobs.admission import AdmissionGate
from backend.config import settings
from backend.jobs.pipeline import process_payload
from backend.jobs.queue import JobQueue
from backend.lens import cookie as lens_cookie
from backend.log import event
from backend.utils.cpu_runtime import cpu_runtime_info, effective_cpu_count
from backend.warmup import warmup as run_warmup


async def _warm_at_boot() -> None:
    """Prime the Lens cookie + fonts right after boot (not on first request)."""
    try:
        result = await asyncio.to_thread(run_warmup, settings.warmup_lang)
        event("warmup.boot", {"lang": result.get("lang"), "cookie_ok": result.get("cookie_ok")})
    except Exception as e:  # noqa: BLE001 - warmup must never block startup
        event("warmup.boot", {"error": str(e)[:200]}, ok=False)


async def _cookie_refresh_loop() -> None:
    """Keep the Lens cookie fresh in the background.

    ``cookie.get`` refreshes lazily when its TTL expires, which makes the
    unlucky request that hits the stale window pay for the Firebase fetch.
    Polling it once a minute is free while the cookie is fresh (a dict-cache
    hit) and moves the refresh cost off the request path.
    """
    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(lens_cookie.get, settings.firebase_url)
        except Exception:
            pass  # transient Firebase errors — next tick retries


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the job queue's worker pool when the server boots."""
    configure_uvicorn_access_log()
    queue = JobQueue(process_payload)
    queue.start()
    app.state.job_queue = queue
    print(f"[TextPhantom][api] starting workers={settings.max_workers} direct_workers={getattr(queue, '_direct_workers', '?')} ai_workers={getattr(queue, '_ai_workers', '?')} ai_http_threads={settings.ai_thread_workers}", flush=True)
    _cpu = cpu_runtime_info()
    print(
        "[TextPhantom][api] CPU runtime "
        f"host={_cpu['host']} affinity={_cpu['affinity']} quota={_cpu['quota']} "
        f"effective={_cpu['effective']} onnx_public={getattr(app.state, 'cpu_executor_workers', '?')} "
        f"textblock_pool_requested={settings.textblock_pool_size} "
        f"geometry_fallback={'on' if settings.textblock_geometry_fallback else 'off'}",
        flush=True,
    )

    # Whether the AI pacing cache survived this boot, said at boot.
    #
    # This is the difference between a first chapter that runs at the rate the
    # key was already known to sustain and one that re-learns from the free-tier
    # starting number — 19 pages/min against 50 on the measured run. A read-only
    # filesystem turns it off completely and the only other symptom is that the
    # ramp comes back, so the state is printed either way.
    if not settings.rate_gate_enabled:
        print(
            "[TextPhantom][api] proactive AI RPM gate OFF — provider quota/backpressure is authoritative; "
            "set TP_RATE_GATE=1 or send an explicit rate profile to enable pacing",
            flush=True,
        )
    else:
        _rate_state = rate_gate.persistence()
        if not _rate_state["enabled"]:
            print("[TextPhantom][api] AI rate memory OFF (TP_RATE_STATE=0)", flush=True)
        elif _rate_state["error"]:
            print(
                f"[TextPhantom][api] AI rate memory UNAVAILABLE at {_rate_state['path']}: "
                f"{_rate_state['error']} — every restart will re-learn each key's rate. "
                "Point TP_RATE_STATE_FILE at a writable path (on Hugging Face, enable "
                "persistent storage and use /data).",
                flush=True,
            )
        else:
            print(
                f"[TextPhantom][api] AI rate memory -> {_rate_state['path']} "
                f"({_rate_state['restored']} key(s) restored)",
                flush=True,
            )

    logfile.startup_banner()
    # Printing a path that is never written to is how someone ends up grepping
    # an empty folder for an hour. Say which of the two states this run is in.
    if logfile.is_enabled():
        print(f"[TextPhantom][api] diagnostic logs -> {logfile.log_dir()}", flush=True)
    else:
        print(
            "[TextPhantom][api] diagnostic log FILES are off (set TP_LOG_FILE=1 to "
            "write them); events go to stdout only",
            flush=True,
        )

    # Whether the function trace took effect, said at boot.
    #
    # Setting the variable is the one step that fails SILENTLY: the bash form
    # `TP_TRACE=1 uvicorn ...` is not valid in PowerShell or cmd, so the server
    # starts perfectly, writes nothing, and reads as a broken feature. One line
    # here turns "the trace does not work" into "the variable did not arrive".
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

    # Security posture, stated at boot. Each of these silently degraded the
    # service or widened its attack surface before, and none of them was
    # visible anywhere at runtime.
    if not settings.firebase_url:
        print(
            "[TextPhantom][api] WARNING: FIREBASE_URL is set to an empty value "
            "— every Google Lens request will fail. Unset it to use the "
            "built-in cookie jar, or point it at your own.",
            flush=True,
        )
    if settings.allow_private_image_hosts:
        print(
            "[TextPhantom][api] WARNING: TP_ALLOW_PRIVATE_IMAGE_HOSTS=1 — the "
            "server will fetch private/loopback image URLs. Local use only.",
            flush=True,
        )
    if "*" in settings.allowed_origins:
        print(
            "[TextPhantom][api] note: CORS is open to all origins without "
            "credentials. Set TP_ALLOWED_ORIGINS to lock it down.",
            flush=True,
        )
    asyncio.create_task(_warm_at_boot())
    asyncio.create_task(_cookie_refresh_loop())
    yield


app = FastAPI(title="TextPhantom OCR API", version="2.0", lifespan=lifespan)


@app.exception_handler(HTTPException)
async def tp_http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Normalise legacy route errors while preserving status, headers and detail."""
    if isinstance(exc.detail, dict) and exc.detail.get("schema") == ERROR_SCHEMA:
        detail = exc.detail
    else:
        legacy = exc.detail if isinstance(exc.detail, dict) else {}
        message = str(legacy.get("message") or exc.detail or "Request failed")
        status = int(exc.status_code)
        detail = error_payload(
            code=str(legacy.get("code") or (
                "invalid_request" if status < 500 else "service_unavailable"
            )),
            message=message,
            user_message=str(legacy.get("userMessage") or message),
            origin="client" if status < 500 else "api",
            stage=str(legacy.get("stage") or request.url.path.strip("/").replace("/", "_") or "http"),
            category="input" if status < 500 else "service",
            retryable=bool(legacy.get("retryable", status in (429, 502, 503, 504))),
            http_status=status,
            trace_id=str(legacy.get("traceId") or ""),
            upstream_status=legacy.get("upstreamStatus"),
            extra={k: v for k, v in legacy.items() if k not in {
                "schema", "code", "message", "userMessage", "origin", "stage",
                "failedStage", "category", "retryable", "httpStatus", "traceId",
                "upstreamStatus",
            }},
        )
        failure_event(request.url.path, detail)
    headers = dict(exc.headers or {})
    # Internal marker used only to prevent the access middleware from emitting
    # a second, cause-less "Bad Gateway" line for this already-classified error.
    headers["X-TP-Error-Schema"] = ERROR_SCHEMA
    return JSONResponse(status_code=exc.status_code, content={"detail": detail}, headers=headers)

# Provider SDKs are synchronous. Give them their own executor instead of the
# process-wide asyncio default pool that Lens, ONNX, warmup and miscellaneous
# to_thread() work also use. Most importantly, the AI admission gate below is
# never allowed to exceed this worker count, so submitting an admitted AI call
# can start immediately rather than disappearing into ThreadPoolExecutor's FIFO
# backlog behind another user's requests.
_AI_THREADS = max(1, int(settings.ai_thread_workers))
app.state.ai_executor = ThreadPoolExecutor(
    max_workers=_AI_THREADS,
    thread_name_prefix="tp-ai-http",
)

# /v1/translate runs without a queue: a bounded gate, and a 503 when it is full.
# Built HERE rather than in the lifespan on purpose — `/v1/capabilities` reads
# it, and a capabilities probe that arrives before startup finished (or under an
# ASGI runner that skips lifespan) would otherwise 500 on a missing attribute.
# The legacy JobQueue still starts in the lifespan; it needs a running loop.
# TP_ADAPTIVE remains available to legacy/internal gates, but public Lens/AI/ONNX
# admission is pinned to real executor capacity in this build. Provider/client
# feedback controls request pacing; server latency must not manufacture capacity.
_ADAPTIVE = str(os.environ.get("TP_ADAPTIVE", "1")).strip().lower() not in ("0", "false", "no", "off")
_LENS_LIMIT = max(1, settings.sync_max_concurrency or settings.max_workers)
app.state.adaptive_gates = _ADAPTIVE
# Lens is synchronous remote I/O. Keep its executor and admission limit exactly
# aligned so an admitted upload can start immediately instead of entering an
# invisible ThreadPoolExecutor FIFO. User-configured TP_SYNC_MAX_CONCURRENCY /
# SERVER_MAX_WORKERS still define the size; we only make the implementation
# honour that value literally.
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
_AI_CONFIGURED = settings.sync_ai_max_concurrency or _AI_THREADS
_AI_LIMIT = max(1, min(_AI_CONFIGURED, _AI_THREADS))
app.state.ai_admission_gate = AdmissionGate(
    _AI_LIMIT,
    max_waiters=settings.sync_ai_max_waiters,
    max_wait_sec=settings.sync_ai_max_wait_sec,
    # Provider latency is NOT evidence of server overload. The old adaptive gate
    # halved AI capacity when Gemini/HF got slower, even though CPU was idle.
    # Provider 429/503 is already handled per API-key by the extension lane, so
    # this gate stays pinned to the real executor capacity.
    adaptive=False,
    limit_min=_AI_LIMIT,
    limit_max=_AI_LIMIT,
)
app.state.ai_executor_workers = _AI_THREADS
# A THIRD lane, for the detector-only calls (`/v1/groups`, `/v1/blocks`).
#
# Same argument as the AI lane, pointing the other way. ONNX is ~445 ms of pure
# CPU; a Lens upload is 3.7 s of network sleep. While these shared the Lens lane,
# one image's compute held a slot the next image's upload could have used — so a
# page that needed grouping cost the batch a whole upload slot for half a second,
# on a lane whose whole purpose is to keep uploads in flight.
#
# Sized from CPU concurrency, not from the worker count: `_CPU_GATE` is what
# actually bounds this work, and a wider lane in front of it only queues behind
# the semaphore where nothing can see the wait. `+ 2` keeps the gate fed while a
# finished request serialises its reply.
# ONNX is bounded by real cores, so its ceiling is cores-derived, not a multiple
# of the starting size: growing past the CPU only moves the wait behind _CPU_GATE.
_CPU_RUNTIME = cpu_runtime_info()
_EFFECTIVE_CPU = max(1, effective_cpu_count())
_CPU_CONFIGURED = settings.sync_cpu_max_concurrency or settings.cpu_concurrency
# Public detector concurrency must match BOTH quota-visible CPU capacity and
# the number of real ONNX sessions.  Admitting two /v1/groups requests in
# front of one model session only creates a hidden lock queue.
_CPU_LIMIT = max(1, min(
    _CPU_CONFIGURED,
    settings.cpu_concurrency,
    _EFFECTIVE_CPU,
    max(1, settings.textblock_pool_size),
))
app.state.cpu_runtime_info = _CPU_RUNTIME
# Detector work is CPU-bound and already protected by _CPU_GATE. A dedicated
# executor with the same public capacity prevents Lens/AI network waits from
# occupying its workers and prevents /v1/groups from hiding behind the default
# asyncio executor. Keep it pinned: more admitted ONNX calls than real workers
# are just a queue in another place.
app.state.cpu_executor = ThreadPoolExecutor(
    max_workers=_CPU_LIMIT,
    thread_name_prefix="tp-onnx",
)
app.state.cpu_executor_workers = _CPU_LIMIT
app.state.cpu_admission_gate = AdmissionGate(
    _CPU_LIMIT,
    max_waiters=settings.sync_cpu_max_waiters,
    max_wait_sec=settings.sync_cpu_max_wait_sec,
    adaptive=False,
    limit_min=_CPU_LIMIT,
    limit_max=_CPU_LIMIT,
)

# The full API-server engine owns a whole image pipeline on one worker. Give
# each admission lane a matching executor so /v1/translate cannot recreate the
# hidden shared-default-pool queue that the extension-first route eliminated.
app.state.pipeline_lens_executor = ThreadPoolExecutor(
    max_workers=_LENS_LIMIT,
    thread_name_prefix="tp-pipeline-lens",
)
app.state.pipeline_ai_executor = ThreadPoolExecutor(
    max_workers=_AI_LIMIT,
    thread_name_prefix="tp-pipeline-ai",
)


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    """Open the interactive API docs when the Space root URL is visited."""
    return RedirectResponse(url="/docs")

# CORS. The extension does not rely on CORS at all — it fetches under its host
# permissions — so the wildcard exists only for browser-based callers and the
# docs page. `allow_origins=["*"]` together with `allow_credentials=True` is a
# combination browsers reject anyway, and it invited cookie-bearing calls from
# any page; credentials are therefore only enabled for an explicit origin list.
_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()] or ["*"]
_wildcard = "*" in _origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=not _wildcard,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(access_log_middleware)

# Each router owns one concern; see the module docstrings for details.
app.include_router(health.router)
app.include_router(meta.router)
app.include_router(translate.router)
app.include_router(translate_v1.router)
app.include_router(ai.router)
app.include_router(ai_v1.router)
app.include_router(lens_v1.router)
app.include_router(blocks_v1.router)
app.include_router(groups_v1.router)
app.include_router(logs.router)

# This must precede trace_install.install(). In full mode the installer wraps
# live functions, and no wrapper record is allowed to become line one of a file
# whose build/session identity has not been stated yet.
trace.start_session()

# Function tracing, installed LAST so every module is imported and every router
# is bound before anything is wrapped. No-op unless TP_TRACE=1.
_traced = trace_install.install()
