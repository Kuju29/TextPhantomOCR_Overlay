"""Centralised runtime configuration loaded from environment variables.

All tunables live here so the rest of the codebase does not call ``os.environ``
directly.  The values are read once on import; callers that need a fresh read
should call :func:`reload` (useful in tests).
"""

from __future__ import annotations

from typing import Final
from dataclasses import dataclass, field

import os

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

def _diagnostics_profile() -> str:
    """Simple diagnostic preset; legacy variables remain authoritative."""
    raw = _env_str("TP_DIAGNOSTICS", "normal").lower()
    aliases = {"0": "normal", "off": "normal", "1": "activity", "summary": "activity", "full": "deep"}
    value = aliases.get(raw, raw)
    return value if value in {"normal", "activity", "deep"} else "normal"

def _access_log_default() -> str:
    explicit = os.environ.get("TP_ACCESS_LOG_MODE")
    if explicit is not None:
        return (explicit or "summary").strip().lower()
    return "summary" if _diagnostics_profile() in {"activity", "deep"} else "errors"

@dataclass(frozen=True)
class Settings:
    # Worker and resource limits.
    max_workers: int = field(default_factory=lambda: _env_int("SERVER_MAX_WORKERS", 15))
    cpu_concurrency: int = field(default_factory=lambda: max(1, _env_int("TP_CPU_CONCURRENCY", 2)))
    job_ttl_sec: int = field(default_factory=lambda: _env_int("JOB_TTL_SEC", 3600))
    http_timeout_sec: float = field(default_factory=lambda: _env_float("HTTP_TIMEOUT_SEC", 120.0))
    # Bound pending work and execution time to protect shared deployments.
    max_queue_size: int = field(default_factory=lambda: _env_int("TP_MAX_QUEUE_SIZE", 2000))
    max_jobs_tracked: int = field(default_factory=lambda: _env_int("TP_MAX_JOBS_TRACKED", 5000))
    job_run_timeout_sec: float = field(default_factory=lambda: _env_float("TP_JOB_RUN_TIMEOUT_SEC", 120.0))

    # Synchronous admission. Zero derives the limit from SERVER_MAX_WORKERS.
    sync_max_concurrency: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_MAX_CONCURRENCY", 0))
    )
    # Provider SDKs use a dedicated executor; admission must not exceed it.
    ai_thread_workers: int = field(
        default_factory=lambda: max(1, _env_int("TP_AI_THREAD_WORKERS", 24))
    )
    sync_ai_max_concurrency: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_AI_MAX_CONCURRENCY", 0))
    )
    sync_max_waiters: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_MAX_WAITERS", 8))
    )
    sync_max_wait_sec: float = field(
        default_factory=lambda: max(0.0, _env_float("TP_SYNC_MAX_WAIT_SEC", 10.0))
    )
    # Keep only a small fair cushion on the API. The browser still owns the
    # large backlog, while runs:API/legacy can wait for a shared AI stage slot
    # without re-running Lens/Grouping merely because another user is active.
    sync_ai_max_waiters: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_AI_MAX_WAITERS", 8))
    )
    sync_ai_max_wait_sec: float = field(
        default_factory=lambda: max(0.0, _env_float("TP_SYNC_AI_MAX_WAIT_SEC", 10.0))
    )
    # Detector-free grouping is a separate API stage. Zero follows Lens
    # capacity so it never narrows the 15-wide Lens highway by default.
    sync_group_max_concurrency: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_GROUP_MAX_CONCURRENCY", 0))
    )
    sync_group_max_waiters: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_GROUP_MAX_WAITERS", 8))
    )
    sync_group_max_wait_sec: float = field(
        default_factory=lambda: max(0.0, _env_float("TP_SYNC_GROUP_MAX_WAIT_SEC", 10.0))
    )

    # Split-lane concurrency for the legacy queued transport only. Stage-level
    # Lens/Grouping/AI gates remain authoritative across every engine.
    direct_max_concurrency: int = field(default_factory=lambda: max(0, _env_int("TP_DIRECT_MAX_CONCURRENCY", 0)))
    ai_max_concurrency: int = field(default_factory=lambda: max(0, _env_int("TP_AI_MAX_CONCURRENCY", 0)))

    # Result caches ----------------------------------------------------------
    result_cache_max: int = field(default_factory=lambda: _env_int("TP_RESULT_CACHE_MAX", 512))
    ai_result_cache_max: int = field(default_factory=lambda: _env_int("TP_AI_RESULT_CACHE_MAX", 128))

    # Hugging Face throttling ------------------------------------------------
    # No TextPhantom-imposed HF account throttle by default. HF's real 429/503
    # is authoritative and the browser learns from it. Operators/users that know
    # a specific account quota can still pin these env vars explicitly.
    hf_max_concurrency: int = field(default_factory=lambda: max(0, _env_int("HF_AI_MAX_CONCURRENCY", 0)))
    hf_min_interval_sec: float = field(default_factory=lambda: max(0.0, _env_float("HF_AI_MIN_INTERVAL_SEC", 0.0)))
    hf_max_retries: int = field(default_factory=lambda: max(1, _env_int("HF_AI_MAX_RETRIES", 3)))
    hf_retry_base_sec: float = field(default_factory=lambda: max(0.2, _env_float("HF_AI_RETRY_BASE_SEC", 2.0)))

    # Optional rate gate, isolated by (provider, model, key) with bounded waits.
    rate_gate_enabled: bool = field(default_factory=lambda: _env_bool("TP_RATE_GATE", True))
    rate_max_wait_sec: float = field(default_factory=lambda: max(1.0, _env_float("TP_RATE_MAX_WAIT_SEC", 75.0)))
    rate_max_waiters_per_bucket: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_MAX_WAITERS", 40)))
    # Fallback policy for providers not listed in RATE_POLICY_DEFAULTS.
    rate_default_rpm: float = field(default_factory=lambda: max(0.0, _env_float("TP_RATE_RPM_DEFAULT", 30.0)))
    rate_default_burst: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_BURST_DEFAULT", 4)))

    # Server keys may be sent only to approved provider hosts.
    ai_api_key: str = field(default_factory=lambda: _env_str("AI_API_KEY"))
    # Comma-separated extra hostnames the SERVER key may be sent to, on top of
    # the built-in PROVIDER_DEFAULTS hosts (e.g. a company AI gateway).
    ai_extra_hosts: str = field(default_factory=lambda: _env_str("TP_AI_EXTRA_HOSTS"))

    # SSRF guard: private, loopback and link-local image hosts are opt-in.
    allow_private_image_hosts: bool = field(
        default_factory=lambda: _env_bool("TP_ALLOW_PRIVATE_IMAGE_HOSTS", False)
    )
    max_image_bytes: int = field(
        default_factory=lambda: max(1, _env_int("TP_MAX_IMAGE_BYTES", 24 * 1024 * 1024))
    )
    max_image_redirects: int = field(
        default_factory=lambda: max(0, _env_int("TP_MAX_IMAGE_REDIRECTS", 4))
    )

    # CORS -------------------------------------------------------------------
    # Comma-separated allowed origins. The extension does not need CORS at all
    # (it fetches under its host permissions), so the safe production value is
    # a concrete list — or "*", which is only honoured WITHOUT credentials.
    allowed_origins: str = field(default_factory=lambda: _env_str("TP_ALLOWED_ORIGINS", "*"))

    # Lens (Firebase cookie source) -----------------------------------------
    # The jar behind this URL holds AEC / NID / __Secure-STRP — Google's
    # anti-abuse and signed-out preference cookies. It carries NONE of the
    # account-session cookies (SID, HSID, SSID, APISID, SAPISID,
    # __Secure-*PSID, LSID), so a reader cannot act as anybody's Google
    # account with it. Publishing it is a quota and abuse question, not an
    # account one, which is why the default is kept.
    #
    # What still matters: everyone using this deployment shares one browser
    # identity with Google, so abuse of it is attributed to all of them
    # together. Point FIREBASE_URL at your own jar to get your own identity.
    firebase_url: str = field(
        default_factory=lambda: _env_str(
            "FIREBASE_URL",
            "https://cookie-6e1cd-default-rtdb.asia-southeast1.firebasedatabase.app/lens/cookie.json",
        )
    )
    firebase_cookie_ttl_sec: int = field(default_factory=lambda: _env_int("FIREBASE_COOKIE_TTL_SEC", 900))

    # Lens-direct rendering --------------------------------------------------
    # lens_images, lens_text.translated and lens_text.original are Lens-direct:
    # they use Lens geometry/text and must not run a secondary text-grouping pass.
    # Keeping erase/png enabled gives a clean background for text overlays; turn
    # them off only when you want maximum speed and can tolerate overlaying text
    # on the original image.
    lens_direct_erase: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_ERASE", True))
    lens_direct_png: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_PNG", True))

    # Orientation relayout for the Translated layer ---------------------------
    # When a page's source text runs on the other axis from the target language
    # (vertical Japanese -> horizontal Thai), Lens's own MT boxes are rebuilt at
    # the target orientation instead of rendering 90°-rotated columns. No
    # provider call is involved, so users without AI quota get readable
    # vertical->horizontal pages too.
    #
    # This is a DEFAULT only. A request may carry ``{"layout":
    # {"relayout_translated": bool}}`` from the extension's toggle, and that
    # always wins — this value applies when the client sends nothing (older
    # builds, curl, the CLI).
    relayout_translated: bool = field(
        default_factory=lambda: _env_bool("TP_RELAYOUT_TRANSLATED", True)
    )

    # Warmup -----------------------------------------------------------------
    warmup_lang: str = field(default_factory=lambda: _env_str("TP_WARMUP_LANG", "th") or "th")
    # Logging / debug --------------------------------------------------------
    diagnostics_profile: str = field(default_factory=_diagnostics_profile)
    debug: bool = field(default_factory=lambda: _env_bool("TP_DEBUG", False))
    # Production default: quiet uvicorn and emit only compact important events,
    # for example one line when a translation job succeeds/fails.
    # Values:
    #   summary/custom/tp/plain = compact app outcome logs
    #   errors/error/err/warn   = FAILURES ONLY — recommended under load. Drops
    #                             ~99% of lines (successes) while keeping every
    #                             line that explains a problem.
    #   off/none                = no app outcome logs at all. This hides errors
    #                             too; prefer "errors" unless you really want
    #                             the server to be silent about failures.
    #   uvicorn                 = restore stock uvicorn access logs
    access_log_mode: str = field(
        default_factory=_access_log_default
    )

# Module-level singleton.  Import this from anywhere as ``from backend.config import settings``.
# (rate-gate settings added above: rate_gate_enabled / rate_max_wait_sec / ...)
settings: Final[Settings] = Settings()

def reload() -> Settings:
    """Rebuild the settings object (useful inside tests)."""
    global settings  # noqa: PLW0603
    settings = Settings()  # type: ignore[assignment]
    return settings
