"""Thread-safe LRU caches for translation results.

Two caches are kept separate because AI results depend on extra inputs
(provider / model / prompt) and tend to be larger and slower to recompute,
so they get their own size budget.
"""

from __future__ import annotations

import copy
import hashlib
import json
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


def _ai_context_signature(ai_cfg: AiConfig) -> str:
    """Short stable hash of the FROZEN series context (for cache keys).

    The context is immutable for one read-then-translate batch, so folding its
    hash in keeps the key both correct (new chapter/brief -> new entries) and
    hit-friendly (re-translating within the same batch -> real hits).
    Per-page ``speakers`` / ``prev_context`` are page-local and deterministic
    per (image, batch), so they are included via the same signature.
    """
    payload = json.dumps(
        {
            "state": str(getattr(ai_cfg, "series_state", "") or ""),
            "speakers": getattr(ai_cfg, "speakers", None) or {},
            "prev": getattr(ai_cfg, "prev_context", None) or [],
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


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
                # Vision / character-memory settings produce different results.
                # send_image may be False / True / "always" / "auto".
                f"img_{str(getattr(ai_cfg, 'send_image', False) or 'off').lower()}",
                "memo" if getattr(ai_cfg, "char_memory", True) else "",
                # Thinking mode changes the answer -> separate cache entries.
                f"think_{str(getattr(ai_cfg, 'thinking', '') or 'default').lower()}",
            ]
        )
        # Frozen series context: immutable per batch -> correct AND cacheable.
        if bool(getattr(ai_cfg, "context_frozen", False)):
            parts.append("ctx_" + _ai_context_signature(ai_cfg))
    return "|".join(p for p in parts if p is not None)
