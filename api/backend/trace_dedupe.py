"""Bounded idempotency memory for browser trace ingestion."""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import threading
import time
from typing import Any


class TraceIngestDedupe:
    def __init__(self, ttl: float = 600, maximum: int = 100_000,
                 clock=time.monotonic) -> None:
        self.ttl, self.maximum, self.clock = ttl, maximum, clock
        self.seen: OrderedDict[str, float] = OrderedDict()
        self.lock = threading.Lock()

    @staticmethod
    def key(session: str, record: dict[str, Any]) -> str:
        side = str(record.get("side") or "ext")
        producer = str(record.get("producerId") or "legacy")
        tab_id = str(record.get("tabId") if record.get("tabId") is not None else "")
        frame_id = str(record.get("frameId") if record.get("frameId") is not None else "")
        trace_id = str(record.get("trace") or "")
        ordinal = record.get("eventId")
        if ordinal in (None, ""):
            ordinal = record.get("n")
        canonical = json.dumps(record, sort_keys=True, ensure_ascii=False,
                               separators=(",", ":"), default=str)
        signature = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        if ordinal in (None, ""):
            ordinal = signature
        # The content signature is intentional: a restarted/buggy producer may
        # reuse an ordinal. Only an exact resend is safe to suppress.
        return (f"{session}\x1f{side}\x1f{producer}\x1f{tab_id}\x1f{frame_id}"
                f"\x1f{trace_id}\x1f{ordinal}\x1f{signature}")

    def filter_new(self, session: str, records: list[Any]) -> tuple[list[dict[str, Any]], int]:
        now = self.clock()
        fresh: list[dict[str, Any]] = []
        duplicates = 0
        with self.lock:
            while self.seen and now - next(iter(self.seen.values())) > self.ttl:
                self.seen.popitem(last=False)
            for record in records:
                if not isinstance(record, dict):
                    continue
                key = self.key(session, record)
                if key in self.seen:
                    duplicates += 1
                    self.seen.move_to_end(key)
                    continue
                self.seen[key] = now
                fresh.append(record)
            while len(self.seen) > self.maximum:
                self.seen.popitem(last=False)
        return fresh, duplicates


def legacy_shipment_id(dropped: int, records: list[Any]) -> str:
    """Stable bounded identity for old clients that send no shipmentId."""
    canonical = json.dumps(
        {"dropped": dropped, "records": records}, sort_keys=True,
        ensure_ascii=False, separators=(",", ":"), default=str,
    )
    return "legacy:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
