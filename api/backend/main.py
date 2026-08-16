"""FastAPI application entry point for the TextPhantom OCR API.


Wires the routers, CORS, the custom access log, and the async job queue
together.  Run with::

    uvicorn backend.main:app --host 0.0.0.0 --port 7860
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from backend.api.middleware import access_log_middleware, configure_uvicorn_access_log
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
from backend.jobs.admission import AdmissionGate
from backend.config import settings
from backend.jobs.pipeline import process_payload
from backend.jobs.queue import JobQueue
from backend.lens import cookie as lens_cookie
from backend.log import event
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
    print(f"[TextPhantom][api] starting workers={settings.max_workers} direct_workers={getattr(queue, '_direct_workers', '?')} ai_workers={getattr(queue, '_ai_workers', '?')}", flush=True)

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

# /v1/translate runs without a queue: a bounded gate, and a 503 when it is full.
# Built HERE rather than in the lifespan on purpose — `/v1/capabilities` reads
# it, and a capabilities probe that arrives before startup finished (or under an
# ASGI runner that skips lifespan) would otherwise 500 on a missing attribute.
# The legacy JobQueue still starts in the lifespan; it needs a running loop.
# TP_ADAPTIVE=0 pins every gate at its configured size. On (the default) each
# gate grows by one slot after a clean streak while it is actually saturated, and
# halves the moment a job's run time cliffs past 2.5x the rolling average.
_ADAPTIVE = str(os.environ.get("TP_ADAPTIVE", "1")).strip().lower() not in ("0", "false", "no", "off")
_LENS_LIMIT = settings.sync_max_concurrency or settings.max_workers
app.state.adaptive_gates = _ADAPTIVE
app.state.admission_gate = AdmissionGate(
    _LENS_LIMIT,
    max_waiters=settings.sync_max_waiters,
    max_wait_sec=settings.sync_max_wait_sec,
    adaptive=_ADAPTIVE,
    limit_min=max(2, _LENS_LIMIT // 4),
    limit_max=max(_LENS_LIMIT, _LENS_LIMIT * 4),
)
# A SECOND lane, for jobs whose time is spent waiting on an AI provider rather
# than computing. Two gates, not one wider gate: a single pool means an image
# asleep on Gemini's socket is holding a slot that the next image's Lens upload
# needs, and the two have nothing to do with each other.
_AI_LIMIT = settings.sync_ai_max_concurrency or settings.max_workers
app.state.ai_admission_gate = AdmissionGate(
    _AI_LIMIT,
    max_waiters=settings.sync_max_waiters,
    max_wait_sec=settings.sync_max_wait_sec,
    adaptive=_ADAPTIVE,
    limit_min=max(2, _AI_LIMIT // 4),
    limit_max=max(_AI_LIMIT, _AI_LIMIT * 4),
)
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
_CPU_LIMIT = settings.sync_cpu_max_concurrency or (settings.cpu_concurrency + 2)
app.state.cpu_admission_gate = AdmissionGate(
    _CPU_LIMIT,
    max_waiters=settings.sync_max_waiters,
    max_wait_sec=settings.sync_max_wait_sec,
    adaptive=_ADAPTIVE,
    limit_min=1,
    limit_max=max(_CPU_LIMIT, (os.cpu_count() or 2) * 2),
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
