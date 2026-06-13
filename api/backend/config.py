"""Centralised runtime configuration loaded from environment variables.

All tunables live here so the rest of the codebase does not call ``os.environ``
directly.  The values are read once on import; callers that need a fresh read
should call :func:`reload` (useful in tests).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Final


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_str(name: str, default: str = "") -> str:
    return (os.environ.get(name, default) or "").strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name, "") or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    # Server-side worker pool & limits ---------------------------------------
    # 12 workers overlap the Lens network wait (the bulk of every job, ~2 s),
    # while ``cpu_concurrency`` separately caps the CPU-heavy section
    # (erase / bubble / render / PNG) so concurrent jobs don't pile up on the
    # GIL — measured stage times inflated 3-10x when 14+ jobs ran CPU work
    # at once. I/O parallel, CPU gated: best of both.
    max_workers: int = field(default_factory=lambda: _env_int("SERVER_MAX_WORKERS", 12))
    cpu_concurrency: int = field(default_factory=lambda: max(1, _env_int("TP_CPU_CONCURRENCY", 4)))
    job_ttl_sec: int = field(default_factory=lambda: _env_int("JOB_TTL_SEC", 3600))
    http_timeout_sec: float = field(default_factory=lambda: _env_float("HTTP_TIMEOUT_SEC", 120.0))
    # Multi-user safety: bound the pending queue + per-job wall-clock timeout so
    # a flood of requests can't exhaust memory or pin workers forever.
    max_queue_size: int = field(default_factory=lambda: _env_int("TP_MAX_QUEUE_SIZE", 200))
    max_jobs_tracked: int = field(default_factory=lambda: _env_int("TP_MAX_JOBS_TRACKED", 2000))
    job_run_timeout_sec: float = field(default_factory=lambda: _env_float("TP_JOB_RUN_TIMEOUT_SEC", 180.0))

    # Result caches ----------------------------------------------------------
    result_cache_max: int = field(default_factory=lambda: _env_int("TP_RESULT_CACHE_MAX", 24))
    ai_result_cache_max: int = field(default_factory=lambda: _env_int("TP_AI_RESULT_CACHE_MAX", 16))

    # Hugging Face throttling ------------------------------------------------
    hf_max_concurrency: int = field(default_factory=lambda: max(1, _env_int("HF_AI_MAX_CONCURRENCY", 1)))
    hf_min_interval_sec: float = field(default_factory=lambda: max(0.0, _env_float("HF_AI_MIN_INTERVAL_SEC", 5.0)))
    hf_max_retries: int = field(default_factory=lambda: max(1, _env_int("HF_AI_MAX_RETRIES", 6)))
    hf_retry_base_sec: float = field(default_factory=lambda: max(0.2, _env_float("HF_AI_RETRY_BASE_SEC", 2.0)))

    # AI key fall-back -------------------------------------------------------
    ai_api_key: str = field(default_factory=lambda: _env_str("AI_API_KEY"))

    # Lens (Firebase cookie source) -----------------------------------------
    firebase_url: str = field(
        default_factory=lambda: _env_str(
            "FIREBASE_URL",
            "https://cookie-6e1cd-default-rtdb.asia-southeast1.firebasedatabase.app/lens/cookie.json",
        )
    )
    firebase_cookie_ttl_sec: int = field(default_factory=lambda: _env_int("FIREBASE_COOKIE_TTL_SEC", 900))

    # Manga text-block detector (Kiuyha/Manga-Bubble-YOLO, Apache-2.0) -------
    # Groups vertical CJK columns into text SETS the way a trained model sees
    # them. Optional: when the model file / onnxruntime is absent, grouping
    # falls back to pure geometry. Set TP_TEXTBLOCK_MODEL="" to disable.
    textblock_model_path: str = field(
        default_factory=lambda: _env_str("TP_TEXTBLOCK_MODEL", "models/manga-bubble-yolo.onnx")
    )
    # Repo files live under onnx/: yolo26n.onnx (nano) and yolo26s.onnx
    # (small, mAP50 0.961 vs 0.947).  Default is s; switch via env var.
    textblock_model_url: str = field(
        default_factory=lambda: _env_str(
            "TP_TEXTBLOCK_MODEL_URL",
            "https://huggingface.co/Kiuyha/Manga-Bubble-YOLO/resolve/main/onnx/yolo26s.onnx",
        )
    )
    # How many parallel ONNX sessions to keep ready.
    # IMPORTANT: each session spawns its own thread pool inside ONNX Runtime.
    # On a 2-vCPU machine (HF Space free tier) pool_size=1 is optimal: the
    # single session uses both cores and runs inference in ~1.3 s. With
    # pool_size=4, four sessions compete for 2 cores and each slows to 5-17 s.
    # Rule of thumb: pool_size = max(1, cpu_count // 2).
    # Override with TP_TEXTBLOCK_POOL_SIZE; 0 = auto from os.cpu_count().
    textblock_pool_size: int = field(
        default_factory=lambda: (
            lambda raw, cpus: max(1, min(cpus // 2, 4)) if raw == 0 else max(1, raw)
        )(
            _env_int("TP_TEXTBLOCK_POOL_SIZE", 0),
            __import__("os").cpu_count() or 2,
        )
    )

    # Warmup -----------------------------------------------------------------
    warmup_lang: str = field(default_factory=lambda: _env_str("TP_WARMUP_LANG", "th") or "th")

    # Logging / debug --------------------------------------------------------
    debug: bool = field(default_factory=lambda: _env_bool("TP_DEBUG", False))
    # Production default: quiet uvicorn and emit only compact important events,
    # for example one line when a translation job succeeds/fails.
    # Values:
    #   summary/custom/tp/plain = compact app outcome logs
    #   off/none                = no app outcome logs
    #   uvicorn                 = restore stock uvicorn access logs
    access_log_mode: str = field(
        default_factory=lambda: (_env_str("TP_ACCESS_LOG_MODE", "summary") or "summary").lower()
    )

    # Build metadata ---------------------------------------------------------
    build_id: str = field(default_factory=lambda: _env_str("TP_BUILD_ID", "v10-rewrite-20260514"))


# Module-level singleton.  Import this from anywhere as ``from backend.config import settings``.
settings: Final[Settings] = Settings()


def reload() -> Settings:
    """Rebuild the settings object (useful inside tests)."""
    global settings  # noqa: PLW0603
    settings = Settings()  # type: ignore[assignment]
    return settings
