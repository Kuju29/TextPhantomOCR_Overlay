"""Small text helpers shared across modules.

STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
"""

from __future__ import annotations

import re

# Zero-width space — used as a layout token separator by the renderer.
ZWSP = "​"

_WS_RE = re.compile(r"\s+")


def collapse_ws(text: str) -> str:
    """Collapse all runs of whitespace to single spaces and strip the ends."""
    return _WS_RE.sub(" ", str(text or "")).strip()
