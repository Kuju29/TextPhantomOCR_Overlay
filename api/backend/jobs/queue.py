"""Async job queue + worker pool.

``/translate`` enqueues a payload and returns a job id immediately; the
client then uses long-polling and/or the event WebSocket to receive updates.
A fixed pool of workers pulls jobs off the queue and runs the blocking
pipeline in a thread so the event loop stays responsive.  A janitor task drops
finished jobs after ``JOB_TTL_SEC``.
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
    """Owns the job registry, the asyncio queue, worker tasks and job events."""

    def __init__(self, processor: Callable[[dict], dict]) -> None:
        # ``processor`` is the blocking function that turns a payload into a result.
        self._processor = processor
        self._jobs: dict[str, Job] = {}
        self._idempotency: dict[str, str] = {}
        self._conditions: dict[str, asyncio.Condition] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
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
    async def enqueue(self, payload: dict, *, idempotency_key: str | None = None) -> dict[str, Any]:
        """Register a new job and return its public metadata.

        ``idempotency_key`` lets a client retry/reconnect without creating a
        duplicate job.  If a matching job is still tracked, its current status
        is returned with ``dedup=True``.
        """
        self._evict_if_needed()
        idem = (idempotency_key or str(payload.get("idempotency_key") or "")).strip()
        if idem:
            old_id = self._idempotency.get(idem)
            if old_id and old_id in self._jobs:
                out = self.public_record(old_id)
                out["dedup"] = True
                return out

        job_id = str(uuid.uuid4())
        try:
            self._queue.put_nowait((job_id, payload))
        except asyncio.QueueFull as exc:
            raise QueueFull("server busy: translation queue is full") from exc

        rec: Job = {
            "id": job_id,
            "status": "queued",
            "ts": time.time(),
            "updated": time.time(),
        }
        if idem:
            rec["idempotency_key"] = idem
            self._idempotency[idem] = job_id
        self._jobs[job_id] = rec
        await self._publish(job_id)
        return self.public_record(job_id)

    def get(self, job_id: str) -> Job:
        """Return the job record, or an error record if unknown."""
        rec = self._jobs.get(job_id)
        if not rec:
            return {"id": job_id, "status": "error", "result": "job_not_found"}
        return self.public_record(job_id)

    async def wait(self, job_id: str, *, wait_sec: float = 0.0) -> Job:
        """Return a job record, optionally waiting for a state change.

        This powers long-polling: clients can call ``GET /translate/{id}?wait=25``
        and get a response as soon as the job moves to another state or finishes.
        """
        wait_sec = max(0.0, min(float(wait_sec or 0.0), 25.0))
        initial = self._jobs.get(job_id)
        if not initial or wait_sec <= 0:
            return self.get(job_id)
        initial_status = str(initial.get("status") or "")
        if initial_status in ("done", "error"):
            return self.get(job_id)

        cond = self._conditions.setdefault(job_id, asyncio.Condition())
        try:
            async with cond:
                await asyncio.wait_for(
                    cond.wait_for(
                        lambda: str((self._jobs.get(job_id) or {}).get("status") or "") != initial_status
                        or str((self._jobs.get(job_id) or {}).get("status") or "") in ("done", "error")
                    ),
                    timeout=wait_sec,
                )
        except asyncio.TimeoutError:
            pass
        return self.get(job_id)

    def create_event_queue(self) -> asyncio.Queue[dict[str, Any]]:
        """Create a bounded queue used by one WS/SSE client."""
        return asyncio.Queue(maxsize=100)

    def subscribe(self, q: asyncio.Queue[dict[str, Any]], job_id: str) -> None:
        """Subscribe a connection-local queue to updates for one job."""
        jid = str(job_id or "").strip()
        if not jid:
            return
        self._subscribers.setdefault(jid, set()).add(q)

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]], job_id: str) -> None:
        subs = self._subscribers.get(str(job_id or "").strip())
        if subs:
            subs.discard(q)

    def close_event_queue(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        for subs in self._subscribers.values():
            subs.discard(q)

    async def run_inline(self, payload: dict) -> dict:
        """Run a payload to completion without queueing.

        Kept for compatibility with old callers.  The WebSocket route no longer
        uses this for normal jobs because inline WS work bypasses shared
        backpressure and can starve REST users.
        """
        return await asyncio.to_thread(self._processor, payload)

    # --- public metadata helpers ------------------------------------------
    def public_record(self, job_id: str) -> Job:
        rec = dict(self._jobs.get(job_id) or {"id": job_id, "status": "error", "result": "job_not_found"})
        rec.setdefault("id", job_id)
        rec["queue_position"] = self._queue_position(job_id)
        rec["queue_depth"] = self._queue.qsize()
        rec["recommended_client_concurrency"] = self._recommended_client_concurrency()
        rec["poll_after_ms"] = self._poll_after_ms()
        rec["server_time"] = time.time()
        return rec

    def _queue_position(self, job_id: str) -> int | None:
        try:
            queued = list(self._queue._queue)  # noqa: SLF001 - asyncio has no public queue snapshot.
        except Exception:
            return None
        for idx, (jid, _payload) in enumerate(queued, start=1):
            if jid == job_id:
                return idx
        return None

    def _recommended_client_concurrency(self) -> int:
        depth = self._queue.qsize()
        workers = max(1, settings.max_workers)
        if depth >= workers * 4:
            return 1
        if depth >= workers * 2:
            return 2
        return 3

    def _poll_after_ms(self) -> int:
        depth = self._queue.qsize()
        workers = max(1, settings.max_workers)
        if depth >= workers * 4:
            return 2000
        if depth >= workers * 2:
            return 1200
        return 500

    # --- internals ---------------------------------------------------------
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
        for jid, rec in finished[: len(self._jobs) - cap]:
            idem = str(rec.get("idempotency_key") or "")
            if idem:
                self._idempotency.pop(idem, None)
            self._jobs.pop(jid, None)
            self._conditions.pop(jid, None)

    async def _set_job(self, job_id: str, rec: Job) -> None:
        rec["id"] = job_id
        rec["updated"] = time.time()
        self._jobs[job_id] = rec
        await self._publish(job_id)

    async def _publish(self, job_id: str) -> None:
        rec = self.public_record(job_id)
        cond = self._conditions.get(job_id)
        if cond:
            async with cond:
                cond.notify_all()

        msg: dict[str, Any] = {
            "type": "job.status",
            "id": job_id,
            "status": rec.get("status"),
            "queue_position": rec.get("queue_position"),
            "queue_depth": rec.get("queue_depth"),
            "poll_after_ms": rec.get("poll_after_ms"),
            "recommended_client_concurrency": rec.get("recommended_client_concurrency"),
        }
        if rec.get("status") == "done":
            msg = {"type": "result", "id": job_id, "result": rec.get("result")}
        elif rec.get("status") == "error":
            msg = {"type": "error", "id": job_id, "error": rec.get("result") or rec.get("error") or "Unknown error"}

        for q in list(self._subscribers.get(job_id, set())):
            try:
                if q.full():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(msg)
            except Exception:
                self._subscribers.get(job_id, set()).discard(q)

    async def _worker_loop(self, worker_id: int) -> None:
        while True:
            job_id, payload = await self._queue.get()
            t0 = time.perf_counter()
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
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(job_id, {**prev, "status": "running", "ts": time.time()})
                # Per-job wall-clock cap so one slow/stuck job can't pin a worker
                # forever and starve other users.
                result = await asyncio.wait_for(
                    asyncio.to_thread(self._processor, payload),
                    timeout=max(10.0, settings.job_run_timeout_sec),
                )
                await self._set_job(job_id, {**prev, "status": "done", "result": result, "ts": time.time()})
                event(
                    "translate.done",
                    {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1)},
                )
            except asyncio.TimeoutError:
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(
                    job_id,
                    {**prev, "status": "error", "result": "job timed out", "ts": time.time()},
                )
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
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(
                    job_id,
                    {**prev, "status": "error", "result": str(e), "traceback": tb, "ts": time.time()},
                )
            finally:
                self._queue.task_done()

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(60)
            cutoff = time.time() - settings.job_ttl_sec
            dead = [jid for jid, j in self._jobs.items() if float(j.get("ts", 0)) < cutoff]
            for jid in dead:
                rec = self._jobs.pop(jid, None) or {}
                idem = str(rec.get("idempotency_key") or "")
                if idem:
                    self._idempotency.pop(idem, None)
                self._conditions.pop(jid, None)
                self._subscribers.pop(jid, None)
