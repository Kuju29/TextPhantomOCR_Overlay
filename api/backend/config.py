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
    # Default to conservative per-container limits. Scale out with more replicas
    # or override SERVER_MAX_WORKERS/TP_CPU_CONCURRENCY on larger machines.
    # I/O parallelism helps Lens waits, but CPU-heavy ONNX/render stages must
    # stay gated or batches inflate from ~1s to tens of seconds.
    max_workers: int = field(default_factory=lambda: _env_int("SERVER_MAX_WORKERS", 15))
    cpu_concurrency: int = field(default_factory=lambda: max(1, _env_int("TP_CPU_CONCURRENCY", 2)))
    job_ttl_sec: int = field(default_factory=lambda: _env_int("JOB_TTL_SEC", 3600))
    http_timeout_sec: float = field(default_factory=lambda: _env_float("HTTP_TIMEOUT_SEC", 120.0))
    # Multi-user safety: bound the pending queue + per-job wall-clock timeout so
    # a flood of requests can't exhaust memory or pin workers forever.
    max_queue_size: int = field(default_factory=lambda: _env_int("TP_MAX_QUEUE_SIZE", 2000))
    max_jobs_tracked: int = field(default_factory=lambda: _env_int("TP_MAX_JOBS_TRACKED", 5000))
    job_run_timeout_sec: float = field(default_factory=lambda: _env_float("TP_JOB_RUN_TIMEOUT_SEC", 120.0))

    # Split lane concurrency -------------------------------------------------
    # SERVER_MAX_WORKERS is the total processing budget. Lens-direct jobs are
    # network/I/O heavy and can use most workers; lens_text.ai is CPU/provider
    # heavy and gets a smaller lane so it cannot block direct jobs. Set either
    # env var to override the automatic split.
    direct_max_concurrency: int = field(default_factory=lambda: max(0, _env_int("TP_DIRECT_MAX_CONCURRENCY", 0)))
    ai_max_concurrency: int = field(default_factory=lambda: max(0, _env_int("TP_AI_MAX_CONCURRENCY", 0)))

    # Result caches ----------------------------------------------------------
    result_cache_max: int = field(default_factory=lambda: _env_int("TP_RESULT_CACHE_MAX", 512))
    ai_result_cache_max: int = field(default_factory=lambda: _env_int("TP_AI_RESULT_CACHE_MAX", 128))

    # Hugging Face throttling ------------------------------------------------
    hf_max_concurrency: int = field(default_factory=lambda: max(1, _env_int("HF_AI_MAX_CONCURRENCY", 1)))
    hf_min_interval_sec: float = field(default_factory=lambda: max(0.0, _env_float("HF_AI_MIN_INTERVAL_SEC", 0.8)))
    hf_max_retries: int = field(default_factory=lambda: max(1, _env_int("HF_AI_MAX_RETRIES", 3)))
    hf_retry_base_sec: float = field(default_factory=lambda: max(0.2, _env_float("HF_AI_RETRY_BASE_SEC", 2.0)))

    # AI rate gate (proactive per-provider pacing) ---------------------------
    # Instead of firing every AI request at once (which trips a provider's
    # requests-per-minute limit on pages with many images) the gate releases
    # requests in paced batches sized to each provider's RPM. It is keyed by
    # (provider, model, api_key) so every model/key you use gets its own budget,
    # is fair across users sharing one key (round-robin per tab session), and
    # never waits unbounded: a request that cannot get a slot within
    # ``rate_max_wait_sec`` is skipped fast and, past ``rate_max_waiters`` queued
    # per bucket, new requests are rejected immediately so the queue cannot bloat.
    rate_gate_enabled: bool = field(default_factory=lambda: _env_bool("TP_RATE_GATE", True))
    rate_max_wait_sec: float = field(default_factory=lambda: max(1.0, _env_float("TP_RATE_MAX_WAIT_SEC", 75.0)))
    rate_max_waiters_per_bucket: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_MAX_WAITERS", 40)))
    # Fallback policy for providers not listed in RATE_POLICY_DEFAULTS.
    rate_default_rpm: float = field(default_factory=lambda: max(0.0, _env_float("TP_RATE_RPM_DEFAULT", 30.0)))
    rate_default_burst: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_BURST_DEFAULT", 4)))

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
    # Default is 1 because only lens_text.ai uses this model and HF CPU
    # containers slow down badly when several ONNX sessions compete.
    # Override with TP_TEXTBLOCK_POOL_SIZE on dedicated AI workers.
    textblock_pool_size: int = field(
        # Default to one session. Only lens_text.ai needs this model; direct Lens
        # paths must not pay for a multi-session ONNX pool on small HF CPUs.
        default_factory=lambda: max(1, _env_int("TP_TEXTBLOCK_POOL_SIZE", 1))
    )

    # Lens-direct rendering --------------------------------------------------
    # lens_images, lens_text.translated and lens_text.original are Lens-direct:
    # they use Lens geometry/text and must not run the self block detector.
    # Keeping erase/png enabled gives a clean background for text overlays; turn
    # them off only when you want maximum speed and can tolerate overlaying text
    # on the original image.
    lens_direct_erase: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_ERASE", True))
    lens_direct_png: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_PNG", True))

    # AI layout strategy ------------------------------------------------------
    # auto    : run ONNX only when source/target text orientation changes.
    # fast    : never run ONNX for lens_text.ai; patch AI into Lens geometry.
    # quality : always run ONNX/self-block path for lens_text.ai.
    ai_layout_mode: str = field(
        default_factory=lambda: (_env_str("TP_AI_LAYOUT_MODE", "auto") or "auto").lower()
    )

    # Warmup -----------------------------------------------------------------
    warmup_lang: str = field(default_factory=lambda: _env_str("TP_WARMUP_LANG", "th") or "th")
    # Do not load ONNX at boot by default. It is lazy-loaded on the first
    # lens_text.ai request. Set TP_TEXTBLOCK_WARMUP=1 for dedicated AI workers.
    textblock_warmup: bool = field(default_factory=lambda: _env_bool("TP_TEXTBLOCK_WARMUP", False))

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
    build_id: str = field(default_factory=lambda: _env_str("TP_BUILD_ID", "v15-ai-fast-auto-20260617"))


# Module-level singleton.  Import this from anywhere as ``from backend.config import settings``.
# (rate-gate settings added above: rate_gate_enabled / rate_max_wait_sec / ...)
settings: Final[Settings] = Settings()


def reload() -> Settings:
    """Rebuild the settings object (useful inside tests)."""
    global settings  # noqa: PLW0603
    settings = Settings()  # type: ignore[assignment]
    return settings
