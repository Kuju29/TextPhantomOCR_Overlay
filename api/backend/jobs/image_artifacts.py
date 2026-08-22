"""Bounded process-local handoff for image bytes between v1 services."""

from __future__ import annotations

import os
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass


TTL_SEC = max(5.0, float(os.environ.get("TP_IMAGE_ARTIFACT_TTL_SEC", "600")))
BYTE_BUDGET = max(1 << 20, int(os.environ.get("TP_IMAGE_ARTIFACT_BYTES", str(64 << 20))))


class ArtifactError(LookupError):
    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code, self.status = code, status


@dataclass(frozen=True)
class _Record:
    data: bytes
    scope: str
    expires: float


class ImageArtifactStore:
    def __init__(self, *, ttl_sec: float = TTL_SEC, byte_budget: int = BYTE_BUDGET,
                 clock=time.monotonic) -> None:
        self.ttl_sec = max(0.01, float(ttl_sec))
        self.byte_budget = max(1, int(byte_budget))
        self._clock = clock
        self._items: OrderedDict[str, _Record] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._counts = {k: 0 for k in (
            "stored", "hit", "miss", "expired", "evicted", "rejected", "wrongScope",
        )}

    @staticmethod
    def _valid(token: str) -> bool:
        return token.startswith("ia_") and 35 <= len(token) <= 80 and token[3:].replace("-", "").replace("_", "").isalnum()

    def _drop(self, token: str, reason: str) -> None:
        rec = self._items.pop(token, None)
        if rec is not None:
            self._bytes -= len(rec.data)
            self._counts[reason] += 1

    def put(self, data: bytes, scope: str) -> tuple[str, float]:
        immutable = bytes(data)
        if not immutable or len(immutable) > self.byte_budget:
            raise ArtifactError("artifact_too_large", "image cannot fit in artifact store", 413)
        now = self._clock()
        token = "ia_" + secrets.token_urlsafe(32)
        with self._lock:
            for key, rec in list(self._items.items()):
                if rec.expires <= now:
                    self._drop(key, "expired")
            # A token returned by /v1/lens/raw is a promise that /v1/groups can
            # resolve it until it expires.  Evicting an unexpired record here
            # broke that promise under large batches: later uploads displaced
            # earlier images and every displaced token produced a noisy 410
            # before the client's supported imageDataUri fallback succeeded.
            #
            # Keep the store bounded without invalidating advertised tokens.
            # The Lens route treats a failed put as an optional-cache miss and
            # omits the token, so the client sends the original bytes directly.
            if self._bytes + len(immutable) > self.byte_budget:
                self._counts["rejected"] += 1
                raise ArtifactError(
                    "artifact_store_full",
                    "image artifact store is full; send the image bytes directly",
                    503,
                )
            self._items[token] = _Record(immutable, str(scope or "anon"), now + self.ttl_sec)
            self._bytes += len(immutable)
            self._counts["stored"] += 1
        return token, self.ttl_sec

    def get(self, token: str, scope: str) -> bytes:
        if not isinstance(token, str) or not self._valid(token):
            raise ArtifactError("artifact_malformed", "image artifact token is malformed", 400)
        now = self._clock()
        with self._lock:
            rec = self._items.get(token)
            if rec is None:
                self._counts["miss"] += 1
                raise ArtifactError("artifact_unavailable", "image artifact expired, was evicted, or belongs to another server process", 410)
            if rec.expires <= now:
                self._drop(token, "expired")
                raise ArtifactError("artifact_expired", "image artifact expired", 410)
            if rec.scope != str(scope or "anon"):
                self._counts["wrongScope"] += 1
                raise ArtifactError("artifact_wrong_scope", "image artifact does not belong to this session", 403)
            self._items.move_to_end(token)
            self._counts["hit"] += 1
            return rec.data

    def stats(self) -> dict:
        with self._lock:
            return {**self._counts, "entries": len(self._items), "bytes": self._bytes,
                    "byteBudget": self.byte_budget, "ttlSec": self.ttl_sec}


image_artifacts = ImageArtifactStore()
