"""FastAPI application entry point for the TextPhantom OCR API.

Wires the routers, CORS, the custom access log, and the async job queue
together.  Run with::

    uvicorn backend.main:app --host 0.0.0.0 --port 7860
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.middleware import access_log_middleware, configure_uvicorn_access_log
from backend.api.routes import ai, health, meta, translate, ws
from backend.config import settings
from backend.jobs.pipeline import process_payload
from backend.jobs.queue import JobQueue


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the job queue's worker pool when the server boots."""
    configure_uvicorn_access_log()
    queue = JobQueue(process_payload)
    queue.start()
    app.state.job_queue = queue
    print(f"[TextPhantom][api] starting build={settings.build_id} workers={settings.max_workers}", flush=True)
    yield


app = FastAPI(title="TextPhantom OCR API", version="2.0", lifespan=lifespan)

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
