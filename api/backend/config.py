"""Runtime configuration, read once from environment variables (``reload`` re-reads, for tests)."""

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
    # Queued (not yet running) jobs one caller scope may hold.
    max_queue_per_caller: int = field(default_factory=lambda: _env_int("TP_MAX_QUEUE_PER_CALLER", 200))
    # Per caller identity (see api/ingress.py): queued jobs and queued payload
    # bytes. Byte budgets bound memory pinned by queued page images (a data URI
    # can be ~32 MiB); a job count alone cannot.
    max_queue_per_identity: int = field(default_factory=lambda: max(1, _env_int("TP_MAX_QUEUE_PER_IDENTITY", 200)))
    max_queue_bytes: int = field(default_factory=lambda: max(1, _env_int("TP_MAX_QUEUE_BYTES", 512 * 1024 * 1024)))
    max_queue_bytes_per_identity: int = field(
        default_factory=lambda: max(1, _env_int("TP_MAX_QUEUE_BYTES_PER_IDENTITY", 128 * 1024 * 1024)))
    max_jobs_tracked: int = field(default_factory=lambda: _env_int("TP_MAX_JOBS_TRACKED", 5000))
    job_run_timeout_sec: float = field(default_factory=lambda: _env_float("TP_JOB_RUN_TIMEOUT_SEC", 120.0))

    # Synchronous admission. Zero derives the limit from SERVER_MAX_WORKERS.
    sync_max_concurrency: int = field(
        default_factory=lambda: max(0, _env_int("TP_SYNC_MAX_CONCURRENCY", 0))
    )
    # Google Lens shows a latency cliff above ~8 simultaneous uploads, so its
    # fan-out is bounded separately from server workers.
    lens_upstream_max_concurrency: int = field(
        default_factory=lambda: max(1, _env_int("TP_LENS_UPSTREAM_MAX_CONCURRENCY", 8))
    )
    # Provider SDKs use a dedicated executor; admission must not exceed it.
    ai_thread_workers: int = field(
        default_factory=lambda: max(1, _env_int("TP_AI_THREAD_WORKERS", 24))
    )
    # AI Login waits on the user's own browser tab (up to 230 s), so it has its
    # own lane and cannot take the AI slots Paid/Manual users share.
    login_thread_workers: int = field(
        default_factory=lambda: max(1, _env_int("TP_LOGIN_THREAD_WORKERS", 32))
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
    # Detector-free grouping is a separate API stage. Zero follows effective
    # Lens capacity so it never narrows the active Lens lane by default.
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

    # Optional rate gate, isolated by (provider, model, key) with bounded waits.
    rate_gate_enabled: bool = field(default_factory=lambda: _env_bool("TP_RATE_GATE", True))
    rate_max_wait_sec: float = field(default_factory=lambda: max(1.0, _env_float("TP_RATE_MAX_WAIT_SEC", 75.0)))
    rate_max_waiters_per_bucket: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_MAX_WAITERS", 40)))
    # Fallback policy for providers not listed in RATE_POLICY_DEFAULTS.
    rate_default_rpm: float = field(default_factory=lambda: max(0.0, _env_float("TP_RATE_RPM_DEFAULT", 30.0)))
    rate_default_burst: int = field(default_factory=lambda: max(1, _env_int("TP_RATE_BURST_DEFAULT", 4)))

    # Compatibility field only. Requests/CLI must supply their own cloud key.
    # AI_API_KEY is intentionally not read or used as a fallback.
    ai_api_key: str = ""
    # Only the API operator may configure Paid. The browser never supplies a
    # Center endpoint or receives the operator's inference key.
    center_url: str = field(default_factory=lambda: _env_str("TP_CENTER_URL"))
    center_gateway_key_file: str = field(default_factory=lambda: _env_str("TP_CENTER_GATEWAY_KEY_FILE"))
    center_gateway_key: str = field(default_factory=lambda: _env_str("TP_CENTER_GATEWAY_KEY"), repr=False)
    trusted_proxy_ips: str = field(default_factory=lambda: _env_str("TP_TRUSTED_PROXY_IPS"))
    # AI network authority is independent from ownership of the API key.
    # Shared defaults trust provider endpoints + explicit operator allowlist only.
    # Personal mode additionally permits server-owned Local AI on loopback.
    ai_endpoint_policy: str = field(default_factory=lambda: _env_str("TP_AI_ENDPOINT_POLICY", "shared"))
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
    # Comma-separated allowed origins. Empty (default) admits browser-extension
    # origins only (EXTENSION_ORIGIN_REGEX); "*" admits any page WITHOUT
    # credentials. Extension service workers/pages with host permissions do not
    # need CORS at all, but Firefox without granted host access does.
    allowed_origins: str = field(default_factory=lambda: _env_str("TP_ALLOWED_ORIGINS", ""))

    # Lens cookie source -----------------------------------------------------
    # Optional Firebase JSON jar (AEC / NID / __Secure-STRP: Google anti-abuse
    # and signed-out preference cookies, no account-session cookie). There is
    # deliberately NO built-in URL: the public source must not point every
    # deployment at one shared jar. Without FIREBASE_URL the API uses the
    # "direct" source (its own first visit to lens.google.com) only.
    firebase_url: str = field(default_factory=lambda: _env_str("FIREBASE_URL", ""))
    # firebase | direct | auto (firebase, then direct) | direct-first.
    lens_cookie_source: str = field(default_factory=lambda: os.environ.get("TP_LENS_COOKIE_SOURCE", "direct-first"))
    firebase_cookie_ttl_sec: int = field(default_factory=lambda: _env_int("FIREBASE_COOKIE_TTL_SEC", 900))

    # Lens-direct rendering --------------------------------------------------
    # Lens-direct outputs use Lens geometry/text and never run a secondary
    # grouping pass. Erase/PNG give overlays a clean background.
    lens_direct_erase: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_ERASE", True))
    lens_direct_png: bool = field(default_factory=lambda: _env_bool("TP_LENS_DIRECT_PNG", True))

    # Orientation relayout for the Translated layer ---------------------------
    # Rebuild Lens MT boxes at the target orientation when the source runs on
    # the other axis (vertical JA -> horizontal TH); no provider call. Default
    # only: a request's ``layout.relayout_translated`` always wins.
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

# Browser-extension origins (any id): Chromium/Edge/Opera, Firefox/Thunderbird
# per-install UUIDs and Safari. Used as the CORS default when
# TP_ALLOWED_ORIGINS is empty.
EXTENSION_ORIGIN_REGEX: Final[str] = (
    r"^(?:chrome-extension|moz-extension|safari-web-extension)://[A-Za-z0-9._-]{1,128}$"
)

def lens_concurrency_limit(value: "Settings") -> int:
    """Bound local Lens workers by the remote-upstream fan-out ceiling."""
    configured = max(1, int(value.sync_max_concurrency or value.max_workers))
    return max(1, min(configured, int(value.lens_upstream_max_concurrency)))

# Module-level singleton: ``from backend.config import settings``.
settings: Final[Settings] = Settings()

def reload() -> Settings:
    """Rebuild the settings object (useful inside tests)."""
    global settings  # noqa: PLW0603
    settings = Settings()  # type: ignore[assignment]
    return settings
