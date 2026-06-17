"""Async split job queue + worker pools.

``/translate`` enqueues a payload and returns a job id immediately; the
client then uses long-polling to receive updates.  Jobs are split into two
lanes so cheap Lens-direct work is not blocked by the heavy self-block/AI
pipeline:

- direct: ``lens_images``, ``lens_text.original``, ``lens_text.translated``
- ai:     ``lens_text.ai`` (the only lane allowed to use ONNX/self blocks)

The total worker budget is still controlled by ``SERVER_MAX_WORKERS``.  Use
``TP_DIRECT_MAX_CONCURRENCY`` and ``TP_AI_MAX_CONCURRENCY`` to override the
automatic split.
"""

from __future__ import annotations

import asyncio
import time
import traceback
import uuid
from typing import Any, Callable

from backend.config import settings
from backend.log import dbg, event

Job = dict[str, Any]


class QueueFull(Exception):
    """Raised by :meth:`JobQueue.enqueue` when the pending queue is saturated."""


class JobQueue:
    """Owns the job registry, split queues, worker tasks and job events."""

    DIRECT = "direct"
    AI = "ai"

    def __init__(self, processor: Callable[[dict], dict]) -> None:
        self._processor = processor
        self._jobs: dict[str, Job] = {}
        self._idempotency: dict[str, str] = {}
        self._conditions: dict[str, asyncio.Condition] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        qmax = max(1, settings.max_queue_size)
        self._queues: dict[str, asyncio.Queue[tuple[str, dict]]] = {
            self.DIRECT: asyncio.Queue(maxsize=qmax),
            self.AI: asyncio.Queue(maxsize=qmax),
        }
        self._started = False
        self._ai_workers, self._direct_workers = self._worker_split()

    # --- lifecycle ---------------------------------------------------------
    def _worker_split(self) -> tuple[int, int]:
        total = max(1, int(settings.max_workers))
        configured_ai = int(getattr(settings, "ai_max_concurrency", 0) or 0)
        configured_direct = int(getattr(settings, "direct_max_concurrency", 0) or 0)

        if configured_ai > 0:
            ai_workers = max(1, configured_ai)
        else:
            # AI lane uses ONNX/provider calls. Keep it small by default even
            # when SERVER_MAX_WORKERS is large; direct jobs get the rest.
            ai_workers = 1 if total < 6 else 2

        if configured_direct > 0:
            direct_workers = max(1, configured_direct)
        else:
            direct_workers = max(1, total - ai_workers)

        # If the user only set SERVER_MAX_WORKERS, keep the sum within it.  If
        # they explicitly set both lane env vars, still avoid accidental runaway.
        if direct_workers + ai_workers > total:
            overflow = direct_workers + ai_workers - total
            direct_workers = max(1, direct_workers - overflow)
            if direct_workers + ai_workers > total:
                ai_workers = max(1, total - direct_workers)
        return ai_workers, direct_workers

    def start(self) -> None:
        """Spawn direct/AI worker pools + janitor (idempotent)."""
        if self._started:
            return
        self._started = True
        for i in range(self._direct_workers):
            asyncio.create_task(self._worker_loop(i, self.DIRECT))
        for i in range(self._ai_workers):
            asyncio.create_task(self._worker_loop(i, self.AI))
        asyncio.create_task(self._cleanup_loop())
        dbg(
            "jobs.start",
            {
                "workers": settings.max_workers,
                "direct_workers": self._direct_workers,
                "ai_workers": self._ai_workers,
                "max_queue_size": settings.max_queue_size,
            },
        )

    # --- public API --------------------------------------------------------
    def _queue_kind(self, payload: dict | None) -> str:
        payload = payload or {}
        mode = str(payload.get("mode") or "").strip().lower()
        source = str(payload.get("source") or "").strip().lower()
        if mode == "lens_text" and source == "ai":
            return self.AI
        return self.DIRECT

    def _total_depth(self) -> int:
        return sum(q.qsize() for q in self._queues.values())

    async def enqueue(self, payload: dict, *, idempotency_key: str | None = None) -> dict[str, Any]:
        """Register a new job and return its public metadata."""
        self._evict_if_needed()
        idem = (idempotency_key or str(payload.get("idempotency_key") or "")).strip()
        if idem:
            old_id = self._idempotency.get(idem)
            if old_id and old_id in self._jobs:
                out = self.public_record(old_id)
                out["dedup"] = True
                return out

        if self._total_depth() >= max(1, settings.max_queue_size):
            raise QueueFull("server busy: translation queue is full")

        job_id = str(uuid.uuid4())
        kind = self._queue_kind(payload)
        rec: Job = {
            "id": job_id,
            "status": "queued",
            "queue_kind": kind,
            "ts": time.time(),
            "updated": time.time(),
        }
        if idem:
            rec["idempotency_key"] = idem
            self._idempotency[idem] = job_id
        self._jobs[job_id] = rec

        try:
            self._queues[kind].put_nowait((job_id, payload))
        except asyncio.QueueFull as exc:
            self._jobs.pop(job_id, None)
            if idem:
                self._idempotency.pop(idem, None)
            raise QueueFull("server busy: translation queue is full") from exc

        await self._publish(job_id)
        return self.public_record(job_id)

    def get(self, job_id: str) -> Job:
        rec = self._jobs.get(job_id)
        if not rec:
            return {"id": job_id, "status": "error", "result": "job_not_found"}
        return self.public_record(job_id)

    async def wait(self, job_id: str, *, wait_sec: float = 0.0) -> Job:
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
        return asyncio.Queue(maxsize=200)

    def subscribe(self, q: asyncio.Queue[dict[str, Any]], job_id: str) -> None:
        jid = str(job_id or "").strip()
        if jid:
            self._subscribers.setdefault(jid, set()).add(q)

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]], job_id: str) -> None:
        subs = self._subscribers.get(str(job_id or "").strip())
        if subs:
            subs.discard(q)

    def close_event_queue(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        for subs in self._subscribers.values():
            subs.discard(q)

    async def run_inline(self, payload: dict) -> dict:
        return await asyncio.to_thread(self._processor, payload)

    # --- public metadata helpers ------------------------------------------
    def public_record(self, job_id: str) -> Job:
        rec = dict(self._jobs.get(job_id) or {"id": job_id, "status": "error", "result": "job_not_found"})
        rec.setdefault("id", job_id)
        kind = str(rec.get("queue_kind") or self.DIRECT)
        rec["queue_kind"] = kind
        rec["queue_position"] = self._queue_position(job_id, kind)
        rec["queue_depth"] = self._total_depth()
        rec["queue_depth_direct"] = self._queues[self.DIRECT].qsize()
        rec["queue_depth_ai"] = self._queues[self.AI].qsize()
        rec["direct_workers"] = self._direct_workers
        rec["ai_workers"] = self._ai_workers
        # 0 means: client does not need to self-throttle; server-side lanes are
        # already enforcing the processing concurrency.  New extension builds
        # ignore this hint, old builds treat <=0 as no update.
        rec["recommended_client_concurrency"] = 0
        rec["poll_after_ms"] = self._poll_after_ms(kind)
        rec["server_time"] = time.time()
        return rec

    def _queue_position(self, job_id: str, kind: str | None = None) -> int | None:
        kinds = [kind] if kind in self._queues else [self.DIRECT, self.AI]
        for k in kinds:
            try:
                queued = list(self._queues[k]._queue)  # noqa: SLF001 - asyncio has no public queue snapshot.
            except Exception:
                continue
            for idx, (jid, _payload) in enumerate(queued, start=1):
                if jid == job_id:
                    return idx
        return None

    def _poll_after_ms(self, kind: str | None = None) -> int:
        if kind == self.AI:
            depth = self._queues[self.AI].qsize()
            workers = max(1, self._ai_workers)
        else:
            depth = self._queues[self.DIRECT].qsize()
            workers = max(1, self._direct_workers)
        if depth >= workers * 4:
            return 1500
        if depth >= workers * 2:
            return 800
        return 250

    # --- internals ---------------------------------------------------------
    def _evict_if_needed(self) -> None:
        cap = max(100, settings.max_jobs_tracked)
        if len(self._jobs) <= cap:
            return
        finished = [(jid, j) for jid, j in self._jobs.items() if j.get("status") in ("done", "error")]
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
            "queue_kind": rec.get("queue_kind"),
            "queue_position": rec.get("queue_position"),
            "queue_depth": rec.get("queue_depth"),
            "queue_depth_direct": rec.get("queue_depth_direct"),
            "queue_depth_ai": rec.get("queue_depth_ai"),
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

    async def _worker_loop(self, worker_id: int, kind: str) -> None:
        queue = self._queues[kind]
        while True:
            job_id, payload = await queue.get()
            t0 = time.perf_counter()
            enqueue_ts = float((self._jobs.get(job_id) or {}).get("ts") or 0.0)
            queue_wait_ms = round(max(0.0, time.time() - enqueue_ts) * 1000, 1) if enqueue_ts else 0.0
            summary = {
                "job_id": job_id,
                "queue_kind": kind,
                "worker_id": worker_id,
                "mode": str(payload.get("mode") or ""),
                "lang": str(payload.get("lang") or ""),
                "source": str(payload.get("source") or ""),
                "queue_wait_ms": queue_wait_ms,
            }
            try:
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(job_id, {**prev, "status": "running", "ts": time.time(), "queue_kind": kind})
                result = await asyncio.wait_for(
                    asyncio.to_thread(self._processor, payload),
                    timeout=max(10.0, settings.job_run_timeout_sec),
                )
                await self._set_job(job_id, {**prev, "status": "done", "result": result, "ts": time.time(), "queue_kind": kind})
                event("translate.done", {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1)})
            except asyncio.TimeoutError:
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(
                    job_id,
                    {**prev, "status": "error", "result": "job timed out", "ts": time.time(), "queue_kind": kind},
                )
                event(
                    "translate.error",
                    {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1), "error": "job timed out"},
                    ok=False,
                )
            except Exception as e:  # noqa: BLE001
                tb = traceback.format_exc()
                dbg("jobs.error", {"job_id": job_id, "error": str(e), "traceback": tb})
                event(
                    "translate.error",
                    {**summary, "dt_ms": round((time.perf_counter() - t0) * 1000, 1), "error": str(e)[:240]},
                    ok=False,
                )
                prev = dict(self._jobs.get(job_id) or {})
                await self._set_job(
                    job_id,
                    {**prev, "status": "error", "result": str(e), "traceback": tb, "ts": time.time(), "queue_kind": kind},
                )
            finally:
                queue.task_done()

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
