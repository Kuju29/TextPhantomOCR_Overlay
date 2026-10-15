"""Where this API process runs: a shared/public deployment or a private one.

A Hugging Face Space (``SPACE_ID`` / ``SPACE_HOST`` are set by HF) serves every
visitor from one process, so features that are safe for one person's own API
(holding website session cookies, trusting the TCP peer as "the user") are not
safe there. ``TP_PUBLIC_DEPLOYMENT`` overrides the detection either way, so a
self-hosted shared server can opt in and a private Space can opt out.

Read on every call (not cached at import) so tests and operators changing the
environment see the current answer.
"""

from __future__ import annotations

import os

_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")


def env_flag(name: str) -> bool | None:
    """``True``/``False`` when the variable is set to a recognised value, else ``None``."""
    raw = str(os.environ.get(name) or "").strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    return None


def hosted_space() -> bool:
    return bool(os.environ.get("SPACE_ID") or os.environ.get("SPACE_HOST"))


def public_deployment() -> bool:
    """True for a shared API many unrelated people use (default: a HF Space)."""
    explicit = env_flag("TP_PUBLIC_DEPLOYMENT")
    return hosted_space() if explicit is None else explicit
