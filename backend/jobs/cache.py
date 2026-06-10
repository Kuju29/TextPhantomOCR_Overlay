"""Thread-safe LRU caches for translation results.

Two caches are kept separate because AI results depend on extra inputs
(provider / model / prompt) and tend to be larger and slower to recompute,
so they get their own size budget.
"""

from __future__ import annotations

import copy
import hashlib
from collections import OrderedDict
from threading import Lock
from typing import Any

from backend.ai.translate import AiConfig
from backend.config import settings
from backend.lens.languages import normalize as normalize_lang


class LruCache:
    """A small thread-safe LRU cache that deep-copies values in and out.

    Deep-copying avoids callers accidentally mutating cached trees.
    """

    def __init__(self, max_items: int) -> None:
        self._max = max(0, int(max_items))
        self._store: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = Lock()

    def get(self, key: str) -> dict[str, Any] | None:
        if not key:
            return None
        with self._lock:
            value = self._store.get(key)
            if value is None:
                return None
            self._store.move_to_end(key)
            return copy.deepcopy(value)

    def set(self, key: str, value: dict[str, Any]) -> None:
        if not key or not isinstance(value, dict) or self._max <= 0:
            return
        with self._lock:
            self._store[key] = copy.deepcopy(value)
            self._store.move_to_end(key)
            while len(self._store) > self._max:
                self._store.popitem(last=False)


# Module-level singletons.
result_cache = LruCache(settings.result_cache_max)
ai_result_cache = LruCache(settings.ai_result_cache_max)


def _ai_prompt_signature(prompt: str) -> str:
    """Short stable hash of an editable prompt (for cache keys)."""
    t = (prompt or "").strip()
    return hashlib.sha256(t.encode("utf-8")).hexdigest()[:12] if t else ""


def build_cache_key(
    img_hash: str,
    lang: str,
    mode: str,
    source: str,
    ai_cfg: AiConfig | None,
) -> str:
    """Build a deterministic cache key for one translation request.

    For AI requests the provider / model / base-url / prompt are folded in so
    changing any of them yields a fresh result.
    """
    parts = [img_hash, normalize_lang(lang), (mode or "").strip(), (source or "").strip()]
    if ai_cfg and (source or "").strip().lower() == "ai":
        parts.extend(
            [
                (ai_cfg.provider or "").strip(),
                (ai_cfg.model or "").strip(),
                (ai_cfg.base_url or "").strip(),
                _ai_prompt_signature(ai_cfg.prompt_editable),
            ]
        )
    return "|".join(p for p in parts if p is not None)
