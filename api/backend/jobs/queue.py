"""Async job queue + worker pool.

``/translate`` enqueues a payload and returns a job id immediately; the
client then polls ``/translate/{id}``.  A fixed pool of workers pulls jobs
off the queue and runs the (synchronous, CPU-bound) pipeline in a thread so
the event loop stays responsive.  A janitor task drops finished jobs after
``JOB_TTL_SEC``.
"""

from __future__ import annotations

import asyncio
import time
import traceback
import uuid
from typing import Any, Callable

from backend.config import settings
from backend.log import dbg, event

# A job record: {"status": "queued"|"running"|"done"|"error", "ts": float,
#                "result": <pipeline output> | <error string>}
Job = dict[str, Any]


class QueueFull(Exception):
    """Raised by :meth:`JobQueue.enqueue` when the pending queue is saturated."""


class JobQueue:
    """Owns the job registry, the asyncio queue and the worker tasks."""

    def __init__(self, processor: Callable[[dict], dict]) -> None:
        # ``processor`` is the blocking function that turns a payload into a result.
        self._processor = processor
        self._jobs: dict[str, Job] = {}
        # Bounded queue: applies backpressure so a flood of requests cannot
        # grow memory without limit. enqueue() rejects (busy) when full.
        self._queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue(
            maxsize=max(1, settings.max_queue_size)
        )
        self._started = False

    # --- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        """Spawn the worker pool + janitor (idempotent)."""
        if self._started:
            return
        self._started = True
        for i in range(max(1, settings.max_workers)):
            asyncio.create_task(self._worker_loop(i))
        asyncio.create_task(self._cleanup_loop())
        dbg("jobs.start", {"workers": settings.max_workers})

    # --- public API --------------------------------------------------------
    async def enqueue(self, payload: dict) -> str:
        """Register a new job and return its id.

        Raises ``QueueFull`` (HTTP 503 upstream) when the pending queue is at
        capacity, so the server sheds load gracefully under a flood instead of
        growing memory unbounded.  Also trims the tracked-jobs map to a cap.
        """
        self._evict_if_needed()
        job_id = str(uuid.uuid4())
        try:
            self._queue.put_nowait((job_id, payload))
        except asyncio.QueueFull as exc:
            raise QueueFull("server busy: translation queue is full") from exc
        self._jobs[job_id] = {"status": "queued", "ts": time.time()}
        return job_id

    def _evict_if_needed(self) -> None:
        """Drop the oldest finished jobs if the tracked map exceeds the cap."""
        cap = max(100, settings.max_jobs_tracked)
        if len(self._jobs) <= cap:
            return
        # Remove oldest done/error records first (keep running/queued).
        finished = [
            (jid, j) for jid, j in self._jobs.items()
            if j.get("status") in ("done", "error")
        ]
        finished.sort(key=lambda kv: float(kv[1].get("ts", 0)))
        for jid, _ in finished[: len(self._jobs) - cap]:
            self._jobs.pop(jid, None)

    def get(self, job_id: str) -> Job:
        """Return the job record, or an error record if unknown."""
        return self._jobs.get(job_id) or {"status": "error", "result": "job_not_found"}

    async def run_inline(self, payload: dict) -> dict:
        """Run a payload to completion without queueing (used by the WS route)."""
        return await asyncio.to_thread(self._processor, payload)

    # --- internals ---------------------------------------------------------
    async def _worker_loop(self, worker_id: int) -> None:
        while True:
            job_id, payload = await self._queue.get()
            t0 = time.perf_counter()
            # How long the job sat in the queue before a worker picked it up —
            # part of the user's "waiting to start" latency that translate.perf
            # (which starts here) can never see.
            enqueue_ts = float((self._jobs.get(job_id) or {}).get("ts") or 0.0)
            queue_wait_ms = round(max(0.0, time.time() - enqueue_ts) * 1000, 1) if enqueue_ts else 0.0
            summary = {
                "job_id": job_id,
                "mode": str(payload.get("mode") or ""),
                "lang": str(payload.get("lang") or ""),
                "source": str(payload.get("source") or ""),
                "queue_wait_ms": queue_wait_ms,
            }
            try:
                self._jobs[job_id] = {"status": "running", "ts": time.time()}
                # Per-job wall-clock cap so one slow/stuck job can't pin a worker
                # forever and starve other users.
                result = await asyncio.wait_for(
                    asyncio.to_thread(self._processor, payload),
                    timeout=max(10.0, settings.job_run_timeout_sec),
                )
                self._jobs[job_id] = {"status": "done", "result": result, "ts": time.time()}
                event(
                    "translate.done",
                    {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1)},
                )
            except asyncio.TimeoutError:
                self._jobs[job_id] = {
                    "status": "error",
                    "result": "job timed out",
                    "ts": time.time(),
                }
                event(
                    "translate.error",
                    {
                        **summary,
                        "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                        "error": "job timed out",
                    },
                    ok=False,
                )
            except Exception as e:  # noqa: BLE001 - surface the error to the client
                tb = traceback.format_exc()
                dbg("jobs.error", {"job_id": job_id, "error": str(e), "traceback": tb})
                event(
                    "translate.error",
                    {
                        **summary,
                        "dt_ms": round((time.perf_counter() - t0) * 1000, 1),
                        "error": str(e)[:240],
                    },
                    ok=False,
                )
                self._jobs[job_id] = {
                    "status": "error",
                    "result": str(e),
                    "traceback": tb,
                    "ts": time.time(),
                }
            finally:
                self._queue.task_done()

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = time.time() - settings.job_ttl_sec
            dead = [jid for jid, j in self._jobs.items() if float(j.get("ts", 0)) < cutoff]
            for jid in dead:
                self._jobs.pop(jid, None)
