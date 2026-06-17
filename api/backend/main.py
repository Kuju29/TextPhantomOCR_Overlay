"""FastAPI application entry point for the TextPhantom OCR API.

Wires the routers, CORS, the custom access log, and the async job queue
together.  Run with::

    uvicorn backend.main:app --host 0.0.0.0 --port 7860
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse

from backend.api.middleware import access_log_middleware, configure_uvicorn_access_log
from backend.api.routes import ai, health, meta, translate, ws
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
    print(f"[TextPhantom][api] starting build={settings.build_id} workers={settings.max_workers} direct_workers={getattr(queue, '_direct_workers', '?')} ai_workers={getattr(queue, '_ai_workers', '?')}", flush=True)
    asyncio.create_task(_warm_at_boot())
    asyncio.create_task(_cookie_refresh_loop())
    yield


app = FastAPI(title="TextPhantom OCR API", version="2.0", lifespan=lifespan)


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    """Open the interactive API docs when the Space root URL is visited."""
    return RedirectResponse(url="/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(access_log_middleware)

# Each router owns one concern; see the module docstrings for details.
app.include_router(health.router)
app.include_router(meta.router)
app.include_router(translate.router)
app.include_router(ai.router)
app.include_router(ws.router)
